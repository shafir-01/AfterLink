import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { ActorId, AnyEvent, MissionState, TokenId } from '@afterlink/protocol';
import { auditRights, canCommit, conservation, findTokens, pendingTransfers } from '../src/index.ts';
import {
  ACCESS,
  CREW,
  Device,
  MEDICS,
  SUPPLY,
  allTokens,
  capsule,
  custodians,
  derive,
  exchange,
  expectLegalChain,
  stateOf,
  token,
} from './helpers.ts';

const RUNS = 200;

/** What a replica must be able to say about itself at every moment, whatever it has seen. */
function expectBalanced(state: MissionState): void {
  expect(Object.keys(state.tokens).sort()).toEqual([...allTokens].sort());
  for (const row of conservation(state)) expect(row.committed + row.held + row.inTransit + row.disputed).toBe(row.issued);
}

type Step =
  | { kind: 'commit'; who: number; pick: number; n: number }
  | { kind: 'offer'; who: number; pick: number; n: number; to: number }
  | { kind: 'answer'; who: number; pick: number; yes: boolean }
  | { kind: 'release'; who: number; pick: number }
  | { kind: 'split'; mask: number }
  | { kind: 'heal' }
  | { kind: 'gossip'; a: number; b: number }
  | { kind: 'ferry'; from: number; to: number; keep: number };

type Attack =
  | { kind: 'twin'; who: number }
  | { kind: 'rogue'; who: number; move: 'commit' | 'offer' | 'accept' | 'decline' | 'release'; token: number; to: number; ref: number };

/** Wraps around the devices in play, so a second device on one key gets its turn. */
const who = fc.nat({ max: 2 * CREW.length - 1 });
const tokenPick = fc.nat({ max: allTokens.length });

const step: fc.Arbitrary<Step> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('commit' as const), who, pick: fc.nat(), n: fc.integer({ min: 1, max: 2 }) }) },
  { weight: 5, arbitrary: fc.record({ kind: fc.constant('offer' as const), who, pick: fc.nat(), n: fc.integer({ min: 1, max: 2 }), to: who }) },
  { weight: 5, arbitrary: fc.record({ kind: fc.constant('answer' as const), who, pick: fc.nat(), yes: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('release' as const), who, pick: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('split' as const), mask: fc.nat({ max: 15 }) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('heal' as const) }) },
  { weight: 6, arbitrary: fc.record({ kind: fc.constant('gossip' as const), a: who, b: who }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('ferry' as const), from: who, to: who, keep: fc.nat() }) },
);

const attack: fc.Arbitrary<Attack> = fc.oneof(
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('twin' as const), who }) },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant('rogue' as const),
      who,
      move: fc.constantFrom('commit' as const, 'offer' as const, 'accept' as const, 'decline' as const, 'release' as const),
      token: tokenPick,
      to: who,
      ref: fc.nat({ max: 12 }),
    }),
  },
);

const schedule = fc.array(step, { minLength: 10, maxLength: 80, size: 'max' });
const hostileSchedule = fc.array(fc.oneof({ weight: 4, arbitrary: step }, { weight: 1, arbitrary: attack }), { minLength: 10, maxLength: 80, size: 'max' });

/**
 * Four actors under a random schedule. Honest steps act only on the device's own view, gossip
 * respects the current partition, ferries cross it and may carry only part of a log. Attacks are
 * what no honest device would do: a second device on one key, or a signature on any move at all.
 */
function run(steps: (Step | Attack)[], after: (devices: Device[]) => void = () => {}, clock?: () => number) {
  const devices = CREW.map((id) => new Device(id, clock));
  const side = new Map(CREW.map((id) => [id, 0]));
  let transfers = 0;
  const held = (d: Device) => {
    const view = d.state();
    return allTokens.filter((t) => view.tokens[t]?.state === 'held' && view.tokens[t]?.holder === d.actor);
  };
  const pick = (i: number) => devices[i % devices.length]!;

  for (const s of steps) {
    switch (s.kind) {
      case 'commit': {
        const d = pick(s.who);
        const mine = held(d);
        if (mine.length === 0) break;
        const start = s.pick % mine.length;
        const tokens = mine.slice(start, start + s.n);
        expect(canCommit(d.state(), d.actor, tokens)).toEqual({ ok: true });
        d.commit(tokens, `task-${s.pick % 5}`);
        break;
      }
      case 'offer': {
        const d = pick(s.who);
        const to = CREW[s.to % CREW.length]!;
        if (to === d.actor) break;
        const mine = held(d);
        if (mine.length === 0) break;
        const start = s.pick % mine.length;
        transfers += 1;
        d.offer(mine.slice(start, start + s.n), to, `transfer-${transfers}`);
        break;
      }
      case 'answer': {
        const d = pick(s.who);
        const pending = pendingTransfers(d.state(), d.actor);
        if (pending.length === 0) break;
        const { transfer } = pending[s.pick % pending.length]!;
        if (s.yes) d.accept(transfer);
        else d.decline(transfer);
        break;
      }
      case 'release': {
        const d = pick(s.who);
        const committed = Object.values(d.state().tokens).filter((t) => t.state === 'committed' && t.holder === d.actor);
        if (committed.length === 0) break;
        d.emit('task.released', { taskId: committed[s.pick % committed.length]!.committedTo!, reason: 'no longer needed' });
        break;
      }
      case 'split':
        CREW.forEach((id, i) => side.set(id, (s.mask >> i) & 1));
        break;
      case 'heal':
        CREW.forEach((id) => side.set(id, 0));
        break;
      case 'gossip': {
        const [a, b] = [pick(s.a), pick(s.b)];
        if (side.get(a.actor) === side.get(b.actor)) exchange(a, b);
        break;
      }
      case 'ferry': {
        const log = pick(s.from).all();
        pick(s.to).receive(log.slice(0, s.keep % (log.length + 1)));
        break;
      }
      case 'twin':
        devices.push(pick(s.who).clone());
        break;
      case 'rogue': {
        const d = pick(s.who);
        const id = allTokens[s.token % allTokens.length]!;
        const ref = `transfer-${Math.max(1, transfers - s.ref)}`;
        if (s.move === 'commit') d.commit([id], `task-${s.ref % 5}`);
        else if (s.move === 'release') d.emit('task.released', { taskId: `task-${s.ref % 5}`, reason: 'rogue' });
        else if (s.move === 'offer') {
          transfers += 1;
          d.offer([id], CREW[s.to % CREW.length]!, `transfer-${transfers}`);
        } else if (s.move === 'accept') d.accept(ref);
        else d.decline(ref);
        break;
      }
    }
    after(devices);
  }
  return devices;
}

function union(devices: Device[]): AnyEvent[] {
  return [...new Map(devices.flatMap((d) => d.all()).map((e) => [e.id, e])).values()];
}

function resourceOf(id: TokenId): string {
  return capsule.resources.find((r) => r.tokens.some((t) => t.id === id))!.id;
}

/** Which actors, each trusting only its own view, believe they may spend this token right now. */
function spenders(devices: Device[], id: TokenId): ActorId[] {
  return devices.filter((d) => findTokens(d.state(), d.actor, resourceOf(id), 99).includes(id)).map((d) => d.actor);
}

function shuffled<T>(list: T[], noise: fc.Stream<number>): T[] {
  return list.map((e) => ({ e, k: noise.next().value as number })).sort((a, b) => a.k - b.k).map((x) => x.e);
}

function outcome(events: AnyEvent[]) {
  return Object.values(derive(events).tokens).map((t) => ({ id: t.id, state: t.state, holder: t.holder, committedTo: t.committedTo }));
}

describe('the schedules', () => {
  it('reach the states the properties below are about', () => {
    const seen = { committed: 0, inTransit: 0, moved: 0, returned: 0, released: 0, splitViews: 0, stuckAtEnd: 0 };
    for (const steps of fc.sample(schedule, { numRuns: 200, seed: 1 })) {
      const devices = run(steps, (ds) => {
        if (new Set(ds.map((d) => JSON.stringify(d.derived().tokens))).size > 1) seen.splitViews += 1;
      });
      const events = union(devices);
      const merged = Object.values(derive(events).tokens);
      seen.committed += merged.filter((t) => t.state === 'committed').length;
      seen.inTransit += merged.filter((t) => t.state === 'in-transit').length;
      seen.moved += events.filter((e) => e.type === 'right.accepted').length;
      seen.returned += events.filter((e) => e.type === 'right.declined').length;
      seen.released += events.filter((e) => e.type === 'task.released').length;
      seen.stuckAtEnd += merged.some((t) => t.state === 'in-transit') ? 1 : 0;
    }
    for (const [name, count] of Object.entries(seen)) expect(count, name).toBeGreaterThan(50);
  });

  it('reach forks, disputes and rejected moves when hostile', () => {
    const seen = { forkedRuns: 0, disputed: 0, overspent: 0, forged: 0, affected: 0 };
    for (const steps of fc.sample(hostileSchedule, { numRuns: 200, seed: 1 })) {
      const { tokens, violations } = derive(union(run(steps)));
      const list = Object.values(tokens);
      seen.forkedRuns += list.some((t) => t.state === 'disputed') ? 1 : 0;
      seen.disputed += list.filter((t) => t.state === 'disputed').length;
      seen.overspent += list.filter((t) => t.overspent).length;
      seen.affected += list.filter((t) => t.affected?.length).length;
      seen.forged += violations.filter((v) => v.kind === 'forged-event').length;
    }
    for (const [name, count] of Object.entries(seen)) expect(count, name).toBeGreaterThan(20);
  });
});

describe('honest crews across partitions', () => {
  it('never mint a right, on any replica, at any moment', () => {
    fc.assert(
      fc.property(schedule, (steps) => {
        const devices = run(steps, (ds) => ds.forEach((d) => expect(conservation(d.state()).every((r) => r.ok)).toBe(true)));
        expectBalanced(stateOf(derive(union(devices))));
      }),
      { numRuns: RUNS },
    );
  });

  it('never let two actors believe they may spend the same token', () => {
    fc.assert(
      fc.property(schedule, (steps) => {
        run(steps, (ds) => {
          for (const id of allTokens) expect(spenders(ds, id).length).toBeLessThanOrEqual(1);
        });
      }),
      { numRuns: RUNS },
    );
  });

  it('merge with no violations, every chain legal, and an audit that agrees', () => {
    fc.assert(
      fc.property(schedule, (steps) => {
        const events = union(run(steps));
        const merged = derive(events);
        expect(merged.violations).toEqual([]);
        const byId = new Map(events.map((e) => [e.id, e]));
        for (const t of Object.values(merged.tokens)) {
          expect(t.state).not.toBe('disputed');
          expectLegalChain(t, byId);
        }
        expect(auditRights(capsule, events, custodians).filter((r) => !r.ok)).toEqual([]);
      }),
      { numRuns: RUNS },
    );
  });

  it('never commit a token twice in a valid history', () => {
    fc.assert(
      fc.property(schedule, (steps) => {
        const events = union(run(steps));
        const byId = new Map(events.map((e) => [e.id, e]));
        for (const t of Object.values(derive(events).tokens)) {
          const types = t.chain.map((id) => byId.get(id)!.type);
          types.forEach((type, i) => {
            if (type === 'right.committed') expect(['task.released', undefined]).toContain(types[i + 1]);
          });
        }
      }),
      { numRuns: RUNS },
    );
  });
});

describe('forks', () => {
  it('leave a forked holder nothing to spend, whatever else happened first', () => {
    const spend = fc.constantFrom('commit' as const, 'offer' as const);
    fc.assert(
      fc.property(spend, spend, fc.nat({ max: 3 }), fc.nat({ max: 3 }), schedule, (left, right, warmL, warmR, prefix) => {
        const devices = run(prefix);
        exchange(...devices);
        const chair = token(devices[0]!.derived(), 'evac-chair#1');
        fc.pre(chair.state === 'held' && chair.holder !== null);
        const original = devices.find((d) => d.actor === chair.holder)!;
        const twin = original.clone();
        const other = CREW.find((a) => a !== original.actor)!;

        for (let i = 0; i < warmL; i += 1) original.note(`w${i}`);
        for (let i = 0; i < warmR; i += 1) twin.note(`v${i}`);
        const a = left === 'commit' ? original.commit(['evac-chair#1'], 'left') : original.offer(['evac-chair#1'], other, 'left');
        const b = right === 'commit' ? twin.commit(['evac-chair#1'], 'right') : twin.offer(['evac-chair#1'], other, 'right');

        const events = union([...devices, twin]);
        const merged = derive(events);
        const chairAfter = token(merged, 'evac-chair#1');
        expect(chairAfter).toMatchObject({ state: 'disputed', holder: null, overspent: true });
        expect(chairAfter.chain).not.toContain(a.id);
        expect(chairAfter.chain).not.toContain(b.id);

        const conflict = merged.violations.find((v) => v.kind === 'token-fork' && v.tokenId === 'evac-chair#1');
        expect(conflict, 'fork is reported').toBeDefined();
        expect(conflict!.severity).toBe('violation');
        expect(conflict!.events).toEqual(expect.arrayContaining([a.id, b.id]));
        expect(conservation(stateOf(merged)).find((r) => r.resource === 'evac-chair')!.ok).toBe(false);
        expect(derive([...events].reverse())).toEqual(merged);
      }),
      { numRuns: RUNS },
    );
  });
});

describe('lost acknowledgement', () => {
  it('never refunds, however much else the sender learns', () => {
    fc.assert(
      fc.property(schedule, fc.boolean(), (noise, yes) => {
        const sender = new Device(ACCESS);
        const recipient = new Device(MEDICS);
        sender.offer(['evac-chair#1'], MEDICS, 'held-up');
        exchange(sender, recipient);
        if (yes) recipient.accept('held-up');
        else recipient.decline('held-up');

        sender.receive(run(noise).flatMap((d) => d.all()).filter((e) => e.actor === SUPPLY));

        const view = sender.state();
        expect(view.tokens['evac-chair#1']).toMatchObject({ state: 'in-transit', holder: null });
        expect(canCommit(view, ACCESS, ['evac-chair#1'])).toMatchObject({ ok: false, code: 'TOKEN_IN_TRANSIT' });
        expect(findTokens(view, ACCESS, 'evac-chair', 1)).toEqual([]);
        expectBalanced(view);

        exchange(sender, recipient);
        expect(token(sender.derived(), 'evac-chair#1')).toMatchObject({ state: 'held', holder: yes ? MEDICS : ACCESS });
      }),
      { numRuns: RUNS },
    );
  });
});

describe('decline', () => {
  it('returns every token of the offer to the sender and nobody else', () => {
    fc.assert(
      fc.property(fc.subarray(['cart#1', 'cart#2'], { minLength: 1 }), fc.constantFrom(ACCESS, MEDICS), (tokens, to) => {
        const sender = new Device(SUPPLY);
        const recipient = new Device(to);
        sender.offer(tokens, to, 'x');
        exchange(sender, recipient);
        recipient.decline('x');
        exchange(sender, recipient);
        const view = sender.state();
        for (const id of tokens) expect(view.tokens[id]).toMatchObject({ state: 'held', holder: SUPPLY, holderTeam: 'supply' });
        expect(findTokens(view, to, 'cart', 9)).toEqual([]);
        expect(canCommit(view, SUPPLY, tokens)).toEqual({ ok: true });
      }),
      { numRuns: RUNS },
    );
  });
});

describe('hostile histories', () => {
  it('never mint a right, and every chain stays a legal replay', () => {
    fc.assert(
      fc.property(hostileSchedule, (steps) => {
        const events = union(run(steps));
        const derived = derive(events);
        expectBalanced(stateOf(derived));
        const byId = new Map(events.map((e) => [e.id, e]));
        for (const t of Object.values(derived.tokens)) expectLegalChain(t, byId);
      }),
      { numRuns: RUNS },
    );
  });

  it('commit no token twice', () => {
    fc.assert(
      fc.property(hostileSchedule, (steps) => {
        const events = union(run(steps));
        const byId = new Map(events.map((e) => [e.id, e]));
        for (const t of Object.values(derive(events).tokens)) {
          const types = t.chain.map((id) => byId.get(id)!.type);
          const open = types.reduce((n, type) => n + (type === 'right.committed' ? 1 : type === 'task.released' ? -1 : 0), 0);
          expect(open).toBeLessThanOrEqual(1);
          expect(open).toBe(t.state === 'committed' ? 1 : 0);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('let only the stated recipient move a token out of transit', () => {
    fc.assert(
      fc.property(hostileSchedule, (steps) => {
        const events = union(run(steps));
        const byId = new Map(events.map((e) => [e.id, e]));
        for (const t of Object.values(derive(events).tokens)) {
          t.chain.forEach((id, i) => {
            const e = byId.get(id)!;
            if (e.type !== 'right.offered') return;
            const next = t.chain[i + 1];
            if (next) expect(byId.get(next)!.actor).toBe(e.body.to);
          });
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('report every spend that changed nothing', () => {
    fc.assert(
      fc.property(hostileSchedule, (steps) => {
        const events = union(run(steps));
        const { tokens, violations } = derive(events);
        const used = new Set(Object.values(tokens).flatMap((t) => t.chain));
        const reported = new Set(violations.flatMap((v) => v.events));
        for (const e of events) {
          if (e.type === 'right.committed' || e.type === 'right.offered') expect(used.has(e.id) || reported.has(e.id)).toBe(true);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('never leave a spend by a forked actor past its fork standing', () => {
    fc.assert(
      fc.property(hostileSchedule, (steps) => {
        const events = union(run(steps));
        const slots = new Map<string, number>();
        for (const e of events) slots.set(`${e.actor} ${e.seq}`, (slots.get(`${e.actor} ${e.seq}`) ?? 0) + 1);
        const forkSeq = new Map<ActorId, number>();
        for (const [key, n] of slots) {
          if (n < 2) continue;
          const [actor, seq] = key.split(' ') as [string, string];
          forkSeq.set(actor, Math.min(forkSeq.get(actor) ?? Infinity, Number(seq)));
        }
        const used = new Set(Object.values(derive(events).tokens).flatMap((t) => t.chain));
        for (const e of events) {
          const fork = forkSeq.get(e.actor);
          if (fork !== undefined && e.seq >= fork && e.type.startsWith('right.')) expect(used.has(e.id)).toBe(false);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('are always caught by the audit when a token was committed twice', () => {
    fc.assert(
      fc.property(hostileSchedule, (steps) => {
        const events = union(run(steps));
        const audit = auditRights(capsule, events, custodians);
        for (const row of audit) {
          if (row.commits.length - row.released > 1) expect(row.ok).toBe(false);
        }
        const state = stateOf(derive(events));
        const unhappy = audit.filter((r) => !r.ok).map((r) => r.resource);
        for (const row of conservation(state, audit)) {
          if (unhappy.includes(row.resource)) expect(row.ok).toBe(false);
        }
      }),
      { numRuns: RUNS },
    );
  });
});

describe('replica independence', () => {
  it('gives every replica the same answer for the same events, in any order, with duplicates', () => {
    fc.assert(
      fc.property(hostileSchedule, fc.infiniteStream(fc.nat()), (steps, noise) => {
        const events = union(run(steps));
        const baseline = derive(events);
        const mixed = shuffled(events, noise);
        expect(derive(mixed)).toEqual(baseline);
        expect(derive([...mixed, ...events.slice(0, 5)])).toEqual(baseline);
      }),
      { numRuns: RUNS },
    );
  });

  it('settles replicas that gossip until they hold the same events', () => {
    fc.assert(
      fc.property(hostileSchedule, (steps) => {
        const devices = run(steps);
        exchange(...devices);
        const [first, ...rest] = devices.map((d) => d.derived());
        for (const view of rest) expect(view).toEqual(first);
      }),
      { numRuns: RUNS },
    );
  });

  it('decides nothing by a declared clock: any lamports give the same holders', () => {
    fc.assert(
      fc.property(hostileSchedule, fc.infiniteStream(fc.nat({ max: 1_000_000 })), (steps, clocks) => {
        const honest = outcome(union(run(steps)));
        const lying = outcome(union(run(steps, () => {}, () => clocks.next().value as number)));
        expect(lying).toEqual(honest);
      }),
      { numRuns: RUNS },
    );
  });
});
