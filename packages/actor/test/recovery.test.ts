import { describe, expect, it } from 'vitest';
import type { AnyEvent } from '@afterlink/protocol';
import { createMemoryStorage, type ActorStorage, type HighWaterMark, type StoredActor } from '../src/index.ts';
import { beatSpec, chainIsWhole, eventsOf, Fleet, ownEvents, TEAMS } from './harness.ts';

/** Writes wait for `release`. `crash` drops them, as power loss does. */
function slowStorage(inner: ActorStorage) {
  let release: (() => void) | null = null;
  const pending: { events: AnyEvent[]; mark?: HighWaterMark }[] = [];
  return {
    ...inner,
    hold: false,
    append(events: AnyEvent[], mark?: HighWaterMark) {
      if (!this.hold) return inner.append(events, mark);
      pending.push({ events, mark });
      return new Promise<void>((resolve) => (release = resolve));
    },
    land() {
      for (const w of pending.splice(0)) void inner.append(w.events, w.mark);
      release?.();
      this.hold = false;
    },
    close: () => inner.close?.(),
  };
}

/** A device whose browser kept some, or none, of what it wrote. */
function restoredFrom(inner: ActorStorage, o: { keep?: (s: StoredActor) => AnyEvent[]; wipeLog?: boolean; mark?: HighWaterMark | null }): ActorStorage {
  return {
    ...inner,
    load: async () => {
      if (o.wipeLog) return null;
      const s = await inner.load();
      return s && { ...s, events: o.keep ? o.keep(s) : s.events };
    },
    readMark: async () => (o.mark === undefined ? inner.readMark() : o.mark),
  };
}

const firstHalf = (s: StoredActor) => s.events.slice(0, Math.floor(s.events.length / 2));

async function chatter(f: Fleet) {
  f.actors.medics.observe('a', 1);
  f.actors.medics.observe('b', 2);
  f.actors.medics.observe('c', 3);
  f.quiet();
}

function headOf(f: Fleet) {
  const own = ownEvents(f.actors.medics).sort((x, y) => x.seq - y.seq);
  const top = own.at(-1)!;
  return { actor: top.actor, mission: top.mission, seq: top.seq, id: top.id };
}

describe('write ahead', () => {
  it('a signed event reaches no peer, packet or screen before it is durable', async () => {
    const inner = createMemoryStorage();
    const f = new Fleet({ quiet: true, autopilot: false });
    const slow = slowStorage(inner);
    f.storage.medics = slow;
    f.actors.medics = f.make('medics');
    await f.connected();

    slow.hold = true;
    f.actors.medics.observe('secret-until-durable', true);
    f.run(1000);
    const has = (events: AnyEvent[]) =>
      events.some((e) => e.type === 'observation.recorded' && e.body.observation.key === 'secret-until-durable');
    expect(has(f.actors.medics.events())).toBe(false);
    expect(has(f.actors.supply.events())).toBe(false);
    expect(has(f.actors.medics.buildFerry().events)).toBe(false);
    expect(f.actors.medics.view().state.observations['secret-until-durable']).toBeUndefined();

    slow.land();
    await f.actors.medics.settled();
    f.run(1000);
    expect(has(f.actors.medics.events())).toBe(true);
    expect(has(f.actors.supply.events())).toBe(true);
    expect(f.actors.medics.view().state.observations['secret-until-durable']).toHaveLength(1);
  });

  it('a crash before the write lands loses only what nobody saw, and the chain stays whole', async () => {
    const inner = createMemoryStorage();
    const f = new Fleet({ quiet: true, autopilot: false });
    const slow = slowStorage(inner);
    f.storage.medics = slow;
    f.actors.medics = f.make('medics');
    await f.connected();

    slow.hold = true;
    f.actors.medics.observe('lost-in-the-crash', true);
    f.run(500);
    f.actors.medics.stop();
    inner.close?.();

    f.storage.medics = inner;
    f.actors.medics = f.make('medics');
    await f.actors.medics.start();
    expect(f.actors.medics.view().phase).toBe('ready');
    f.until(() => f.actors.medics.view().reachable.length === 3, 'links back');
    f.actors.medics.observe('after-the-crash', true);
    f.run(1000);

    expect(chainIsWhole(f.actors.supply) && chainIsWhole(f.actors.medics)).toBe(true);
    expect(f.actors.supply.view().state.observations['after-the-crash']).toHaveLength(1);
    expect(f.actors.supply.view().state.observations['lost-in-the-crash']).toBeUndefined();
    expect(f.actors.supply.view().state.conflicts).toEqual([]);
  });

  it('events signed in one step land as one write, so a crash cannot split a commit from its claim', async () => {
    const writes: AnyEvent['type'][][] = [];
    const inner = createMemoryStorage();
    const f = new Fleet({ quiet: true, autopilot: false });
    f.storage.supply = {
      ...inner,
      append(events, mark) {
        writes.push(events.map((e) => e.type));
        return inner.append(events, mark);
      },
    };
    f.actors.supply = f.make('supply');
    await f.connected();

    f.actors.supply.submitTask(beatSpec('split-field-aed'), { kind: 'human' });
    f.run(500);
    const write = writes.find((w) => w.includes('task.claimed'));
    expect(write).toContain('right.committed');
    expect(write!.indexOf('right.committed')).toBeLessThan(write!.indexOf('task.claimed'));
  });

  it('a failing write publishes nothing, says so, and retries', async () => {
    const inner = createMemoryStorage();
    let broken = false;
    const f = new Fleet({ quiet: true, autopilot: false });
    f.storage.medics = {
      ...inner,
      append(events, mark) {
        if (broken) throw new Error('quota exceeded');
        return inner.append(events, mark);
      },
    };
    f.actors.medics = f.make('medics');
    await f.connected();

    broken = true;
    f.actors.medics.observe('blocked-by-disk', 1);
    f.run(500);
    expect(f.actors.medics.view().storageError).toBe('quota exceeded');
    expect(f.actors.supply.view().state.observations['blocked-by-disk']).toBeUndefined();

    broken = false;
    f.run(500);
    expect(f.actors.medics.view().storageError).toBeNull();
    expect(f.actors.supply.view().state.observations['blocked-by-disk']).toHaveLength(1);
  });
});

describe('anti-rollback', () => {
  async function restart(f: Fleet, storage: ActorStorage) {
    f.actors.medics.stop();
    f.storage.medics = storage;
    f.actors.medics = f.make('medics');
    await f.actors.medics.start();
  }

  it('a log rolled back behind its mark stays shut while alone, then recovers from a peer', async () => {
    const f = await new Fleet({ quiet: true, autopilot: false }).connected();
    await chatter(f);
    const before = headOf(f);
    f.net.killHub();

    await restart(f, restoredFrom(f.storage.medics, { keep: firstHalf }));
    const medics = f.actors.medics;
    expect(medics.view().phase).toBe('recovering');
    expect(medics.view().phaseReason).toBeTruthy();
    expect(medics.observe('must-not-sign', 1)).toBe(false);
    expect(medics.submitTask(beatSpec('connected-faint'), { kind: 'human' })).toBe(false);
    f.run(20_000);
    expect(medics.view().phase).toBe('recovering');
    expect(ownEvents(medics).every((e) => e.seq < before.seq)).toBe(true);

    f.net.restoreHub();
    f.until(() => medics.view().phase === 'ready', 'chain returned by a peer');
    expect(ownEvents(medics).some((e) => e.id === before.id)).toBe(true);
    expect(chainIsWhole(medics)).toBe(true);

    expect(medics.observe('free-to-sign', 1)).toBe(true);
    f.run(1000);
    expect(f.actors.supply.view().state.observations['free-to-sign']).toHaveLength(1);
    expect(f.actors.supply.view().state.conflicts).toEqual([]);
  });

  it('a wiped log with a surviving mark recovers the whole chain and never rejoins', async () => {
    const f = await new Fleet({ quiet: true, autopilot: false }).connected();
    await chatter(f);
    const before = headOf(f);

    await restart(f, restoredFrom(f.storage.medics, { wipeLog: true }));
    expect(f.actors.medics.view().phase).toBe('recovering');
    f.until(() => f.actors.medics.view().phase === 'ready', 'chain returned');

    expect(ownEvents(f.actors.medics).filter((e) => e.type === 'actor.joined')).toHaveLength(1);
    expect(ownEvents(f.actors.medics).some((e) => e.id === before.id)).toBe(true);
    expect(chainIsWhole(f.actors.medics)).toBe(true);
    expect(f.actors.supply.view().state.conflicts).toEqual([]);
  });

  it('an event that reached nobody before the wipe keeps the device shut: it cannot prove what it signed', async () => {
    const f = await new Fleet({ quiet: true, autopilot: false }).connected();
    await chatter(f);
    f.split(['medics'], ['access', 'facilities', 'supply']);
    f.run(1000);
    f.actors.medics.observe('only-here', 1);
    f.run(200);
    f.unsplit();

    await restart(f, restoredFrom(f.storage.medics, { wipeLog: true }));
    f.until(() => f.actors.medics.view().reachable.length === 3, 'links back');
    f.run(5000);
    expect(f.actors.medics.view().phase).toBe('recovering');
    expect(f.actors.medics.observe('must-not-sign', 1)).toBe(false);
    expect(chainIsWhole(f.actors.medics)).toBe(true);
  });

  it('a device wiped completely, mark and all, recovers from the first peer that knows it', async () => {
    const f = await new Fleet({ quiet: true, autopilot: false }).connected();
    await chatter(f);
    const before = headOf(f);
    f.actors.medics.stop();
    f.storage.medics.close?.();

    f.storage.medics = createMemoryStorage();
    f.actors.medics = f.make('medics');
    await f.actors.medics.start();
    expect(f.actors.medics.view().phase).toBe('recovering');
    f.until(() => f.actors.medics.view().phase === 'ready', 'chain returned');

    expect(ownEvents(f.actors.medics).some((e) => e.id === before.id)).toBe(true);
    expect(ownEvents(f.actors.medics).filter((e) => e.type === 'actor.joined')).toHaveLength(1);
    expect(f.actors.supply.view().state.conflicts).toEqual([]);
  });

  it('a wiped device that is alone stays read only, and a carried packet can restore it', async () => {
    const f = await new Fleet({ quiet: true, autopilot: false }).connected();
    await chatter(f);
    const before = headOf(f);
    f.net.killHub();

    await restart(f, restoredFrom(f.storage.medics, { wipeLog: true }));
    f.run(30_000);
    expect(f.actors.medics.view().phase).toBe('recovering');
    expect(ownEvents(f.actors.medics)).toEqual([]);

    const result = f.actors.medics.ingestFerry(f.actors.supply.buildFerry());
    expect(result.rejected).toBe(0);
    expect(f.actors.medics.view().phase).toBe('ready');
    expect(ownEvents(f.actors.medics).some((e) => e.id === before.id)).toBe(true);
    expect(chainIsWhole(f.actors.medics)).toBe(true);
  });

  it('a first run signs nothing until a peer confirms it has no history', async () => {
    const f = new Fleet({ quiet: true, autopilot: false });
    f.net.killHub();
    await f.actors.medics.start();
    f.run(30_000);
    expect(f.actors.medics.view().phase).toBe('recovering');
    expect(ownEvents(f.actors.medics)).toEqual([]);

    f.net.restoreHub();
    for (const t of TEAMS) if (t !== 'medics') await f.actors[t].start();
    f.until(() => TEAMS.every((t) => f.actors[t].view().phase === 'ready'), 'every first run confirmed');
    f.until(() => TEAMS.every((t) => ownEvents(f.actors[t]).length > 0), 'everyone joined');
    expect(ownEvents(f.actors.medics)[0]?.type).toBe('actor.joined');
  });

  it('a normal restart needs no peer at all: an intact log and mark open at once, even alone', async () => {
    const f = await new Fleet({ quiet: true, autopilot: false }).connected();
    await chatter(f);
    f.net.killHub();
    await restart(f, f.storage.medics);
    expect(f.actors.medics.view().phase).toBe('ready');
    expect(f.actors.medics.observe('still-working', 1)).toBe(true);
  });

  it('log and mark rolled back together: the first peer summary shuts the gate before anything is signed', async () => {
    const f = await new Fleet({ quiet: true, autopilot: false }).connected();
    const earlyMark = headOf(f);
    const keep = (s: StoredActor) => s.events.filter((e) => e.actor !== f.id('medics') || e.seq <= earlyMark.seq);
    await chatter(f);
    const before = headOf(f);

    await restart(f, restoredFrom(f.storage.medics, { keep, mark: earlyMark }));
    expect(f.actors.medics.view().phase).toBe('ready');
    f.until(() => f.actors.medics.view().reachable.length === 3, 'links back');
    f.until(() => ownEvents(f.actors.medics).some((e) => e.id === before.id), 'chain returned');
    f.run(1000);

    expect(f.actors.medics.view().phase).toBe('ready');
    expect(chainIsWhole(f.actors.medics)).toBe(true);
    expect(f.actors.supply.view().state.conflicts).toEqual([]);
  });
});

describe('self-fork', () => {
  it('a rolled back device that spends while alone halts at first contact, and everyone can see why', async () => {
    const f = await new Fleet({ quiet: true, autopilot: false }).connected();
    const mark = headOf(f);
    const medics = f.actors.medics;
    const keep = (s: StoredActor) => s.events.filter((e) => e.actor !== f.id('medics') || e.seq <= mark.seq);

    const transfer = medics.offerTokens(['aed#1'], f.id('supply'));
    f.until(() => f.actors.supply.view().pendingTransfers.length === 1, 'offer arrives');
    expect(f.actors.supply.answerTransfer(transfer!, true)).toBe(true);
    f.run(500);
    expect(f.actors.supply.view().tokens.map((t) => t.id)).toContain('aed#1');

    f.net.killHub();
    medics.stop();
    f.storage.medics = restoredFrom(f.storage.medics, { keep, mark });
    f.split(['supply', 'access', 'facilities'], []);
    const rolledBack = f.make('medics');
    f.actors.medics = rolledBack;
    await rolledBack.start();
    expect(rolledBack.view().phase).toBe('ready');
    expect(rolledBack.view().tokens.map((t) => t.id)).toContain('aed#1');

    rolledBack.submitTask(beatSpec('split-field-aed'), { kind: 'human' });
    rolledBack.observe('signed-on-the-wrong-branch', 1);
    f.run(200);
    const forkSeq = ownEvents(rolledBack).at(-1)!.seq;

    f.net.restoreHub();
    f.until(() => rolledBack.view().phase === 'halted', 'the device sees its own fork');
    expect(rolledBack.view().phaseReason).toBeTruthy();

    expect(rolledBack.observe('after-the-halt', 1)).toBe(false);
    expect(rolledBack.submitTask(beatSpec('connected-faint'), { kind: 'human' })).toBe(false);
    f.run(5000);
    expect(ownEvents(rolledBack).filter((e) => e.seq > forkSeq && e.type === 'observation.recorded')).toEqual([]);
  });
});

describe('one identity, one runtime', () => {
  it('a second runtime on the same device only reads, and writes nothing', async () => {
    const f = await new Fleet({ quiet: true, autopilot: false }).connected();
    await chatter(f);
    const stored = (await f.storage.medics.load())!.events.length;

    const twin = f.make('medics');
    await twin.start();
    expect(twin.view().phase).toBe('duplicate');
    expect(twin.view().phaseReason).toBeTruthy();
    expect(twin.view().state.observations.a).toHaveLength(1);
    expect(twin.observe('from-the-twin', 1)).toBe(false);
    expect(twin.acceptTask('anything')).toBe(false);
    f.run(1000);
    expect((await f.storage.medics.load())!.events.length).toBe(stored);
    expect(chainIsWhole(f.actors.medics)).toBe(true);
  });

  it('the identity is free again after a clean stop', async () => {
    const f = await new Fleet({ quiet: true, autopilot: false }).connected();
    f.actors.medics.stop();
    f.actors.medics = f.make('medics');
    await f.actors.medics.start();
    expect(f.actors.medics.view().phase).toBe('ready');
  });
});

describe('ferry replay', () => {
  it('a packet seen before stays a no-op after a restart, and never counts as contact', async () => {
    const f = await new Fleet({ quiet: true, autopilot: false }).connected();
    const lastContact = f.actors.access.view().summary;
    f.split(['medics', 'supply'], ['access', 'facilities']);
    f.run(1000);
    f.actors.supply.observe('carried', 1);
    f.run(200);
    const packet = f.actors.supply.buildFerry(lastContact);

    expect(f.actors.access.ingestFerry(packet).newEvents).toBeGreaterThan(0);
    f.run(200);
    const receipts = () => eventsOf(f.actors.access, 'ferry.received').length;
    expect(receipts()).toBe(1);

    f.actors.access.stop();
    f.actors.access = f.make('access');
    await f.actors.access.start();
    f.run(200);
    expect(f.actors.access.view().lastHeard[f.id('supply')]).toBeUndefined();

    f.run(60_000);
    const replay = f.actors.access.ingestFerry(packet);
    expect(replay.newEvents).toBe(0);
    expect(receipts()).toBe(1);
    expect(f.actors.access.view().lastHeard[f.id('supply')]).toBeUndefined();
  });

  it('a packet that brings nothing new leaves no trace in the log', async () => {
    const f = await new Fleet({ quiet: true, autopilot: false }).connected();
    const packet = f.actors.supply.buildFerry(f.actors.access.view().summary);
    const size = f.actors.access.events().length;
    expect(f.actors.access.ingestFerry(packet).newEvents).toBe(0);
    f.run(200);
    expect(f.actors.access.events().length).toBe(size);
  });

  it('an old packet is flagged, and still taken in: events prove themselves, age proves nothing', async () => {
    const f = await new Fleet({ quiet: true, autopilot: false }).connected();
    const lastContact = f.actors.access.view().summary;
    f.split(['medics', 'supply'], ['access', 'facilities']);
    f.run(1000);
    f.actors.supply.observe('old-news', 1);
    f.run(200);
    const packet = f.actors.supply.buildFerry(lastContact);
    f.run(11 * 60_000);
    const result = f.actors.access.ingestFerry(packet);
    expect(result.stale).toBe(true);
    expect(result.newEvents).toBeGreaterThan(0);
    expect(f.actors.access.view().state.observations['old-news']).toHaveLength(1);
  });

  it('a packet from outside the mission is refused whole', async () => {
    const outsider = await new Fleet({ quiet: true, autopilot: false }).connected();
    const f = await new Fleet({ quiet: true, autopilot: false }).connected();
    const result = f.actors.access.ingestFerry(outsider.actors.supply.buildFerry());
    expect(result.newEvents).toBe(0);
    expect(result.reason).toBeTruthy();
  });
});

describe('clocks', () => {
  it('a wall clock stepping back an hour cannot silence cover', async () => {
    let skew = 0;
    const f = new Fleet({ quiet: true, autopilot: false });
    for (const t of TEAMS) f.actors[t] = f.make(t, { now: () => f.clock.now() + skew });
    await f.connected();

    f.actors.medics.submitTask(beatSpec('hq-down-queue-water'), { kind: 'human' });
    f.until(() => !!f.task('queue-water')?.owner, 'claimed');
    const owner = f.byTeam('queue-water')!;
    const cover = owner === 'supply' ? 'facilities' : 'supply';
    f.split(['medics', 'supply'], ['access', 'facilities']);
    skew = -3_600_000;

    f.until(() => (f.task('queue-water', cover)?.coveredBy ?? []).includes(f.id(cover)), 'cover fires', 15_000);
  });

  it('a restart forgets contact times rather than inventing them', async () => {
    const f = await new Fleet({ quiet: true, autopilot: false }).connected();
    f.run(3000);
    expect(f.actors.medics.view().lastHeard[f.id('supply')]).toBeDefined();
    f.net.killHub();
    f.actors.medics.stop();
    f.actors.medics = f.make('medics');
    await f.actors.medics.start();
    expect(f.actors.medics.view().lastHeard).toEqual({});
  });
});
