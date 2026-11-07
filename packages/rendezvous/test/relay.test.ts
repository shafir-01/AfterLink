import { afterEach, describe, expect, it, vi } from 'vitest';
import { Author, EventLog, generateKeys, type ActorId, type WireMessage } from '@afterlink/protocol';
import { Mesh, MemoryNetwork, attachSync } from '@afterlink/mesh';
import { RelayedSignal, type RelayMesh, type RelayMessage, type RendezvousDevice } from '../src/index.ts';
import { FakeNetwork } from './fake-rtc.ts';

const mission = 'mission-1';
type Keys = ReturnType<typeof generateKeys>;

interface Node {
  keys: Keys;
  mesh: Mesh;
  log: EventLog;
  author: Author;
  relay: RelayedSignal;
  device: RendezvousDevice;
  stop(): void;
}

const running: Node[] = [];

function sortedKeys(n: number): Keys[] {
  return Array.from({ length: n }, () => generateKeys()).sort((a, b) => (a.publicKey < b.publicKey ? -1 : 1));
}

function cluster(keys: Keys[], wrap?: (mesh: Mesh, keys: Keys) => RelayMesh): { net: MemoryNetwork; rtc: FakeNetwork; nodes: Node[] } {
  const net = new MemoryNetwork({ seed: 3 });
  const rtc = new FakeNetwork();
  const roster = keys.map((k) => ({ actor: k.publicKey }));
  const nodes = keys.map((k) => {
    const mesh = new Mesh({
      self: k.publicKey,
      peers: keys.map((x) => x.publicKey),
      signal: net.signal(k.publicKey),
      connector: net.connector(k.publicKey),
      retryMinMs: 5,
      retryMaxMs: 20,
    });
    const log = new EventLog(mission);
    const sync = attachSync(mesh, log, () => {}, { intervalMs: 30, gossipMs: 5 });
    const device: RendezvousDevice = { keys: k, mission, roster, createConnection: rtc.factory, gatherMs: 20, connectMs: 300 };
    const relay = new RelayedSignal({ device, mesh: wrap ? wrap(mesh, k) : mesh, scanMs: 15, seekMs: 20 });
    const node: Node = {
      keys: k,
      mesh,
      log,
      author: new Author(k, log),
      relay,
      device,
      stop() {
        relay.stop();
        sync.stop();
        mesh.stop();
      },
    };
    running.push(node);
    mesh.start();
    relay.start();
    return node;
  });
  return { net, rtc, nodes };
}

const openPeers = (n: Node) => n.mesh.stats().filter((s) => s.state === 'open').map((s) => s.peer);

async function fullyLinked(nodes: Node[]) {
  await vi.waitFor(() => {
    for (const n of nodes) expect(openPeers(n)).toHaveLength(nodes.length - 1);
  });
}

/** Cuts one pair with the hub gone, leaving nothing that could rebuild the link except the relay. */
function cut(a: Node, b: Node) {
  a.mesh.setFaults({ blocked: [b.keys.publicKey] });
  b.mesh.setFaults({ blocked: [a.keys.publicKey] });
  a.mesh.setFaults({ blocked: [] });
  b.mesh.setFaults({ blocked: [] });
}

afterEach(() => {
  for (const n of running.splice(0)) n.stop();
});

describe('peer-relayed signalling', () => {
  it('rebuilds a lost link through a shared third peer with the hub dead, and anti-entropy runs on it', async () => {
    const { net, rtc, nodes } = cluster(sortedKeys(3));
    const [a, b, c] = nodes as [Node, Node, Node];
    await fullyLinked(nodes);
    expect(rtc.created).toBe(0);

    net.killHub();
    await vi.waitFor(() => expect(a.mesh.signalUp).toBe(false));
    const before = c.mesh.stats().find((s) => s.peer === a.keys.publicKey)!.opens;
    cut(a, b);

    await fullyLinked(nodes);
    expect(rtc.created).toBe(2);
    expect(c.mesh.stats().find((s) => s.peer === a.keys.publicKey)!.opens).toBe(before);
    expect(a.mesh.stats().find((s) => s.peer === b.keys.publicKey)!.opens).toBe(2);
    expect(net.paths()).toHaveLength(2);

    c.mesh.setFaults({ blocked: [a.keys.publicKey, b.keys.publicKey] });
    const event = a.author.emit('observation.recorded', {
      observation: { key: 'gate.north.open', value: true, subject: 'gate', observedAt: 1, validForMs: 0, source: a.keys.publicKey },
    });
    await vi.waitFor(() => expect(b.log.has(event.id)).toBe(true));
  });

  it('heals across two relays when no single peer touches both ends', async () => {
    const { net, nodes } = cluster(sortedKeys(4));
    const [a, b, c, d] = nodes as [Node, Node, Node, Node];
    await fullyLinked(nodes);
    net.killHub();
    await vi.waitFor(() => expect(a.mesh.signalUp).toBe(false));
    a.relay.stop();
    b.relay.stop();
    c.relay.stop();
    d.relay.stop();
    cut(a, d);
    cut(a, c);
    cut(b, d);
    for (const n of nodes) n.relay.start();
    await fullyLinked(nodes);
  });

  it('stays idle while the hub is up, and never heals a peer the fault plan blocks', async () => {
    const { net, rtc, nodes } = cluster(sortedKeys(3));
    const [a, b] = nodes as [Node, Node, Node];
    await fullyLinked(nodes);
    a.mesh.setFaults({ blocked: [b.keys.publicKey] });
    b.mesh.setFaults({ blocked: [a.keys.publicKey] });
    await new Promise((r) => setTimeout(r, 80));
    expect(rtc.created).toBe(0);

    net.killHub();
    await new Promise((r) => setTimeout(r, 120));
    expect(rtc.created).toBe(0);
    expect(openPeers(a)).not.toContain(b.keys.publicKey);
  });

  it('a relay in the middle cannot alter what it carries', async () => {
    const results: boolean[] = [];
    const keys = sortedKeys(3);
    const middle = keys[2]!.publicKey;
    const wrap = (mesh: Mesh, k: Keys): RelayMesh =>
      k.publicKey !== middle
        ? mesh
        : {
            get signalUp() {
              return mesh.signalUp;
            },
            stats: () => mesh.stats(),
            onMessage: (fn) => mesh.onMessage(fn),
            onLinkChange: (fn) => mesh.onLinkChange(fn),
            adopt: (l) => mesh.adopt(l),
            send(peer: ActorId, msg: WireMessage) {
              const m = msg as unknown as RelayMessage;
              if (m.t !== 'relay' || !m.data) return mesh.send(peer, msg);
              const flipped = m.data.slice(0, 80) + (m.data[80] === 'A' ? 'B' : 'A') + m.data.slice(81);
              return mesh.send(peer, { ...m, data: flipped } as unknown as WireMessage);
            },
          };
    const { net, rtc, nodes } = cluster(keys, wrap);
    const [a, b] = nodes as [Node, Node, Node];
    await fullyLinked(nodes);
    net.killHub();
    await vi.waitFor(() => expect(a.mesh.signalUp).toBe(false));
    b.relay.stop();
    const healing = new RelayedSignal({ device: b.device, mesh: b.mesh, scanMs: 15, seekMs: 20, onResult: (_, r) => results.push(r.ok) });
    healing.start();
    cut(a, b);
    await vi.waitFor(() => expect(results.length).toBeGreaterThan(0));
    healing.stop();
    expect(results.every((ok) => !ok)).toBe(true);
    expect(openPeers(a)).not.toContain(b.keys.publicKey);
    expect(rtc.created).toBeGreaterThan(0);
  });

  it('ignores relay traffic that claims to come from outside the roster', async () => {
    const { net, rtc, nodes } = cluster(sortedKeys(2));
    const [a, b] = nodes as [Node, Node];
    await fullyLinked(nodes);
    net.killHub();
    await vi.waitFor(() => expect(a.mesh.signalUp).toBe(false));
    const stranger = generateKeys().publicKey;
    a.mesh.send(b.keys.publicKey, { t: 'relay', id: 'x', hop: 0, from: stranger, to: b.keys.publicKey } as unknown as WireMessage);
    await new Promise((r) => setTimeout(r, 40));
    expect(rtc.created).toBe(0);
  });

  it('drops a message past its hop limit and sees each message once', async () => {
    const { net, nodes } = cluster(sortedKeys(3));
    const [a, b, c] = nodes as [Node, Node, Node];
    await fullyLinked(nodes);
    net.killHub();
    await vi.waitFor(() => expect(a.mesh.signalUp).toBe(false));
    const seen: unknown[] = [];
    b.mesh.onMessage((_, m) => seen.push(m));
    const lost = generateKeys().publicKey;
    const hot = { t: 'relay', id: 'over', hop: 3, from: a.keys.publicKey, to: lost };
    a.mesh.send(c.keys.publicKey, hot as unknown as WireMessage);
    const cool = { t: 'relay', id: 'under', hop: 0, from: a.keys.publicKey, to: lost };
    a.mesh.send(c.keys.publicKey, cool as unknown as WireMessage);
    a.mesh.send(c.keys.publicKey, cool as unknown as WireMessage);
    await new Promise((r) => setTimeout(r, 40));
    expect(seen.filter((m) => (m as RelayMessage).id === 'over')).toHaveLength(0);
    expect(seen.filter((m) => (m as RelayMessage).id === 'under')).toHaveLength(1);
  });
});
