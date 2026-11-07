import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createEvent, EventLog, MAX_WAITING_PER_ACTOR, type AnyEvent, type KeyPair } from '../src/index.ts';
import { fingerprint, ids, isCausal, MISSION, note, playHistory, seededKeys, type Step } from './helpers.ts';

const DEVICES = 4;

const step: fc.Arbitrary<Step> = fc.oneof(
  { weight: 3, arbitrary: fc.nat(DEVICES - 1).map((device): Step => ({ kind: 'emit', device })) },
  {
    weight: 2,
    arbitrary: fc
      .record({ from: fc.nat(DEVICES - 1), to: fc.nat(DEVICES - 1) })
      .map((s): Step => ({ kind: 'sync', ...s })),
  },
);
const steps = fc.array(step, { minLength: 1, maxLength: 40 });

/** Devices 0 and 1 share an identity, so they equivocate whenever they write unsynced. */
const clone = (device: number): number => (device === 1 ? 0 : device);

function chain(keys: KeyPair, length: number, label = 'e'): AnyEvent[] {
  const events: AnyEvent[] = [];
  for (let seq = 1; seq <= length; seq++) {
    const prev = events.at(-1)?.id ?? null;
    events.push(event(keys, seq, prev, seq, `${label}${seq}`));
  }
  return events;
}

function event(keys: KeyPair, seq: number, prev: string | null, lamport: number, reason: string, parents: string[] = []) {
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

function replicaOf(events: AnyEvent[]): EventLog {
  const log = new EventLog(MISSION);
  log.ingestMany(events);
  return log;
}

const alice = seededKeys(10);
const bob = seededKeys(11);

describe('ingest', () => {
  it('reports added, then duplicate, and changes nothing the second time', () => {
    const [first] = chain(alice, 1);
    const log = new EventLog(MISSION);
    expect(log.ingest(first!)).toBe('added');
    const before = fingerprint(log);
    expect(log.ingest(first!)).toBe('duplicate');
    expect(log.ingest(structuredClone(first!))).toBe('duplicate');
    expect(fingerprint(log)).toEqual(before);
    expect(log.size).toBe(1);
  });

  it('is idempotent under any amount of redelivery', () => {
    fc.assert(
      fc.property(steps, fc.array(fc.nat(), { maxLength: 80 }), (plan, repeats) => {
        const { events } = playHistory(DEVICES, plan);
        const once = replicaOf(events);
        const noisy = new EventLog(MISSION);
        for (const e of events) noisy.ingest(e);
        for (const pick of repeats) if (events.length) noisy.ingest(events[pick % events.length]!);
        noisy.ingestMany(events);
        expect(fingerprint(noisy)).toEqual(fingerprint(once));
        expect(noisy.size).toBe(events.length);
        expect(events.every((e) => noisy.ingest(e) === 'duplicate')).toBe(true);
      }),
      { numRuns: 60 },
    );
  });

  it('refuses invalid events without leaving a trace', () => {
    const [first, second] = chain(alice, 2);
    const log = new EventLog(MISSION);
    const forged = { ...first!, body: note('forged') } as AnyEvent;
    expect(log.ingest(forged)).toBe('invalid');
    expect(log.has(first!.id)).toBe(false);
    expect(log.size).toBe(0);
    expect(log.ingest(first!)).toBe('added');
    expect(log.ingest(second!)).toBe('added');
  });

  it('calls a tampered copy of a held event invalid, not duplicate', () => {
    const [first] = chain(alice, 1);
    const log = replicaOf([first!]);
    expect(log.ingest({ ...first!, body: note('forged') } as AnyEvent)).toBe('invalid');
    expect(log.ingest({ ...first!, sig: chain(bob, 1)[0]!.sig } as AnyEvent)).toBe('invalid');
    expect(log.get(first!.id)).toBe(first);
  });

  it('refuses events from another mission and junk off the wire', () => {
    const foreign = createEvent({
      keys: alice,
      mission: 'other-mission',
      seq: 1,
      prev: null,
      parents: [],
      lamport: 1,
      wall: 1,
      type: 'task.released',
      body: note('x'),
    }) as unknown as AnyEvent;
    const log = new EventLog(MISSION);
    expect(log.ingest(foreign)).toBe('invalid');
    for (const junk of [null, undefined, 1, 'x', {}, []]) expect(log.ingest(junk as unknown as AnyEvent)).toBe('invalid');
    const result = log.ingestMany([null as unknown as AnyEvent, foreign]);
    expect(result.invalid).toHaveLength(2);
    expect(log.size).toBe(0);
  });

  it('refuses a broken chain: wrong seq or another actor as prev', () => {
    const [first] = chain(alice, 1);
    const [other] = chain(bob, 1);
    const log = replicaOf([first!, other!]);
    expect(log.ingest(event(alice, 5, first!.id, 5, 'skips ahead'))).toBe('invalid');
    expect(log.ingest(event(alice, 2, other!.id, 5, 'wrong actor'))).toBe('invalid');
    expect(log.forks()).toEqual([]);
    expect(log.size).toBe(2);
  });

  it('drops a buffered event once its prev shows the chain is broken, in any order', () => {
    const [first] = chain(alice, 1);
    const broken = event(alice, 5, first!.id, 5, 'skips ahead');
    const early = new EventLog(MISSION);
    expect(early.ingest(broken)).toBe('gap');
    const result = early.ingestMany([first!]);
    expect(ids(result.invalid)).toEqual([broken.id]);
    expect(ids(result.added)).toEqual([first!.id]);
    expect(early.pending).toBe(0);
    const late = replicaOf([first!]);
    expect(late.ingest(broken)).toBe('invalid');
    expect(fingerprint(early)).toEqual(fingerprint(late));
  });

  it('lets a broken event undo a fork it only appeared to prove', () => {
    const [first, second] = chain(alice, 2);
    const broken = event(alice, 2, second!.id, 5, 'wrong link');
    const log = replicaOf([first!]);
    expect(log.ingest(broken)).toBe('gap');
    expect(log.ingest(second!)).toBe('fork');
    expect(log.forks()).toEqual([]);
    expect(log.pending).toBe(0);
    expect(fingerprint(log)).toEqual(fingerprint(replicaOf([first!, second!])));
  });
});

describe('gap buffering', () => {
  it('holds events back until the chain fills, then releases them in order', () => {
    const events = chain(alice, 4);
    const log = new EventLog(MISSION);
    expect(log.ingest(events[3]!)).toBe('gap');
    expect(log.ingest(events[3]!)).toBe('gap');
    expect(log.ingest(events[1]!)).toBe('gap');
    expect(log.ingest(events[2]!)).toBe('gap');
    expect(log.size).toBe(0);
    expect(log.pending).toBe(3);
    expect(log.has(events[3]!.id)).toBe(false);
    expect(log.summary().heads).toEqual({});
    expect(log.ingest(events[0]!)).toBe('added');
    expect(log.size).toBe(4);
    expect(log.pending).toBe(0);
    expect(ids(log.all())).toEqual(ids(events));
  });

  it('waits for causal parents from other actors', () => {
    const [cause] = chain(alice, 1);
    const effect = event(bob, 1, null, 2, 'reaction', [cause!.id]);
    const log = new EventLog(MISSION);
    expect(log.ingest(effect)).toBe('gap');
    expect(log.all()).toEqual([]);
    expect(log.ingest(cause!)).toBe('added');
    expect(ids(log.all())).toEqual([cause!.id, effect.id]);
  });

  it('waits for every parent, not just the first to arrive', () => {
    const [a] = chain(alice, 1);
    const [b] = chain(bob, 1);
    const joined = event(seededKeys(12), 1, null, 2, 'joined', [a!.id, b!.id]);
    const log = new EventLog(MISSION);
    log.ingest(joined);
    log.ingest(b!);
    expect(log.has(joined.id)).toBe(false);
    log.ingest(a!);
    expect(log.has(joined.id)).toBe(true);
  });

  it('reports released events from ingestMany in causal order, and counts what still waits', () => {
    const events = chain(alice, 5);
    const log = new EventLog(MISSION);
    const first = log.ingestMany([events[4]!, events[2]!, events[1]!]);
    expect(first).toMatchObject({ added: [], duplicates: 0, gaps: 3, invalid: [], forks: [] });
    const second = log.ingestMany([events[3]!, events[0]!, events[0]!]);
    expect(isCausal(second.added)).toBe(true);
    expect(ids(second.added).sort()).toEqual(ids(events).sort());
    expect(second).toMatchObject({ duplicates: 1, gaps: 0 });
  });

  it('releases a long chain delivered backwards', () => {
    const events = chain(alice, MAX_WAITING_PER_ACTOR + 1);
    const log = new EventLog(MISSION);
    for (let i = events.length - 1; i > 0; i--) log.ingest(events[i]!);
    expect(log.size).toBe(0);
    log.ingest(events[0]!);
    expect(log.size).toBe(events.length);
    expect(ids(log.all())).toEqual(ids(events));
  });
});

describe('order', () => {
  it('sorts concurrent events by lamport, then actor, then seq', () => {
    const a = chain(alice, 3);
    const b = chain(bob, 3);
    const order = replicaOf([...b, ...a]).all();
    const key = (e: AnyEvent) => [e.lamport, e.actor, e.seq];
    expect(order.map(key)).toEqual([...a, ...b].map(key).sort((x, y) => {
      return (x[0] as number) - (y[0] as number) || (x[1]! < y[1]! ? -1 : 1);
    }));
  });

  it('hands out a copy, so callers cannot disturb the log', () => {
    const log = replicaOf(chain(alice, 3));
    log.all().reverse();
    log.all().pop();
    expect(log.all()).toHaveLength(3);
    expect(isCausal(log.all())).toBe(true);
  });

  it('lists events per actor and tracks the causal frontier', () => {
    const a = chain(alice, 2);
    const b = chain(bob, 1);
    const log = replicaOf([...a, ...b]);
    expect(ids(log.byActor(alice.publicKey))).toEqual(ids(a));
    expect(log.byActor('nobody')).toEqual([]);
    expect(log.heads()).toEqual([a[1]!.id, b[0]!.id].sort());
    const merged = event(bob, 2, b[0]!.id, 3, 'saw alice', [a[1]!.id]);
    log.ingest(merged);
    expect(log.heads()).toEqual([merged.id]);
    expect(log.lamport()).toBe(3);
  });
});

describe('convergence', () => {
  it('reaches one identical state from any delivery order', () => {
    fc.assert(
      fc.property(
        steps.chain((plan) => {
          const { events } = playHistory(DEVICES, plan);
          return fc.tuple(fc.constant(events), fc.shuffledSubarray(events, { minLength: events.length }), fc.shuffledSubarray(events, { minLength: events.length }));
        }),
        ([events, shuffledA, shuffledB]) => {
          const a = replicaOf(shuffledA);
          const b = new EventLog(MISSION);
          for (const e of shuffledB) b.ingest(e);
          expect(fingerprint(a)).toEqual(fingerprint(b));
          expect(a.pending).toBe(0);
          expect(a.size).toBe(events.length);
          expect(isCausal(a.all())).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('matches the (lamport, actor, seq) order for honest histories', () => {
    fc.assert(
      fc.property(steps, (plan) => {
        const order = replicaOf(playHistory(DEVICES, plan).events).all();
        for (let i = 1; i < order.length; i++) {
          const [a, b] = [order[i - 1]!, order[i]!];
          const rising = a.lamport < b.lamport || (a.lamport === b.lamport && (a.actor < b.actor || (a.actor === b.actor && a.seq < b.seq)));
          expect(rising).toBe(true);
        }
      }),
      { numRuns: 60 },
    );
  });

  it('reaches one identical state from partial deliveries interleaved with reads', () => {
    fc.assert(
      fc.property(
        steps.chain((plan) => {
          const { events } = playHistory(DEVICES, plan, clone);
          return fc.tuple(fc.constant(events), fc.shuffledSubarray(events, { minLength: events.length }));
        }),
        ([events, shuffled]) => {
          const reading = new EventLog(MISSION);
          for (const e of shuffled) {
            reading.ingest(e);
            expect(isCausal(reading.all())).toBe(true);
          }
          expect(fingerprint(reading)).toEqual(fingerprint(replicaOf(events)));
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe('forks', () => {
  function forked() {
    const [root] = chain(alice, 1);
    return {
      root: root!,
      left: event(alice, 2, root!.id, 2, 'gave the chair to medics'),
      right: event(alice, 2, root!.id, 2, 'gave the chair to access'),
    };
  }

  it('records both events, returns fork, and overwrites nothing', () => {
    const { root, left, right } = forked();
    const log = replicaOf([root, left]);
    expect(log.forks()).toEqual([]);
    expect(log.ingest(right)).toBe('fork');
    expect(log.get(left.id)).toBe(left);
    expect(log.get(right.id)).toBe(right);
    expect(log.size).toBe(3);
    expect(ids(log.all()).sort()).toEqual(ids([root, left, right]).sort());
    expect(log.forks()).toEqual([
      { actor: alice.publicKey, seq: 2, events: [left, right].sort((a, b) => (a.id < b.id ? -1 : 1)) },
    ]);
  });

  it('is idempotent and independent of arrival order', () => {
    const { root, left, right } = forked();
    const a = replicaOf([root, left, right]);
    const b = replicaOf([right, left, root]);
    expect(a.ingest(right)).toBe('duplicate');
    expect(a.ingest(left)).toBe('duplicate');
    expect(a.forks()).toHaveLength(1);
    expect(fingerprint(a)).toEqual(fingerprint(b));
  });

  it('treats three conflicting events at one seq as one fork', () => {
    const { root, left, right } = forked();
    const third = event(alice, 2, root.id, 2, 'kept the chair');
    const log = replicaOf([root, left, right]);
    expect(log.ingest(third)).toBe('fork');
    expect(log.forks()).toHaveLength(1);
    expect(log.forks()[0]!.events).toHaveLength(3);
  });

  it('detects a fork at seq 1', () => {
    const a = event(alice, 1, null, 1, 'one');
    const b = event(alice, 1, null, 1, 'other');
    const log = replicaOf([a]);
    expect(log.ingest(b)).toBe('fork');
  });

  it('keeps growing both branches and flags each conflicting seq', () => {
    const { root, left, right } = forked();
    const leftNext = event(alice, 3, left.id, 3, 'left continues');
    const rightNext = event(alice, 3, right.id, 3, 'right continues');
    const rightOnly = event(alice, 4, rightNext.id, 4, 'right alone');
    const log = replicaOf([root, left, right]);
    expect(log.ingest(leftNext)).toBe('added');
    expect(log.ingest(rightNext)).toBe('fork');
    expect(log.ingest(rightOnly)).toBe('added');
    expect(log.forks().map((f) => f.seq)).toEqual([2, 3]);
    expect(log.head(alice.publicKey)).toEqual({ seq: 4, id: rightOnly.id });
    expect(log.summary().branches).toEqual({ [alice.publicKey]: [leftNext.id] });
    expect(isCausal(log.all())).toBe(true);
  });

  it('flags an equivocation at once, even when the event cannot be placed yet', () => {
    const events = chain(alice, 3);
    const hiddenBranch = event(alice, 3, 'never-delivered', 3, 'hidden branch');
    const log = replicaOf(events);
    expect(log.ingest(hiddenBranch)).toBe('fork');
    expect(log.has(hiddenBranch.id)).toBe(false);
    expect(log.pending).toBe(1);
    expect(log.forks()[0]).toMatchObject({ seq: 3 });
    expect(log.forks()[0]!.events).toContain(hiddenBranch);
    expect(log.ingest(hiddenBranch)).toBe('gap');
    expect(log.forks()).toHaveLength(1);

    const result = replicaOf(events).ingestMany([hiddenBranch]);
    expect(result.forks).toEqual([hiddenBranch]);
    expect(result.added).toEqual([]);
    expect(result.gaps).toBe(1);
  });

  it('reports a fork branch in both added and forks, so consumers cannot miss it', () => {
    const { root, left, right } = forked();
    const result = replicaOf([root, left]).ingestMany([right]);
    expect(result.added).toEqual([right]);
    expect(result.forks).toEqual([right]);
  });

  it('agrees on forks across replicas for arbitrary equivocating histories', () => {
    fc.assert(
      fc.property(
        steps.chain((plan) => {
          const { events } = playHistory(DEVICES, plan, clone);
          return fc.tuple(fc.constant(events), fc.shuffledSubarray(events, { minLength: events.length }));
        }),
        ([events, shuffled]) => {
          const a = replicaOf(events);
          const b = replicaOf(shuffled);
          expect(fingerprint(a)).toEqual(fingerprint(b));
          expect(a.size).toBe(events.length);
          const slots = new Map<string, Set<string>>();
          for (const e of events) {
            const key = `${e.actor}:${e.seq}`;
            slots.set(key, (slots.get(key) ?? new Set()).add(e.id));
          }
          expect(a.forks()).toHaveLength([...slots.values()].filter((s) => s.size > 1).length);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('summary and delta', () => {
  it('summarises the highest placed event per actor', () => {
    const a = chain(alice, 3);
    const b = chain(bob, 1);
    const log = replicaOf([...a, ...b]);
    expect(log.summary()).toEqual({
      mission: MISSION,
      heads: { [alice.publicKey]: { seq: 3, id: a[2]!.id }, [bob.publicKey]: { seq: 1, id: b[0]!.id } },
    });
    expect(new EventLog(MISSION).summary()).toEqual({ mission: MISSION, heads: {} });
  });

  it('sends everything to an empty remote and nothing to an equal one', () => {
    const events = chain(alice, 3);
    const log = replicaOf(events);
    expect(ids(log.missingFor(new EventLog(MISSION).summary()))).toEqual(ids(events));
    expect(log.missingFor(log.summary())).toEqual([]);
  });

  it('sends nothing to another mission', () => {
    const log = replicaOf(chain(alice, 2));
    expect(log.missingFor(new EventLog('other').summary())).toEqual([]);
  });

  it('sends nothing for an actor the remote is ahead on', () => {
    const events = chain(alice, 5);
    const behind = replicaOf(events.slice(0, 2));
    const ahead = replicaOf(events);
    expect(behind.missingFor(ahead.summary())).toEqual([]);
    expect(ids(ahead.missingFor(behind.summary()))).toEqual(ids(events.slice(2)));
  });

  it('computes the exact difference between any two honest replicas', () => {
    fc.assert(
      fc.property(steps, fc.nat(DEVICES - 1), fc.nat(DEVICES - 1), (plan, i, j) => {
        const { logs } = playHistory(DEVICES, plan);
        const [local, remote] = [logs[i]!, logs[j]!];
        const delta = local.missingFor(remote.summary());
        const expected = local.all().filter((e) => !remote.has(e.id));
        expect(ids(delta)).toEqual(ids(expected));
      }),
      { numRuns: 100 },
    );
  });

  it('produces a delta that applies with no gaps, whole or as any prefix', () => {
    fc.assert(
      fc.property(steps, fc.nat(DEVICES - 1), fc.nat(DEVICES - 1), fc.nat(), (plan, i, j, cut) => {
        const { logs } = playHistory(DEVICES, plan);
        const [local, remote] = [logs[i]!, logs[j]!];
        const delta = local.missingFor(remote.summary());
        const prefix = delta.slice(0, delta.length ? cut % (delta.length + 1) : 0);
        const receiver = replicaOf(remote.all());
        for (const e of prefix) expect(receiver.ingest(e)).toBe('added');
        expect(receiver.pending).toBe(0);
        for (const e of delta.slice(prefix.length)) expect(receiver.ingest(e)).toBe('added');
        expect(receiver.missingFor(local.summary())).toEqual(remote.missingFor(local.summary()));
      }),
      { numRuns: 100 },
    );
  });

  it('survives a wire round trip of the summary', () => {
    const { logs } = playHistory(2, [
      { kind: 'emit', device: 0 },
      { kind: 'sync', from: 0, to: 1 },
      { kind: 'emit', device: 1 },
    ]);
    const wire = JSON.parse(JSON.stringify(logs[1]!.summary()));
    expect(logs[0]!.missingFor(wire)).toEqual([]);
    expect(logs[1]!.missingFor(JSON.parse(JSON.stringify(logs[0]!.summary())))).toHaveLength(1);
  });

  it('tolerates a summary with unknown actors', () => {
    const log = replicaOf(chain(alice, 1));
    const summary = { mission: MISSION, heads: { stranger: { seq: 9, id: 'nope' } } };
    expect(log.missingFor(summary)).toHaveLength(1);
  });

  function exchange(a: EventLog, b: EventLog): void {
    b.ingestMany(a.missingFor(b.summary()));
    a.ingestMany(b.missingFor(a.summary()));
  }

  it('converges two honest replicas in one exchange, with nothing left waiting', () => {
    fc.assert(
      fc.property(steps, fc.nat(DEVICES - 1), fc.nat(DEVICES - 1), (plan, i, j) => {
        const { logs } = playHistory(DEVICES, plan);
        const [a, b] = [logs[i]!, logs[j]!];
        exchange(a, b);
        expect(fingerprint(a)).toEqual(fingerprint(b));
        expect(a.pending + b.pending).toBe(0);
      }),
      { numRuns: 100 },
    );
  });

  it('converges two replicas with two exchanges, forks included, then goes quiet', () => {
    fc.assert(
      fc.property(steps, fc.nat(DEVICES - 1), fc.nat(DEVICES - 1), (plan, i, j) => {
        const { logs } = playHistory(DEVICES, plan, clone);
        const [a, b] = [logs[i]!, logs[j]!];
        exchange(a, b);
        exchange(a, b);
        expect(fingerprint(a)).toEqual(fingerprint(b));
        expect(a.missingFor(b.summary())).toEqual([]);
        expect(b.missingFor(a.summary())).toEqual([]);
      }),
      { numRuns: 150 },
    );
  });

  it('closes a gap left by a fork as soon as a holder of the dependency is met', () => {
    const { logs } = playHistory(
      DEVICES,
      [
        { kind: 'emit', device: 0 },
        { kind: 'sync', from: 0, to: 3 },
        { kind: 'emit', device: 1 },
        { kind: 'emit', device: 3 },
        { kind: 'emit', device: 1 },
        { kind: 'sync', from: 3, to: 1 },
      ],
      clone,
    );
    const [, forked, bystander, holder] = logs as [EventLog, EventLog, EventLog, EventLog];
    expect(forked.pending).toBe(1);
    exchange(forked, bystander);
    expect(forked.pending).toBe(1);
    exchange(forked, holder);
    expect(forked.pending).toBe(0);
    expect(fingerprint(forked)).toEqual(fingerprint(holder));
  });

  it('spreads every fork to every replica through pairwise anti-entropy alone', () => {
    fc.assert(
      fc.property(steps, (plan) => {
        const { logs, events } = playHistory(DEVICES, plan, clone);
        for (let round = 0; round < 3; round++) {
          for (const a of logs) for (const b of logs) if (a !== b) exchange(a, b);
        }
        const reference = fingerprint(replicaOf(events));
        for (const log of logs) {
          expect(fingerprint(log)).toEqual(reference);
          expect(log.pending).toBe(0);
        }
      }),
      { numRuns: 60 },
    );
  });

  it('moves a fork between replicas that each hold one branch', () => {
    const [root] = chain(alice, 1);
    const left = event(alice, 2, root!.id, 2, 'left');
    const right = event(alice, 2, root!.id, 2, 'right');
    const a = replicaOf([root!, left]);
    const b = replicaOf([root!, right]);
    expect(ids(a.missingFor(b.summary()))).toContain(left.id);
    expect(ids(b.missingFor(a.summary()))).toContain(right.id);
    exchange(a, b);
    expect(a.forks()).toHaveLength(1);
    expect(fingerprint(a)).toEqual(fingerprint(b));
    expect(a.missingFor(b.summary())).toEqual([]);
  });

  it('without branch hints, resends only the unproven branch, which is a harmless duplicate', () => {
    const [root] = chain(alice, 1);
    const left = event(alice, 2, root!.id, 2, 'left');
    const right = event(alice, 2, root!.id, 2, 'right');
    const a = replicaOf([root!, left, right]);
    const b = replicaOf([root!, left, right]);
    const { mission, heads } = b.summary();
    const resent = a.missingFor({ mission, heads });
    expect(resent).toHaveLength(1);
    expect(b.ingestMany(resent)).toMatchObject({ added: [], duplicates: 1 });
  });

  it('never throws on a malformed summary', () => {
    const log = replicaOf(chain(alice, 2));
    fc.assert(
      fc.property(fc.anything(), fc.anything(), (heads, branches) => {
        log.missingFor({ mission: MISSION, heads, branches } as never);
        log.missingFor({ mission: MISSION, heads: { [alice.publicKey]: heads }, branches: { [alice.publicKey]: branches } } as never);
        log.missingFor(heads as never);
      }),
    );
  });
});
