import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  Author,
  createEvent,
  EventLog,
  generateKeys,
  MAX_LAMPORT_JUMP,
  MAX_PARENTS,
  MAX_WAITING_PER_ACTOR,
  type AnyEvent,
  type KeyPair,
  type LogSummary,
} from '../src/index.ts';
import { fingerprint, ids, isCausal, MISSION, note, playHistory, seededKeys, type Step } from './helpers.ts';

const holder = seededKeys(40);
const recipient = seededKeys(41);
const stranger = seededKeys(42);

function event(keys: KeyPair, seq: number, prev: string | null, lamport: number, reason = `${seq}@${lamport}`, parents: string[] = []) {
  return createEvent({
    keys,
    mission: MISSION,
    seq,
    prev,
    parents,
    lamport,
    wall: lamport,
    type: 'task.released',
    body: note(reason),
  }) as unknown as AnyEvent;
}

function chain(keys: KeyPair, length: number, label = ''): AnyEvent[] {
  const events: AnyEvent[] = [];
  for (let seq = 1; seq <= length; seq++) events.push(event(keys, seq, events.at(-1)?.id ?? null, seq, `${label}${seq}`));
  return events;
}

function branchFrom(tip: AnyEvent, length: number, label: string): AnyEvent[] {
  const events: AnyEvent[] = [];
  for (let i = 1; i <= length; i++) {
    const last = events.at(-1) ?? tip;
    events.push(event(holder, last.seq + 1, last.id, last.lamport + 1, `${label}${i}`));
  }
  return events;
}

function replica(events: AnyEvent[]): EventLog {
  const log = new EventLog(MISSION);
  log.ingestMany(events);
  return log;
}

function exchange(a: EventLog, b: EventLog): void {
  b.ingestMany(a.missingFor(b.summary()));
  a.ingestMany(b.missingFor(a.summary()));
}

const shuffles = <T>(items: T[]) => fc.shuffledSubarray(items, { minLength: items.length });

describe('a declared clock cannot lie about causality', () => {
  it('refuses the retroactive theft: a commit declared before its own offer', () => {
    const history = chain(holder, 7);
    const offer = event(holder, 8, history[6]!.id, 50, 'offer');
    const accept = event(recipient, 1, null, 51, 'accept', [offer.id]);
    const commit = event(holder, 9, offer.id, 1, 'take it back');
    const log = replica([...history, offer, accept]);
    expect(log.ingest(commit)).toBe('invalid');
    expect(log.has(commit.id)).toBe(false);
  });

  it('refuses a lamport equal to a dependency, through prev or through parents', () => {
    const [root] = chain(holder, 1);
    const other = event(recipient, 1, null, 9);
    expect(replica([root!]).ingest(event(holder, 2, root!.id, 1))).toBe('invalid');
    const log = replica([root!, other]);
    expect(log.ingest(event(holder, 2, root!.id, 5, 'ignores parent clock', [other.id]))).toBe('invalid');
    expect(log.ingest(event(holder, 2, root!.id, 9, 'ties parent clock', [other.id]))).toBe('invalid');
    expect(log.ingest(event(holder, 2, root!.id, 10, 'passes parent clock', [other.id]))).toBe('added');
  });

  it('bounds how far a clock may run ahead, exactly at the limit', () => {
    const [root] = chain(holder, 1);
    expect(replica([root!]).ingest(event(holder, 2, root!.id, 1 + MAX_LAMPORT_JUMP))).toBe('added');
    expect(replica([root!]).ingest(event(holder, 2, root!.id, 2 + MAX_LAMPORT_JUMP))).toBe('invalid');
    expect(new EventLog(MISSION).ingest(event(holder, 1, null, MAX_LAMPORT_JUMP))).toBe('added');
    expect(new EventLog(MISSION).ingest(event(holder, 1, null, MAX_LAMPORT_JUMP + 1))).toBe('invalid');
    expect(new EventLog(MISSION).ingest(event(holder, 1, null, 0))).toBe('added');
  });

  it('one event at the end of the integer range cannot stop honest signers', () => {
    const log = new EventLog(MISSION);
    const author = new Author(holder, log);
    author.emit('task.released', note('before'), 1);
    expect(log.ingest(event(stranger, 1, null, Number.MAX_SAFE_INTEGER))).toBe('invalid');
    expect(author.emit('task.released', note('after'), 2).lamport).toBe(2);
  });

  it('gives the same verdict however late the dependency arrives', () => {
    const [root] = chain(holder, 1);
    const high = event(recipient, 1, null, 30);
    const liar = event(holder, 2, root!.id, 5, 'liar', [high.id]);
    const child = event(holder, 3, liar.id, 6, 'child of a refused event');
    const honest = event(holder, 2, root!.id, 31, 'honest', [high.id]);
    const all = [root!, high, liar, child, honest];
    const reference = fingerprint(replica(all));
    fc.assert(
      fc.property(shuffles(all), (order) => {
        const log = replica(order);
        expect(fingerprint(log)).toEqual(reference);
        expect(log.has(liar.id)).toBe(false);
        expect(log.has(child.id)).toBe(false);
        expect(log.forks()).toEqual([]);
      }),
    );
  });

  it('makes declared lamport a causal order, so a plain sort by it is safe', () => {
    const device = fc.nat(3).map((d): Step => ({ kind: 'emit', device: d }));
    const sync = fc.record({ from: fc.nat(3), to: fc.nat(3) }).map((s): Step => ({ kind: 'sync', ...s }));
    fc.assert(
      fc.property(fc.array(fc.oneof(device, sync), { maxLength: 40 }), (plan) => {
        const { events } = playHistory(4, plan);
        expect(isCausal([...replica(events).all()].sort((a, b) => a.lamport - b.lamport))).toBe(true);
      }),
      { numRuns: 50 },
    );
  });
});

describe('only the roster writes to the log', () => {
  const admit = (actor: string) => actor === holder.publicKey;

  it('refuses a stranger: nothing stored, nothing forwarded, nothing buffered', () => {
    const log = new EventLog(MISSION, { admit });
    const [member] = chain(holder, 1);
    expect(log.ingest(member!)).toBe('added');
    const before = fingerprint(log);
    expect(log.ingest(event(stranger, 1, null, 1))).toBe('invalid');
    expect(log.ingest(event(stranger, 2, 'unknown', 2))).toBe('invalid');
    expect(log.pending).toBe(0);
    expect(fingerprint(log)).toEqual(before);
    expect(ids(log.missingFor({ mission: MISSION, heads: {} }))).toEqual([member!.id]);
  });

  it('reports strangers through ingestMany, so a violation can be raised', () => {
    const intruder = event(stranger, 1, null, 1);
    const result = new EventLog(MISSION, { admit }).ingestMany([intruder]);
    expect(result.invalid).toEqual([intruder]);
  });

  it('leaves a member event that depends on a stranger waiting, never placed', () => {
    const intruder = event(stranger, 1, null, 1);
    const log = new EventLog(MISSION, { admit });
    const dependent = event(holder, 1, null, 2, 'tainted', [intruder.id]);
    log.ingestMany([intruder, dependent]);
    expect(log.has(dependent.id)).toBe(false);
    expect(log.pending).toBe(1);
  });

  it('admits everyone when no roster is given', () => {
    expect(new EventLog(MISSION).ingest(event(stranger, 1, null, 1))).toBe('added');
  });
});

describe('peers cannot grow the buffer without limit', () => {
  const stuck = (keys: KeyPair, from: number, count: number) =>
    Array.from({ length: count }, (_, i) => event(keys, from + i, 'never-arrives', from + i));

  it('holds at most the per-actor limit and reports the rest as gaps', () => {
    const log = new EventLog(MISSION);
    const result = log.ingestMany(stuck(holder, 2, MAX_WAITING_PER_ACTOR + 5));
    expect(log.pending).toBe(MAX_WAITING_PER_ACTOR);
    expect(result.gaps).toBe(MAX_WAITING_PER_ACTOR + 5);
  });

  it('lets a flood from one actor cost nobody else', () => {
    const log = new EventLog(MISSION);
    log.ingestMany(stuck(stranger, 2, MAX_WAITING_PER_ACTOR));
    const honest = chain(holder, 3);
    expect(log.ingest(honest[2]!)).toBe('gap');
    log.ingestMany([honest[1]!, honest[0]!]);
    expect(log.size).toBe(3);
  });

  it('recovers a refused event on redelivery, as anti-entropy does', () => {
    const events = chain(holder, MAX_WAITING_PER_ACTOR + 40);
    const log = new EventLog(MISSION);
    for (let i = events.length - 1; i >= 1; i--) log.ingest(events[i]!);
    expect(log.pending).toBe(MAX_WAITING_PER_ACTOR);
    log.ingest(events[0]!);
    log.ingestMany(events);
    log.ingestMany(events);
    expect(log.size).toBe(events.length);
    expect(log.pending).toBe(0);
    expect(fingerprint(log)).toEqual(fingerprint(replica(events)));
  });

  it('frees capacity as held events are released', () => {
    const log = new EventLog(MISSION);
    const first = chain(holder, MAX_WAITING_PER_ACTOR + 1);
    log.ingestMany(first.slice(1));
    log.ingest(first[0]!);
    expect(log.pending).toBe(0);
    const next = event(holder, first.length + 2, 'never-arrives', first.length + 2);
    expect(log.ingest(next)).toBe('gap');
    expect(log.pending).toBe(1);
  });

  it('keeps honest events signable through a flood of concurrent tips', () => {
    const tips = Array.from({ length: MAX_PARENTS + 20 }, () => event(generateKeys(), 1, null, 1));
    const log = replica(tips);
    expect(log.heads()).toHaveLength(MAX_PARENTS);
    const honest = new Author(holder, log).emit('task.released', note('still here'), 1);
    expect(honest.parents).toHaveLength(MAX_PARENTS);
    expect(replica([...tips].reverse()).ingest(honest)).toBe('added');
    expect(replica([...tips].reverse()).heads()).toEqual(replica(tips).heads());
  });

  it('keeps honest events signable through a flood of tips from one forked key', () => {
    const [root] = chain(stranger, 1);
    const tips = Array.from({ length: MAX_PARENTS + 20 }, (_, i) => event(stranger, 2, root!.id, 2, `tip ${i}`));
    const log = replica([root!, ...tips]);
    expect(new Author(holder, log).emit('task.released', note('still here'), 1).parents).toHaveLength(MAX_PARENTS);
  });
});

describe('forks are visible and travel by id', () => {
  const trunk = chain(holder, 6);
  const tip = trunk[5]!;

  it('does not call two replicas in sync when they hold different events at one seq', () => {
    const [a7] = branchFrom(tip, 1, 'a');
    const [b7] = branchFrom(tip, 1, 'b');
    const x = replica([...trunk, a7!]);
    const y = replica([...trunk, b7!]);
    expect(x.summary().heads[holder.publicKey]!.seq).toBe(y.summary().heads[holder.publicKey]!.seq);
    expect(ids(x.missingFor(y.summary()))).toContain(a7!.id);
    expect(ids(y.missingFor(x.summary()))).toContain(b7!.id);
    exchange(x, y);
    expect(fingerprint(x)).toEqual(fingerprint(y));
    expect(x.forks()).toHaveLength(1);
  });

  it('repairs 7a against 7b, 8b, 9b without stalling in a gap', () => {
    const [a7] = branchFrom(tip, 1, 'a');
    const b = branchFrom(tip, 3, 'b');
    const x = replica([...trunk, a7!]);
    const y = replica([...trunk, ...b]);
    const delta = y.missingFor(x.summary());
    expect(ids(delta)).toEqual(expect.arrayContaining(ids(b)));
    expect(x.ingestMany(delta).gaps).toBe(0);
    expect(x.forks()).toHaveLength(1);
    exchange(x, y);
    expect(y.has(a7!.id)).toBe(true);
    expect(x.pending + y.pending).toBe(0);
    expect(fingerprint(x)).toEqual(fingerprint(y));
    expect(x.missingFor(y.summary())).toEqual([]);
  });

  it('reports the lowest forked seq per actor, and nothing when there is no fork', () => {
    expect(replica(trunk).summary()).not.toHaveProperty('forked');
    expect(replica(trunk).summary()).not.toHaveProperty('branches');
    const low = branchFrom(trunk[1]!, 2, 'low');
    const high = branchFrom(tip, 1, 'high');
    const second = branchFrom(tip, 1, 'second');
    const summary = replica([...trunk, ...low, ...high, ...second]).summary();
    expect(summary.forked).toEqual({ [holder.publicKey]: 3 });
  });

  it('spreads a proof in one direction, in one round, to a replica that looks ahead of us', () => {
    const a = branchFrom(tip, 1, 'a');
    const b = branchFrom(tip, 1, 'b');
    const longer = branchFrom(a[0]!, 3, 'longer');
    const proof = replica([...trunk, ...a, ...b]);
    const ahead = replica([...trunk, ...a, ...longer]);
    ahead.ingestMany(proof.missingFor(ahead.summary()));
    expect(ahead.forks()).toHaveLength(1);
  });

  it('spreads a proof that cannot be placed yet, then stops resending it', () => {
    const withheld = event(holder, 6, 'branch-withheld-by-the-signer', 6, 'hidden');
    const witness = replica(trunk);
    expect(witness.ingest(withheld)).toBe('fork');
    expect(witness.summary().forked).toEqual({ [holder.publicKey]: 6 });
    const peer = replica(trunk);
    const delta = witness.missingFor(peer.summary());
    expect(ids(delta)).toEqual([withheld.id]);
    expect(peer.ingestMany(delta).forks).toEqual([withheld]);
    expect(peer.forks()).toHaveLength(1);
    expect(witness.missingFor(peer.summary())).toEqual([]);
    expect(peer.missingFor(witness.summary())).toEqual([]);
  });

  it('survives a wire round trip of a forked summary', () => {
    const a = branchFrom(tip, 1, 'a');
    const b = branchFrom(tip, 1, 'b');
    const log = replica([...trunk, ...a, ...b]);
    const wire = JSON.parse(JSON.stringify(log.summary())) as LogSummary;
    expect(wire).toEqual(log.summary());
    expect(log.missingFor(wire)).toEqual([]);
  });
});

describe('fork handling does not depend on arrival', () => {
  const trunk = chain(holder, 2);
  const [left] = branchFrom(trunk[1]!, 1, 'left');
  const [right] = branchFrom(trunk[1]!, 1, 'right');

  it('keeps a forked event usable as a parent, so honest work never stalls', () => {
    const onLeft = event(recipient, 1, null, 4, 'saw left', [left!.id]);
    const onRight = event(seededKeys(43), 1, null, 4, 'saw right', [right!.id]);
    const onBoth = event(seededKeys(44), 1, null, 5, 'saw both', [onLeft.id, onRight.id]);
    const all = [...trunk, left!, right!, onLeft, onRight, onBoth];
    const reference = fingerprint(replica(all));
    fc.assert(
      fc.property(shuffles(all), (order) => {
        const log = replica(order);
        expect(log.size).toBe(all.length);
        expect(log.pending).toBe(0);
        expect(fingerprint(log)).toEqual(reference);
      }),
    );
  });

  it('never drops the branch that arrived second', () => {
    fc.assert(
      fc.property(shuffles([...trunk, left!, right!]), (order) => {
        const log = replica(order);
        expect(log.has(left!.id) && log.has(right!.id)).toBe(true);
        expect(log.forks()[0]!.events).toHaveLength(2);
      }),
    );
  });

  it('agrees on the head between branches, on every replica', () => {
    const expected = left!.id < right!.id ? left! : right!;
    expect(replica([...trunk, left!, right!]).head(holder.publicKey)!.id).toBe(expected.id);
    expect(replica([...trunk, right!, left!]).head(holder.publicKey)!.id).toBe(expected.id);
  });
});

describe('a device can tell it has lost its own history', () => {
  const own = chain(holder, 7);
  const peerView = replica(own).summary();

  it('sees a wiped log as behind what a peer remembers', () => {
    expect(new EventLog(MISSION).behind(holder.publicKey, peerView)).toBe(true);
  });

  it('sees a rollback as behind, and catching up clears it', () => {
    const restored = replica(own.slice(0, 6));
    expect(restored.behind(holder.publicKey, peerView)).toBe(true);
    restored.ingest(own[6]!);
    expect(restored.behind(holder.publicKey, peerView)).toBe(false);
  });

  it('is not behind when the peer knows nothing, or knows less', () => {
    expect(new EventLog(MISSION).behind(holder.publicKey, { mission: MISSION, heads: {} })).toBe(false);
    expect(replica(own).behind(holder.publicKey, replica(own.slice(0, 3)).summary())).toBe(false);
  });

  it('counts a branch the device has never seen', () => {
    const split = branchFrom(own[5]!, 1, 'signed before the crash');
    const peer = replica([...own, ...split]).summary();
    expect(replica(own).behind(holder.publicKey, peer)).toBe(true);
  });

  it('makes the accidental fork visible on every replica once both halves meet', () => {
    const device = replica(own.slice(0, 6));
    const resumed = new Author(holder, device).emit('task.released', note('signed after restore'), 1);
    const peer = replica(own);
    exchange(device, peer);
    expect(peer.forks().map((f) => f.seq)).toEqual([7]);
    expect(ids(peer.forks()[0]!.events).sort()).toEqual([own[6]!.id, resumed.id].sort());
    expect(fingerprint(device)).toEqual(fingerprint(peer));
  });

  it('never throws on a junk summary', () => {
    const log = replica(own);
    fc.assert(
      fc.property(fc.anything(), fc.anything(), (heads, branches) => {
        log.behind(holder.publicKey, { mission: MISSION, heads, branches } as never);
        log.behind(holder.publicKey, { mission: MISSION, heads: { [holder.publicKey]: heads }, branches: { [holder.publicKey]: branches } } as never);
      }),
    );
  });
});
