import { describe, expect, it } from 'vitest';
import type { ActorId, Link, LinkState, WireMessage } from '@afterlink/protocol';
import { MemoryNetwork, Mesh, VirtualClock, type LinkConnector } from '../src/index.ts';
import { keysFor, openPeers, rig, type Node } from './helpers.ts';

const others = (ids: ActorId[], self: ActorId) => ids.filter((id) => id !== self).sort();

/** Collects test probes only: anti-entropy runs on the same links in the background. */
function inbox(node: Node): WireMessage[] {
  const got: WireMessage[] = [];
  node.mesh.onMessage((_peer, msg) => {
    if (msg.t !== 'summary' || msg.summary.mission.startsWith('probe-')) got.push(msg);
  });
  return got;
}

const ping = (n: number): WireMessage => ({ t: 'summary', summary: { mission: `probe-${n}`, heads: {} } });

describe('forming links', () => {
  it('builds a full mesh through signalling', () => {
    const r = rig();
    r.settle();
    for (const n of r.nodes) expect(openPeers(n)).toEqual(others(r.ids, n.id));
    expect(r.net.paths()).toHaveLength(6);
    r.stop();
  });

  it('forms exactly one link per pair: no duplicate sessions on a clean start', () => {
    const r = rig();
    r.settle();
    for (const n of r.nodes) {
      for (const s of n.mesh.stats()) {
        expect(s.opens).toBe(1);
        expect(s.attempts).toBe(1);
      }
    }
    r.stop();
  });

  it('forms no link without signalling, because a link cannot be negotiated', () => {
    const r = rig({ start: false });
    r.net.killHub();
    for (const n of r.nodes) n.mesh.start();
    r.settle(30_000);
    expect(r.net.paths()).toEqual([]);
    for (const n of r.nodes) expect(n.mesh.signalUp).toBe(false);
    r.stop();
  });

  it('ignores actors outside the roster', () => {
    const clock = new VirtualClock();
    const net = new MemoryNetwork({ clock });
    const a = new Mesh({ self: 'a', peers: ['b'], signal: net.signal('a'), connector: net.connector('a') });
    const stranger = new Mesh({ self: 'z', peers: ['a'], signal: net.signal('z'), connector: net.connector('z') });
    a.start();
    stranger.start();
    clock.advance(10_000);
    expect(net.paths()).toEqual([]);
    a.stop();
    stranger.stop();
  });
});

describe('losing the hub', () => {
  it('keeps every established link and keeps delivering', () => {
    const r = rig();
    r.settle();
    const [a, b] = r.nodes as [Node, Node];
    const got = inbox(b);
    r.net.killHub();
    r.settle(60_000);

    expect(r.net.paths()).toHaveLength(6);
    for (const n of r.nodes) {
      expect(n.mesh.signalUp).toBe(false);
      expect(openPeers(n)).toEqual(others(r.ids, n.id));
      expect(n.mesh.reachable().sort()).toEqual(others(r.ids, n.id));
    }
    expect(a.mesh.send(b.id, ping(1))).toBe(true);
    r.settle(100);
    expect(got).toContainEqual(ping(1));
    r.stop();
  });

  it('never reconnects or renegotiates links when the hub dies and returns', () => {
    const r = rig();
    r.settle();
    r.net.killHub();
    r.settle(10_000);
    r.net.restoreHub();
    r.settle(10_000);
    for (const n of r.nodes) {
      expect(n.mesh.signalUp).toBe(true);
      for (const s of n.mesh.stats()) {
        expect(s.state).toBe('open');
        expect(s.opens).toBe(1);
        expect(s.online).toBe(true);
      }
    }
    r.stop();
  });

  it('carries events between peers with the hub gone', () => {
    const r = rig();
    r.settle();
    r.net.killHub();
    const event = r.nodes[0]!.emit('hub is gone');
    r.settle(500);
    for (const n of r.nodes) expect(n.log.has(event.id)).toBe(true);
    r.stop();
  });

  it('survives replacing the signal client: links stay, hello goes out on the new path', () => {
    const r = rig();
    r.settle();
    r.net.killHub();
    r.settle(1000);
    r.net.restoreHub();
    for (const n of r.nodes) n.mesh.setSignal(r.net.signal(n.id));
    r.settle(1000);
    expect(r.net.hubState()?.rooms.test).toHaveLength(4);
    expect(r.net.paths()).toHaveLength(6);
    for (const n of r.nodes) for (const s of n.mesh.stats()) expect(s.opens).toBe(1);
    r.stop();
  });

  it('does not count a link as open when a peer left the hub: it is the link that decides', () => {
    const r = rig();
    r.settle();
    const [a, b] = r.nodes as [Node, Node];
    const own = r.net.signal(a.id);
    a.mesh.setSignal(own);
    r.settle(100);
    own.close();
    r.settle(5000);
    expect(openPeers(b)).toContain(a.id);
    expect(b.mesh.stats().find((s) => s.peer === a.id)?.online).toBe(false);
    r.stop();
  });
});

describe('fault plans', () => {
  it('severs the real link at both ends and stops the bytes', () => {
    const r = rig();
    r.settle();
    const [a, b] = r.nodes as [Node, Node];
    const got = inbox(b);
    a.mesh.setFaults({ blocked: [b.id] });

    expect(a.mesh.links().find((l) => l.peer === b.id)?.state).toBe('severed');
    expect(a.mesh.send(b.id, ping(1))).toBe(false);
    r.settle(10);
    expect(b.mesh.links().find((l) => l.peer === a.id)?.state).not.toBe('open');
    expect(r.net.paths().some((p) => p.includes(a.id) && p.includes(b.id))).toBe(false);
    r.settle(1000);
    expect(got).toEqual([]);
    r.stop();
  });

  it('refuses reconnection from a blocked peer while signalling is up', () => {
    const r = rig();
    r.settle();
    const [a, b] = r.nodes as [Node, Node];
    a.mesh.setFaults({ blocked: [b.id] });
    r.settle(60_000);
    expect(r.net.hubState()?.rooms.test).toHaveLength(4);
    expect(r.net.paths().some((p) => p.includes(a.id) && p.includes(b.id))).toBe(false);
    expect(a.mesh.links().find((l) => l.peer === b.id)?.state).toBe('severed');
    expect(a.mesh.stats().find((s) => s.peer === b.id)?.blocked).toBe(true);
    r.stop();
  });

  it('leaves links to other peers alone', () => {
    const r = rig();
    r.settle();
    const [a, b, c] = r.nodes as [Node, Node, Node];
    a.mesh.setFaults({ blocked: [b.id] });
    r.settle(1000);
    expect(openPeers(a)).toContain(c.id);
    for (const s of a.mesh.stats()) if (s.peer !== b.id) expect(s.opens).toBe(1);
    r.stop();
  });

  it('re-forms links on unblock with signalling up, within a retry or two', () => {
    const r = rig();
    r.settle();
    const [a, b] = r.nodes as [Node, Node];
    for (const [x, y] of [[a, b], [b, a]] as const) {
      x.mesh.setFaults({ blocked: [y.id] });
      r.settle(30_000);
      x.mesh.setFaults({ blocked: [] });
      r.settle(50);
      expect(openPeers(x)).toContain(y.id);
      expect(openPeers(y)).toContain(x.id);
    }
    r.stop();
  });

  it('re-forms when both ends block and unblock in turn', () => {
    const r = rig();
    r.settle();
    const [a, b] = r.nodes as [Node, Node];
    a.mesh.setFaults({ blocked: [b.id] });
    b.mesh.setFaults({ blocked: [a.id] });
    r.settle(5000);
    a.mesh.setFaults({ blocked: [] });
    r.settle(5000);
    expect(openPeers(a)).not.toContain(b.id);
    b.mesh.setFaults({ blocked: [] });
    r.settle(50);
    expect(openPeers(a)).toContain(b.id);
    expect(openPeers(b)).toContain(a.id);
    r.stop();
  });

  it('cannot re-form after unblock without signalling, and does once signalling returns', () => {
    const r = rig();
    r.settle();
    const [a, b] = r.nodes as [Node, Node];
    a.mesh.setFaults({ blocked: [b.id] });
    r.settle(100);
    r.net.killHub();
    r.settle(100);
    a.mesh.setFaults({ blocked: [] });
    r.settle(30_000);
    expect(openPeers(a)).not.toContain(b.id);
    r.net.restoreHub();
    r.settle(100);
    expect(openPeers(a)).toContain(b.id);
    r.stop();
  });

  it('applies loss to the send path of a real link', () => {
    const r = rig({ size: 2, mesh: { pingMs: 60_000 } });
    r.settle();
    const [a, b] = r.nodes as [Node, Node];
    const got = inbox(b);
    a.mesh.setFaults({ blocked: [], lossRate: 0.5 });
    for (let i = 0; i < 400; i++) a.mesh.send(b.id, ping(i));
    r.settle(100);
    const stats = a.mesh.stats()[0]!;
    expect(got.length + stats.dropped).toBe(400);
    expect(stats.dropped).toBeGreaterThan(140);
    expect(stats.dropped).toBeLessThan(260);
    expect(stats.sent).toBe(got.length + 1);
    r.stop();
  });

  it('applies duplication to the send path', () => {
    const r = rig({ size: 2, mesh: { pingMs: 60_000 } });
    r.settle();
    const [a, b] = r.nodes as [Node, Node];
    const got = inbox(b);
    a.mesh.setFaults({ blocked: [], duplicateRate: 0.5 });
    for (let i = 0; i < 200; i++) a.mesh.send(b.id, ping(i));
    r.settle(100);
    const { duplicated } = a.mesh.stats()[0]!;
    expect(duplicated).toBeGreaterThan(60);
    expect(got.length).toBe(200 + duplicated);
    r.stop();
  });

  it('applies delay, and order is kept without reorder', () => {
    const r = rig({ size: 2, mesh: { pingMs: 60_000 } });
    r.settle();
    const [a, b] = r.nodes as [Node, Node];
    const got = inbox(b);
    a.mesh.setFaults({ blocked: [], delayMs: 400 });
    for (let i = 0; i < 20; i++) a.mesh.send(b.id, ping(i));
    expect(a.mesh.stats()[0]!.held).toBe(20);
    r.settle(300);
    expect(got).toEqual([]);
    r.settle(200);
    expect(got).toEqual(Array.from({ length: 20 }, (_, i) => ping(i)));
    r.stop();
  });

  it('applies reorder', () => {
    const r = rig({ size: 2, mesh: { pingMs: 60_000 } });
    r.settle();
    const [a, b] = r.nodes as [Node, Node];
    const got = inbox(b);
    a.mesh.setFaults({ blocked: [], reorder: true });
    const sent = Array.from({ length: 50 }, (_, i) => ping(i));
    for (const m of sent) a.mesh.send(b.id, m);
    r.settle(200);
    expect(got).toHaveLength(50);
    expect(got).not.toEqual(sent);
    expect(new Set(got.map((m) => JSON.stringify(m))).size).toBe(50);
    r.stop();
  });

  it('discards held messages on severing: closing a link stops bytes already queued', () => {
    const r = rig({ size: 2, mesh: { pingMs: 60_000 } });
    r.settle();
    const [a, b] = r.nodes as [Node, Node];
    const got = inbox(b);
    a.mesh.setFaults({ blocked: [], delayMs: 500 });
    a.mesh.send(b.id, ping(1));
    a.mesh.setFaults({ blocked: [b.id] });
    a.mesh.setFaults({ blocked: [] });
    r.settle(2000);
    expect(got).toEqual([]);
    r.stop();
  });

  it('is deterministic for a seed', () => {
    const run = () => {
      const r = rig({ size: 2, seed: 99, mesh: { pingMs: 60_000 } });
      r.settle();
      const [a, b] = r.nodes as [Node, Node];
      const got = inbox(b);
      a.mesh.setFaults({ blocked: [], lossRate: 0.3, duplicateRate: 0.2, reorder: true });
      for (let i = 0; i < 100; i++) a.mesh.send(b.id, ping(i));
      r.settle(500);
      r.stop();
      return got;
    };
    expect(run()).toEqual(run());
  });
});

describe('MemoryNetwork partition', () => {
  it('stops messages across the cut and keeps them flowing inside each side', () => {
    const r = rig();
    r.settle();
    const [a, b, c, d] = r.nodes as [Node, Node, Node, Node];
    const atC = inbox(c);
    const atB = inbox(b);
    r.net.partition([[a.id, b.id], [c.id, d.id]]);

    expect(r.net.paths()).toHaveLength(2);
    expect(a.mesh.send(c.id, ping(1))).toBe(false);
    expect(a.mesh.send(b.id, ping(2))).toBe(true);
    r.settle(60_000);
    expect(atC).toEqual([]);
    expect(atB).toContainEqual(ping(2));
    expect(r.net.paths()).toHaveLength(2);
    r.stop();
  });

  it('cuts in flight messages', () => {
    const r = rig({ size: 2, mesh: { pingMs: 60_000 } });
    r.settle();
    const [a, b] = r.nodes as [Node, Node];
    const got = inbox(b);
    r.net.setDelay(100);
    a.mesh.send(b.id, ping(1));
    r.net.partition([[a.id], [b.id]]);
    r.settle(1000);
    expect(got).toEqual([]);
    r.stop();
  });

  it('re-forms links after heal', () => {
    const r = rig();
    r.settle();
    const [a, b, c, d] = r.nodes as [Node, Node, Node, Node];
    r.net.partition([[a.id, b.id], [c.id, d.id]]);
    r.settle(60_000);
    r.net.heal();
    r.settle(6000);
    expect(r.net.paths()).toHaveLength(6);
    r.stop();
  });

  it('applies loss to one pair only', () => {
    const r = rig({ mesh: { pingMs: 60_000 } });
    r.settle();
    const [a, b, c] = r.nodes as [Node, Node, Node];
    const atB = inbox(b);
    const atC = inbox(c);
    r.net.setLoss(1, [a.id, b.id]);
    a.mesh.send(b.id, ping(1));
    a.mesh.send(c.id, ping(2));
    r.settle(100);
    expect(atB).toEqual([]);
    expect(atC).toEqual([ping(2)]);
    r.stop();
  });
});

describe('liveness', () => {
  it('measures round trip time and last heard', () => {
    const r = rig({ size: 2 });
    r.settle(5000);
    const info = r.nodes[0]!.mesh.links()[0]!;
    expect(info.rttMs).toBe(2);
    expect(info.lastHeardAt).toBeGreaterThan(1_000_000);
    expect(info.sent).toBeGreaterThan(0);
    expect(info.received).toBeGreaterThan(0);
    r.stop();
  });

  it('replaces a silent link when signalling can negotiate a new one', () => {
    const r = rig({ size: 2 });
    r.settle();
    const [a, b] = r.nodes as [Node, Node];
    r.net.setLoss(1);
    r.settle(9000);
    expect(a.mesh.stats()[0]!.opens + b.mesh.stats()[0]!.opens).toBeGreaterThan(2);
    r.stop();
  });

  it('keeps a silent link when no replacement is possible, but stops calling it reachable', () => {
    const r = rig({ size: 2 });
    r.settle();
    const [a, b] = r.nodes as [Node, Node];
    r.net.killHub();
    r.net.setLoss(1);
    r.settle(30_000);
    expect(a.mesh.links()[0]!.state).toBe('open');
    expect(a.mesh.reachable()).toEqual([]);

    r.net.setLoss(0);
    r.settle(3000);
    expect(a.mesh.reachable()).toEqual([b.id]);
    expect(a.mesh.stats()[0]!.opens).toBe(1);
    r.stop();
  });
});

describe('adopting a link made outside signalling', () => {
  class TestLink implements Link {
    readonly kind = 'memory' as const;
    state: LinkState = 'open';
    sent: WireMessage[] = [];
    closedWith: string | null = null;
    deliver: (msg: WireMessage) => void = () => {};
    private stateFn: (s: LinkState) => void = () => {};
    constructor(readonly peer: ActorId) {}
    send(msg: WireMessage) {
      this.sent.push(msg);
    }
    onMessage(fn: (msg: WireMessage) => void) {
      this.deliver = fn;
    }
    onState(fn: (s: LinkState) => void) {
      this.stateFn = fn;
    }
    close(reason: 'severed' | 'closed') {
      this.closedWith = reason;
      this.state = reason;
      this.stateFn(reason);
    }
  }

  it('serves an adopted link like any other, without signalling', () => {
    const r = rig({ start: false });
    r.net.killHub();
    const [a, b] = r.nodes as [Node, Node];
    a.mesh.start();
    const link = new TestLink(b.id);
    const got = inbox(a);
    const changes: LinkState[] = [];
    a.mesh.onLinkChange((i) => changes.push(i.state));

    expect(a.mesh.adopt(link)).toBe(true);
    expect(openPeers(a)).toEqual([b.id]);
    expect(changes.at(-1)).toBe('open');
    expect(link.sent[0]?.t).toBe('summary');
    link.deliver(ping(1));
    expect(got).toEqual([ping(1)]);
    a.mesh.send(b.id, ping(2));
    expect(link.sent).toContainEqual(ping(2));
    r.stop();
  });

  it('counts one opening per adoption', () => {
    const r = rig({ start: false });
    r.net.killHub();
    const [a, b] = r.nodes as [Node, Node];
    a.mesh.start();
    a.mesh.adopt(new TestLink(b.id));
    expect(a.mesh.stats().find((s) => s.peer === b.id)?.opens).toBe(1);
    r.stop();
  });

  it('opens adopted links with key proofs on both ends', () => {
    const clock = new VirtualClock();
    const [ka, kb] = [keysFor(1), keysFor(2)];
    const a = new Mesh({ self: ka.publicKey, peers: [kb.publicKey], connector: new MemoryNetwork({ clock }).connector(ka.publicKey), secretKey: ka.secretKey });
    const b = new Mesh({ self: kb.publicKey, peers: [ka.publicKey], connector: new MemoryNetwork({ clock }).connector(kb.publicKey), secretKey: kb.secretKey });
    a.start();
    b.start();
    const toB = new TestLink(kb.publicKey);
    const toA = new TestLink(ka.publicKey);
    toB.send = (msg) => clock.setTimeout(() => toA.deliver(msg), 1);
    toA.send = (msg) => clock.setTimeout(() => toB.deliver(msg), 1);
    a.adopt(toB);
    b.adopt(toA);
    clock.advance(100);
    expect(a.reachable()).toEqual([kb.publicKey]);
    expect(b.reachable()).toEqual([ka.publicKey]);
    expect(a.stats()[0]).toMatchObject({ opens: 1, authenticated: true, authFailures: 0 });
    a.stop();
    b.stop();
  });

  it('refuses a blocked or unknown peer and closes the link', () => {
    const r = rig({ start: false });
    const [a, b] = r.nodes as [Node, Node];
    a.mesh.start();
    a.mesh.setFaults({ blocked: [b.id] });
    const blocked = new TestLink(b.id);
    expect(a.mesh.adopt(blocked)).toBe(false);
    expect(blocked.closedWith).toBe('severed');
    const stranger = new TestLink('nobody');
    expect(a.mesh.adopt(stranger)).toBe(false);
    expect(stranger.closedWith).toBe('closed');
    r.stop();
  });

  it('severs an adopted link when its peer is blocked later', () => {
    const r = rig({ start: false });
    r.net.killHub();
    const [a, b] = r.nodes as [Node, Node];
    a.mesh.start();
    const link = new TestLink(b.id);
    a.mesh.adopt(link);
    a.mesh.setFaults({ blocked: [b.id] });
    expect(link.closedWith).toBe('severed');
    r.stop();
  });

  it('passes unknown wire messages through in both directions', () => {
    const r = rig({ start: false });
    r.net.killHub();
    const [a, b] = r.nodes as [Node, Node];
    a.mesh.start();
    const link = new TestLink(b.id);
    a.mesh.adopt(link);
    const got = inbox(a);
    const relay = { t: 'relay', id: 'x', hop: 1, to: '*', data: 'opaque' } as unknown as WireMessage;
    link.deliver(relay);
    a.mesh.send(b.id, relay);
    expect(got).toEqual([relay]);
    expect(link.sent).toContainEqual(relay);
    r.stop();
  });
});

describe('link key proof', () => {
  it('opens links only after both ends prove their keys', () => {
    const r = rig({ auth: true });
    r.settle();
    expect(r.net.paths()).toHaveLength(6);
    for (const n of r.nodes) {
      expect(openPeers(n)).toEqual(others(r.ids, n.id));
      for (const s of n.mesh.stats()) expect(s.authenticated).toBe(true);
    }
    r.stop();
  });

  it('never opens a link to a peer claiming an id it holds no key for', () => {
    const clock = new VirtualClock();
    const net = new MemoryNetwork({ clock });
    const honest = keysFor(1);
    const victim = keysFor(2);
    const impostorKey = keysFor(3);
    const a = new Mesh({
      self: honest.publicKey,
      peers: [victim.publicKey],
      signal: net.signal(honest.publicKey),
      connector: net.connector(honest.publicKey),
      secretKey: honest.secretKey,
    });
    const impostor = new Mesh({
      self: victim.publicKey,
      peers: [honest.publicKey],
      signal: net.signal(victim.publicKey),
      connector: net.connector(victim.publicKey),
      secretKey: impostorKey.secretKey,
    });
    a.start();
    impostor.start();
    clock.advance(5000);

    expect(a.reachable()).toEqual([]);
    expect(a.links()[0]!.state).not.toBe('open');
    expect(a.send(victim.publicKey, ping(1))).toBe(false);
    expect(a.stats()[0]!.authFailures).toBeGreaterThan(0);
    a.stop();
    impostor.stop();
  });

  it('delivers nothing to the application from an unproved peer', () => {
    const clock = new VirtualClock();
    const net = new MemoryNetwork({ clock });
    const honest = keysFor(1);
    const victim = keysFor(2);
    const a = new Mesh({
      self: honest.publicKey,
      peers: [victim.publicKey],
      signal: net.signal(honest.publicKey),
      connector: net.connector(honest.publicKey),
      secretKey: honest.secretKey,
    });
    const silentImpostor = new Mesh({
      self: victim.publicKey,
      peers: [honest.publicKey],
      signal: net.signal(victim.publicKey),
      connector: net.connector(victim.publicKey),
    });
    const got: WireMessage[] = [];
    a.onMessage((_p, m) => got.push(m));
    a.start();
    silentImpostor.start();
    clock.advance(500);
    silentImpostor.send(honest.publicKey, ping(1));
    clock.advance(30_000);
    expect(got).toEqual([]);
    expect(a.reachable()).toEqual([]);
    a.stop();
    silentImpostor.stop();
  });

  it('refuses a proof made over different transport keys, as a relay in the middle would produce', () => {
    const clock = new VirtualClock();
    const net = new MemoryNetwork({ clock });
    const [ka, kb] = [keysFor(1), keysFor(2)];
    const bound = (id: ActorId, binding: string): LinkConnector => {
      const base = net.connector(id);
      return {
        ...base,
        connect: (req) => Object.assign(base.connect(req), { binding: () => binding }),
      };
    };
    const a = new Mesh({
      self: ka.publicKey,
      peers: [kb.publicKey],
      signal: net.signal(ka.publicKey),
      connector: bound(ka.publicKey, 'fingerprints seen by a'),
      secretKey: ka.secretKey,
    });
    const b = new Mesh({
      self: kb.publicKey,
      peers: [ka.publicKey],
      signal: net.signal(kb.publicKey),
      connector: bound(kb.publicKey, 'fingerprints seen by b'),
      secretKey: kb.secretKey,
    });
    a.start();
    b.start();
    clock.advance(5000);
    expect(a.reachable()).toEqual([]);
    expect(b.reachable()).toEqual([]);
    expect(a.stats()[0]!.authFailures + b.stats()[0]!.authFailures).toBeGreaterThan(0);
    a.stop();
    b.stop();
  });

  it('completes the proof over a lossy network by repeating it', () => {
    const r = rig({ auth: true, size: 2 });
    r.net.setLoss(0.5);
    r.settle(60_000);
    expect(r.nodes[0]!.mesh.stats()[0]!.opens).toBeGreaterThan(0);
    r.stop();
  });

  it('proves the key to the hub', () => {
    const r = rig({ auth: true });
    r.settle();
    const state = r.net.hubState()!;
    for (const id of r.ids) expect(state.actors[id]?.proved).toBe(true);
    r.stop();
  });
});

describe('malformed signalling', () => {
  it('ignores junk link signals', () => {
    const clock = new VirtualClock();
    const net = new MemoryNetwork({ clock });
    const a = new Mesh({ self: 'a', peers: ['b'], signal: net.signal('a'), connector: net.connector('a') });
    const b = new Mesh({ self: 'b', peers: ['a'], signal: net.signal('b'), connector: net.connector('b') });
    const rogue = net.signal('b');
    a.start();
    b.start();
    clock.advance(1000);
    for (const data of [null, 5, 'x', {}, { k: 'neg' }, { k: 'dial' }, { k: 'dial', s: 'x'.repeat(500) }, { k: 'nope' }]) {
      rogue.send({ t: 'signal', from: 'b', to: 'a', data });
    }
    clock.advance(1000);
    expect(a.links()[0]!.state).toBe('open');
    a.stop();
    b.stop();
  });
});
