import { describe, expect, it } from 'vitest';
import { Author, EventLog, type AnyEvent, type TaskSpec, type WireMessage } from '@afterlink/protocol';
import { attachSync, eventRank, prioritise } from '../src/index.ts';
import { expectConverged, keysFor, MISSION, openPeers, rig, tally, type Node } from './helpers.ts';

const spec = (id: string, priority: 1 | 2 | 3): TaskSpec => ({
  id,
  kind: 'carry',
  title: id,
  brief: id,
  objective: 'o',
  priority,
  location: { x: 0, y: 0 },
  locationName: 'gate',
  requires: [],
  needs: [],
  dependsOn: [],
  reversible: true,
});

const pad = (n: number) => 'x'.repeat(n);

describe('convergence', () => {
  it('pushes a local event to every peer in one hop', () => {
    const r = rig();
    r.settle();
    const event = r.nodes[0]!.emit('hello');
    r.settle(5);
    for (const n of r.nodes) expect(n.log.has(event.id)).toBe(true);
    r.stop();
  });

  it('tells the application once per event', () => {
    const r = rig();
    r.settle();
    r.nodes[0]!.emit('once');
    r.settle(10_000);
    for (const n of r.nodes.slice(1)) expect(n.received).toHaveLength(1);
    r.stop();
  });

  it('exchanges history when a link opens', () => {
    const r = rig({ start: false });
    for (let i = 0; i < 5; i++) for (const n of r.nodes) n.emit(`before ${i}`);
    for (const n of r.nodes) n.mesh.start();
    r.settle(1000);
    expect(r.nodes[0]!.log.size).toBe(20);
    expect(expectConverged(r.nodes)).toBe(true);
    r.stop();
  });

  it('heals a partition: both sides keep working and converge to one history', () => {
    const r = rig();
    r.settle();
    const [a, b, c, d] = r.nodes as [Node, Node, Node, Node];
    r.net.partition([[a.id, b.id], [c.id, d.id]]);
    a.emit('left 1');
    d.emit('right 1');
    r.settle(5000);
    expect(b.log.size).toBe(1);
    expect(c.log.size).toBe(1);
    expect(a.log.all()[0]!.id).not.toBe(d.log.all()[0]!.id);

    b.emit('left 2');
    c.emit('right 2');
    r.settle(5000);
    r.net.heal();
    r.settle(8000);
    expect(a.log.size).toBe(4);
    expect(expectConverged(r.nodes)).toBe(true);
    r.stop();
  });

  it('carries events across a line of peers that do not touch', () => {
    const r = rig({ size: 3 });
    r.settle();
    const [a, b, c] = r.nodes as [Node, Node, Node];
    a.mesh.setFaults({ blocked: [c.id] });
    c.mesh.setFaults({ blocked: [a.id] });
    r.settle(100);
    const event = a.emit('over the bridge');
    r.settle(1000);
    expect(b.log.has(event.id)).toBe(true);
    expect(c.log.has(event.id)).toBe(true);
    r.stop();
  });

  it('never carries events over a severed pair when no path exists', () => {
    const r = rig({ size: 2 });
    r.settle();
    const [a, b] = r.nodes as [Node, Node];
    a.mesh.setFaults({ blocked: [b.id] });
    b.mesh.setFaults({ blocked: [a.id] });
    r.settle(100);
    const event = a.emit('stuck on this side');
    r.settle(60_000);
    expect(b.log.has(event.id)).toBe(false);
    a.mesh.setFaults({ blocked: [] });
    b.mesh.setFaults({ blocked: [] });
    r.settle(5000);
    expect(b.log.has(event.id)).toBe(true);
    r.stop();
  });

  it('keeps converging after the hub dies, then again after links are rebuilt', () => {
    const r = rig();
    r.settle();
    r.net.killHub();
    r.nodes[1]!.emit('blind');
    r.settle(500);
    expect(expectConverged(r.nodes)).toBe(true);
    r.net.restoreHub();
    r.settle(500);
    r.nodes[2]!.emit('watched');
    r.settle(500);
    expect(r.nodes[0]!.log.size).toBe(2);
    expect(expectConverged(r.nodes)).toBe(true);
    r.stop();
  });
});

describe('hostile delivery', () => {
  const scenarios = [
    { name: 'duplicates', plan: { duplicateRate: 0.6 } },
    { name: 'reorder', plan: { reorder: true } },
    { name: 'delay', plan: { delayMs: 120 } },
    { name: 'loss', plan: { lossRate: 0.3 } },
    { name: 'everything', plan: { lossRate: 0.2, duplicateRate: 0.3, delayMs: 30, reorder: true } },
  ];

  for (const { name, plan } of scenarios) {
    it(`converges under ${name}, on several seeds`, () => {
      for (const seed of [1, 2, 3, 4, 5]) {
        const r = rig({ seed });
        r.settle();
        for (const n of r.nodes) n.mesh.setFaults({ blocked: [], ...plan });
        for (let i = 0; i < 40; i++) {
          r.nodes[i % 4]!.emit(`event ${i}`);
          r.settle(37);
        }
        r.settle(40_000);
        for (const n of r.nodes) n.mesh.setFaults({ blocked: [] });
        r.settle(8000);
        expect(r.nodes[0]!.log.size).toBe(40);
        expect(expectConverged(r.nodes)).toBe(true);
        for (const n of r.nodes) expect(n.log.pending).toBe(0);
        r.stop();
      }
    });
  }

  it('reports each new event once even when every message is doubled', () => {
    const r = rig({ size: 2 });
    r.settle();
    const [a, b] = r.nodes as [Node, Node];
    a.mesh.setFaults({ blocked: [], duplicateRate: 1 });
    for (let i = 0; i < 20; i++) a.emit(`e${i}`);
    r.settle(5000);
    expect(b.received).toHaveLength(20);
    expect(new Set(b.received.map((e) => e.id)).size).toBe(20);
    expect(b.sync.stats().duplicatesReceived).toBeGreaterThan(0);
    r.stop();
  });

  it('survives junk from a peer without losing the link', () => {
    const r = rig({ size: 2 });
    r.settle();
    const [a, b] = r.nodes as [Node, Node];
    const junk = [
      { t: 'summary', summary: null },
      { t: 'summary', summary: { mission: MISSION, heads: 5 } },
      { t: 'summary', summary: { mission: MISSION, heads: { x: null, y: { seq: 'a' } } } },
      { t: 'summary', summary: { mission: MISSION, heads: { x: { seq: 1, id: 'i' } }, branches: { x: 3 } } },
      { t: 'summary', summary: { mission: 'other', heads: {} } },
      { t: 'events', events: 'nope', final: true },
      { t: 'events', events: [null, 5, {}], final: false },
      { t: 'unknown' },
    ] as unknown as WireMessage[];
    for (const m of junk) a.mesh.send(b.id, m);
    r.settle(1000);
    expect(openPeers(b)).toEqual([a.id]);
    const event = a.emit('still fine');
    r.settle(1000);
    expect(b.log.has(event.id)).toBe(true);
    r.stop();
  });

  it('refuses an oversized batch outright', () => {
    const r = rig({ size: 2 });
    r.settle();
    const [a, b] = r.nodes as [Node, Node];
    const events = Array.from({ length: 2000 }, () => ({})) as unknown as AnyEvent[];
    a.mesh.send(b.id, { t: 'events', events, final: true });
    r.settle(100);
    expect(b.sync.stats().batchesRefused).toBe(1);
    r.stop();
  });
});

describe('bounded exchange', () => {
  const big = (r: ReturnType<typeof rig>, node: Node, count: number) => {
    for (let i = 0; i < count; i++) {
      node.author.emit('task.released', { taskId: 'task', reason: `${i} ${pad(300)}` }, r.clock.now());
    }
  };

  it('never exceeds the batch bounds', () => {
    const r = rig({ size: 2, start: false, sync: { maxBatchEvents: 10 } });
    const [a, b] = r.nodes as [Node, Node];
    big(r, a, 95);
    const sizes: number[] = [];
    b.mesh.onMessage((_p, m) => {
      if (m.t === 'events') sizes.push(m.events.length);
    });
    for (const n of r.nodes) n.mesh.start();
    r.settle(2000);
    expect(b.log.size).toBe(95);
    expect(Math.max(...sizes)).toBe(10);
    expect(sizes).toHaveLength(10);
    r.stop();
  });

  it('keeps each default batch inside one frame', () => {
    const r = rig({ size: 2, start: false });
    const [a, b] = r.nodes as [Node, Node];
    big(r, a, 200);
    const bytes: number[] = [];
    b.mesh.onMessage((_p, m) => {
      if (m.t === 'events') bytes.push(JSON.stringify(m).length);
    });
    for (const n of r.nodes) n.mesh.start();
    r.settle(3000);
    expect(b.log.size).toBe(200);
    expect(Math.max(...bytes)).toBeLessThan(16 * 1024);
    r.stop();
  });

  it('sends one batch at a time: the next waits for the answer to the last', () => {
    const r = rig({ size: 2, start: false, sync: { maxBatchEvents: 10 } });
    const [a, b] = r.nodes as [Node, Node];
    big(r, a, 50);
    for (const n of r.nodes) n.mesh.start();
    r.net.setDelay(100);
    r.settle(90);
    const early = a.sync.stats().batchesSent;
    r.settle(310);
    expect(a.sync.stats().batchesSent).toBeLessThanOrEqual(early + 2);
    r.settle(5000);
    expect(b.log.size).toBe(50);
    r.stop();
  });

  it('sends each event about once on reconnect, however many peers hold it', () => {
    const r = rig({ sync: { maxBatchEvents: 16 } });
    r.settle();
    const [a, b, c, d] = r.nodes as [Node, Node, Node, Node];
    r.net.partition([[a.id, b.id, c.id], [d.id]]);
    r.settle(2000);
    for (let i = 0; i < 300; i++) a.emit(`while apart ${i}`);
    r.settle(5000);
    const counts = tally(r.nodes);
    r.net.heal();
    r.settle(20_000);
    expect(d.log.size).toBe(300);
    expect(expectConverged(r.nodes)).toBe(true);
    expect(counts.eventsCarried!).toBeLessThan(300 * 1.6);
    r.stop();
  });

  it('stays quiet once in sync: only the periodic summaries remain', () => {
    const r = rig();
    r.settle();
    for (const n of r.nodes) n.emit('one each');
    r.settle(5000);
    const counts = tally(r.nodes);
    r.settle(30_000);
    expect(counts.events ?? 0).toBe(0);
    expect(counts.summary).toBeLessThanOrEqual(4 * 3 * 11);
    r.stop();
  });

  it('holds traffic flat across repeated partition cycles', () => {
    const r = rig();
    r.settle();
    const [a, b, c, d] = r.nodes as [Node, Node, Node, Node];
    const counts = tally(r.nodes);
    const carried: number[] = [];
    for (let cycle = 0; cycle < 6; cycle++) {
      const before = counts.eventsCarried ?? 0;
      r.net.partition([[a.id, b.id], [c.id, d.id]]);
      for (let i = 0; i < 10; i++) {
        a.emit(`a ${cycle}.${i}`);
        d.emit(`d ${cycle}.${i}`);
      }
      r.settle(3000);
      r.net.heal();
      r.settle(12_000);
      expect(expectConverged(r.nodes)).toBe(true);
      carried.push((counts.eventsCarried ?? 0) - before);
    }
    expect(r.nodes[0]!.log.size).toBe(120);
    expect(Math.max(...carried)).toBeLessThanOrEqual(Math.min(...carried) * 1.5);
    r.stop();
  });

  it('backs off from a peer that never shows what it was sent', () => {
    const r = rig({ size: 2 });
    r.settle();
    const [a, b] = r.nodes as [Node, Node];
    b.sync.stop();
    const deaf = new EventLog(MISSION);
    const stubborn = attachSync(
      b.mesh,
      {
        summary: () => deaf.summary(),
        missingFor: () => [],
        has: () => true,
        all: () => [],
        ingestMany: () => ({ added: [], duplicates: 1, gaps: 0, invalid: [], forks: [] }),
      },
      () => {},
    );
    for (let i = 0; i < 5; i++) a.emit(`unheard ${i}`);
    r.settle(5000);
    const before = a.sync.stats().batchesSent;
    r.settle(300_000);
    expect(a.sync.stats().batchesSent - before).toBeLessThan(15);
    expect(a.sync.stats().batchesSent).toBeGreaterThan(before);
    stubborn.stop();
    r.stop();
  });

  it('repairs a lost batch without waiting for a full pass of a long history', () => {
    const r = rig({ size: 2, start: false, sync: { maxBatchEvents: 10 } });
    const [a, b] = r.nodes as [Node, Node];
    for (let i = 0; i < 40; i++) a.author.emit('task.released', { taskId: 't', reason: `e ${i}` }, 0);
    for (const n of r.nodes) n.mesh.start();
    a.mesh.setFaults({ blocked: [], lossRate: 0.3 });
    r.settle(30_000);
    a.mesh.setFaults({ blocked: [] });
    r.settle(8000);
    expect(b.log.size).toBe(40);
    expect(b.log.pending).toBe(0);
    r.stop();
  });

  it('never asks faster than the gap while a peer cannot supply what it names', () => {
    const r = rig({ size: 2 });
    r.settle();
    const [a, b] = r.nodes as [Node, Node];
    const counts = tally([a]);
    for (let i = 0; i < 200; i++) {
      b.mesh.send(a.id, { t: 'summary', summary: { mission: MISSION, heads: { ghost: { seq: 9, id: `ghost${i}` } } } });
      r.clock.advance(1);
    }
    expect(a.sync.stats().summariesSent).toBeLessThan(5);
    expect(counts.summary).toBeGreaterThan(100);
    r.stop();
  });
});

describe('priority', () => {
  it('sends urgent work before routine work, each behind what it depends on', () => {
    const log = new EventLog(MISSION);
    const author = new Author(keysFor(0), log);
    author.emit('observation.recorded', {
      observation: { key: 'k', value: 1, subject: 's', observedAt: 0, validForMs: 0, source: keysFor(0).publicKey },
    });
    author.emit('task.created', { spec: spec('low', 3), source: { kind: 'human' } });
    author.emit('task.created', { spec: spec('urgent', 1), source: { kind: 'human' } });
    const other = new EventLog(MISSION);
    const otherAuthor = new Author(keysFor(1), other);
    const noise = otherAuthor.emit('link.changed', { peer: 'p', state: 'open', transport: 'memory' });
    const right = otherAuthor.emit('right.committed', { tokens: ['t#1'], taskId: 'urgent' });
    log.ingestMany([noise, right] as unknown as AnyEvent[]);

    const delta = log.missingFor({ mission: MISSION, heads: {} });
    const ordered = prioritise(delta, (e) => eventRank(e, () => 2));
    const types = ordered.map((e) => e.type);

    expect(new Set(ordered.map((e) => e.id)).size).toBe(delta.length);
    expect(types.indexOf('link.changed')).toBeLessThan(types.indexOf('right.committed'));
    expect(types.indexOf('right.committed')).toBeLessThan(types.indexOf('observation.recorded'));

    const seen = new Set<string>();
    for (const e of ordered) {
      for (const dep of [e.prev, ...e.parents]) if (dep) expect(seen.has(dep)).toBe(true);
      seen.add(e.id);
    }
  });

  it('delivers a high priority event in the first batch when its chain allows', () => {
    const r = rig({ size: 2, start: false, sync: { maxBatchEvents: 8 } });
    const [a, b] = r.nodes as [Node, Node];
    const c = rig({ size: 3, start: false }).nodes[2]!;
    for (let i = 0; i < 40; i++) {
      c.author.emit('observation.recorded', {
        observation: { key: `k${i}`, value: i, subject: 's', observedAt: 0, validForMs: 0, source: c.id },
      });
    }
    const urgent = a.author.emit('right.committed', { tokens: ['chair#1'], taskId: 't' }) as unknown as AnyEvent;
    a.log.ingestMany(c.log.all());
    const firstBatch: string[][] = [];
    b.mesh.onMessage((_p, m) => {
      if (m.t === 'events') firstBatch.push(m.events.map((e) => e.id));
    });
    for (const n of r.nodes) n.mesh.start();
    r.settle(2000);
    expect(b.log.size).toBe(41);
    expect(firstBatch[0]).toContain(urgent.id);
    r.stop();
  });

  it('survives a cycle in junk dependencies', () => {
    const e = (id: string, prev: string | null, parents: string[]) => ({ id, prev, parents, type: 'link.changed' }) as unknown as AnyEvent;
    const ordered = prioritise([e('a', 'b', []), e('b', 'a', [])], () => 0);
    expect(ordered).toHaveLength(2);
  });
});

describe('forks are compared by event id', () => {
  /** Two replicas of one key that signed different successors. */
  function forked(branchLength: number) {
    const r = rig({ size: 2, start: false });
    const [a, b] = r.nodes as [Node, Node];
    const shared = a.author;
    for (let i = 0; i < 6; i++) shared.emit('task.released', { taskId: 't', reason: `shared ${i}` }, 0);
    b.log.ingestMany(a.log.all());
    const twin = new Author(a.keys, b.log);
    a.author.emit('task.released', { taskId: 't', reason: '7a' }, 0);
    for (let i = 0; i < branchLength; i++) twin.emit('task.released', { taskId: 't', reason: `7b ${i}` }, 0);
    return { r, a, b };
  }

  it('merges two branches of equal length, which a sequence comparison calls in sync', () => {
    const { r, a, b } = forked(1);
    expect(a.log.summary().heads[a.id]!.seq).toBe(b.log.summary().heads[a.id]!.seq);
    expect(a.log.summary().heads[a.id]!.id).not.toBe(b.log.summary().heads[a.id]!.id);
    for (const n of r.nodes) n.mesh.start();
    r.settle(5000);
    expect(a.log.size).toBe(8);
    expect(expectConverged(r.nodes)).toBe(true);
    expect(a.log.forks()).toHaveLength(1);
    expect(b.log.forks()).toHaveLength(1);
    r.stop();
  });

  it('merges a short branch with a long one', () => {
    const { r, a, b } = forked(3);
    for (const n of r.nodes) n.mesh.start();
    r.settle(5000);
    expect(a.log.size).toBe(10);
    expect(expectConverged(r.nodes)).toBe(true);
    expect(a.log.forks().map((f) => f.seq)).toEqual([7]);
    expect(b.log.forks().map((f) => f.seq)).toEqual([7]);
    r.stop();
  });

  it('reports the proof of a fork to the application', () => {
    const { r, a, b } = forked(1);
    for (const n of r.nodes) n.mesh.start();
    r.settle(5000);
    expect([...a.suspect, ...b.suspect].flatMap((s) => s.forks)).not.toEqual([]);
    expect(a.sync.stats().forksReceived + b.sync.stats().forksReceived).toBeGreaterThan(0);
    r.stop();
  });

  it('settles after a fork: nothing is resent once both sides hold both branches', () => {
    const { r, a, b } = forked(1);
    for (const n of r.nodes) n.mesh.start();
    r.settle(5000);
    const counts = tally([a, b]);
    r.settle(30_000);
    expect(counts.events ?? 0).toBe(0);
    r.stop();
  });

  it('spreads a fork to a third replica that only ever saw one branch', () => {
    const r = rig({ size: 3, start: false });
    const [a, b, c] = r.nodes as [Node, Node, Node];
    a.author.emit('task.released', { taskId: 't', reason: 'base' }, 0);
    b.log.ingestMany(a.log.all());
    c.log.ingestMany(a.log.all());
    const twin = new Author(a.keys, b.log);
    a.author.emit('task.released', { taskId: 't', reason: 'branch a' }, 0);
    twin.emit('task.released', { taskId: 't', reason: 'branch b' }, 0);
    c.log.ingestMany(a.log.all());
    for (const n of r.nodes) n.mesh.start();
    r.settle(6000);
    expect(expectConverged(r.nodes)).toBe(true);
    expect(c.log.forks()).toHaveLength(1);
    r.stop();
  });

  it('keeps building on a forked history without stalling honest actors', () => {
    const { r, a, b } = forked(2);
    for (const n of r.nodes) n.mesh.start();
    r.settle(3000);
    const after = b.emit('honest follow up');
    r.settle(3000);
    expect(a.log.has(after.id)).toBe(true);
    expect(expectConverged(r.nodes)).toBe(true);
    r.stop();
  });

  /** A fork after a history many batches long: the branch sits behind events the peer already holds. */
  function forkedLate(shared: number) {
    const r = rig({ size: 2, start: false, sync: { maxBatchEvents: 10 } });
    const [a, b] = r.nodes as [Node, Node];
    for (let i = 0; i < shared; i++) a.author.emit('task.released', { taskId: 't', reason: `shared ${i}` }, 0);
    b.log.ingestMany(a.log.all());
    const twin = new Author(a.keys, b.log);
    a.author.emit('task.released', { taskId: 't', reason: 'branch a' }, 0);
    twin.emit('task.released', { taskId: 't', reason: 'branch b' }, 0);
    return { r, a, b };
  }

  it('reaches a branch hidden behind more than one batch of events the peer already holds', () => {
    const { r, a, b } = forkedLate(200);
    for (const n of r.nodes) n.mesh.start();
    r.settle(5000);
    expect(a.log.size).toBe(202);
    expect(expectConverged(r.nodes)).toBe(true);
    expect(a.log.forks()).toHaveLength(1);
    expect(b.log.forks()).toHaveLength(1);
    r.stop();
  });

  it('walks a long shared history once, then goes quiet', () => {
    const { r, a, b } = forkedLate(200);
    for (const n of r.nodes) n.mesh.start();
    r.settle(5000);
    const sent = a.sync.stats().eventsSent + b.sync.stats().eventsSent;
    expect(sent).toBeLessThan(202 * 3);
    const counts = tally([a, b]);
    r.settle(60_000);
    expect(counts.events ?? 0).toBe(0);
    r.stop();
  });

  it('still reaches the branch when each message is doubled and scattered', () => {
    for (const seed of [1, 2, 3]) {
      const r = rig({ size: 2, start: false, seed, sync: { maxBatchEvents: 10 } });
      const [a, b] = r.nodes as [Node, Node];
      for (let i = 0; i < 120; i++) a.author.emit('task.released', { taskId: 't', reason: `s ${i}` }, 0);
      b.log.ingestMany(a.log.all());
      const twin = new Author(a.keys, b.log);
      a.author.emit('task.released', { taskId: 't', reason: 'branch a' }, 0);
      twin.emit('task.released', { taskId: 't', reason: 'branch b' }, 0);
      for (const n of r.nodes) n.mesh.setFaults({ blocked: [], lossRate: 0.2, duplicateRate: 0.3, reorder: true });
      for (const n of r.nodes) n.mesh.start();
      r.settle(60_000);
      for (const n of r.nodes) n.mesh.setFaults({ blocked: [] });
      r.settle(20_000);
      expect(a.log.size).toBe(122);
      expect(expectConverged(r.nodes)).toBe(true);
      r.stop();
    }
  });

  it('treats a head that flips to another branch at the same sequence as news', () => {
    const r = rig({ size: 2 });
    r.settle();
    const [a, b] = r.nodes as [Node, Node];
    const twin = new Author(a.keys, b.log);
    a.mesh.setFaults({ blocked: [b.id] });
    a.author.emit('task.released', { taskId: 't', reason: 'one' }, 0);
    twin.emit('task.released', { taskId: 't', reason: 'two' }, 0);
    r.settle(1000);
    a.mesh.setFaults({ blocked: [] });
    r.settle(5000);
    expect(expectConverged(r.nodes)).toBe(true);
    const counts = tally([a, b]);
    r.settle(10_000);
    expect(counts.events ?? 0).toBe(0);
    r.stop();
  });
});

describe('lifecycle', () => {
  it('stops cleanly', () => {
    const r = rig({ size: 2 });
    r.settle();
    const [a, b] = r.nodes as [Node, Node];
    b.sync.stop();
    const event = a.emit('after stop');
    r.settle(5000);
    expect(b.log.has(event.id)).toBe(false);
    r.stop();
  });

  it('picks up links that were already open when attached', () => {
    const r = rig({ size: 2 });
    r.settle();
    const [a, b] = r.nodes as [Node, Node];
    a.sync.stop();
    b.sync.stop();
    const logA = new EventLog(MISSION);
    new Author(a.keys, logA).emit('task.released', { taskId: 't', reason: 'late' }, 0);
    const logB = new EventLog(MISSION);
    attachSync(b.mesh, logB, () => {});
    attachSync(a.mesh, logA, () => {});
    r.settle(5000);
    expect(logB.size).toBe(1);
    r.stop();
  });
});
