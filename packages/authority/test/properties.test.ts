import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { ActorId, AnyEvent, EventId, MissionState, TokenId } from '@afterlink/protocol';
import { canCommit, conservation, findTokens, pendingTransfers } from '../src/index.ts';
import {
  ACCESS,
  CREW,
  Device,
  MEDICS,
  SUPPLY,
  allTokens,
  capsule,
  derive,
  exchange,
  expectLegalChain,
  stateOf,
  token,
} from './helpers.ts';

const RUNS = 300;

/** What a replica must be able to say about itself at every moment, whatever it has seen. */
function expectConserved(state: MissionState): void {
  const rows = conservation(state);
  expect(rows.every((r) => r.ok)).toBe(true);
  expect(Object.keys(state.tokens).sort()).toEqual([...allTokens].sort());
  for (const row of rows) expect(row.committed + row.held + row.inTransit).toBe(row.issued);
}

type Step =
  | { kind: 'commit'; who: number; pick: number; n: number }
  | { kind: 'offer'; who: number; pick: number; n: number; to: number }
  | { kind: 'answer'; who: number; pick: number; yes: boolean }
  | { kind: 'split'; mask: number }
  | { kind: 'heal' }
  | { kind: 'gossip'; a: number; b: number }
  | { kind: 'ferry'; from: number; to: number; keep: number };

const who = fc.nat({ max: CREW.length - 1 });
const step: fc.Arbitrary<Step> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('commit' as const), who, pick: fc.nat(), n: fc.integer({ min: 1, max: 2 }) }) },
  { weight: 5, arbitrary: fc.record({ kind: fc.constant('offer' as const), who, pick: fc.nat(), n: fc.integer({ min: 1, max: 2 }), to: who }) },
  { weight: 5, arbitrary: fc.record({ kind: fc.constant('answer' as const), who, pick: fc.nat(), yes: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('split' as const), mask: fc.nat({ max: 15 }) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('heal' as const) }) },
  { weight: 5, arbitrary: fc.record({ kind: fc.constant('gossip' as const), a: who, b: who }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('ferry' as const), from: who, to: who, keep: fc.nat() }) },
);

/**
 * Four honest actors under a random schedule. Each acts only on its own view. Gossip respects the
 * current partition and delivers everything; ferries cross it and may deliver only part of the log.
 */
function runCrew(steps: Step[], after: (devices: Device[]) => void) {
  const devices = CREW.map((id) => new Device(id));
  const side = new Map(CREW.map((id) => [id, 0]));
  let transfers = 0;

  for (const s of steps) {
    switch (s.kind) {
      case 'commit': {
        const d = devices[s.who]!;
        const view = d.state();
        const mine = allTokens.filter((t) => view.tokens[t]?.state === 'held' && view.tokens[t]?.holder === d.actor);
        if (mine.length === 0) break;
        const start = s.pick % mine.length;
        const tokens = mine.slice(start, start + s.n);
        expect(canCommit(view, d.actor, tokens)).toEqual({ ok: true });
        d.commit(tokens, `task-${s.pick}`);
        break;
      }
      case 'offer': {
        const d = devices[s.who]!;
        if (CREW[s.to] === d.actor) break;
        const view = d.state();
        const mine = allTokens.filter((t) => view.tokens[t]?.state === 'held' && view.tokens[t]?.holder === d.actor);
        if (mine.length === 0) break;
        const start = s.pick % mine.length;
        transfers += 1;
        d.offer(mine.slice(start, start + s.n), CREW[s.to]!, `transfer-${transfers}`);
        break;
      }
      case 'answer': {
        const d = devices[s.who]!;
        const pending = pendingTransfers(d.state(), d.actor);
        if (pending.length === 0) break;
        const { transfer } = pending[s.pick % pending.length]!;
        if (s.yes) d.accept(transfer);
        else d.decline(transfer);
        break;
      }
      case 'split':
        CREW.forEach((id, i) => side.set(id, (s.mask >> i) & 1));
        break;
      case 'heal':
        CREW.forEach((id) => side.set(id, 0));
        break;
      case 'gossip':
        if (side.get(CREW[s.a]!) === side.get(CREW[s.b]!)) exchange(devices[s.a]!, devices[s.b]!);
        break;
      case 'ferry': {
        const log = devices[s.from]!.all();
        devices[s.to]!.receive(log.slice(0, s.keep % (log.length + 1)));
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

/** Which actors, each trusting only its own view, believe they may spend this token right now. */
function spenders(devices: Device[], id: TokenId): ActorId[] {
  return devices.filter((d) => findTokens(d.state(), d.actor, capsule.resources.find((r) => r.tokens.some((t) => t.id === id))!.id, 99).includes(id)).map((d) => d.actor);
}

describe('the schedules', () => {
  it('reach the states the properties below are about', () => {
    const seen = { committed: 0, inTransit: 0, moved: 0, returned: 0, splitViews: 0, chairStuck: 0 };
    for (const steps of fc.sample(fc.array(step, { maxLength: 60 }), { numRuns: 300, seed: 1 })) {
      const devices = runCrew(steps, (ds) => {
        if (new Set(ds.map((d) => JSON.stringify(d.derived().tokens))).size > 1) seen.splitViews += 1;
      });
      const events = union(devices);
      const merged = Object.values(derive(events).tokens);
      seen.committed += merged.filter((t) => t.state === 'committed').length;
      seen.inTransit += merged.filter((t) => t.state === 'in-transit').length;
      seen.moved += events.filter((e) => e.type === 'right.accepted').length;
      seen.returned += events.filter((e) => e.type === 'right.declined').length;
      seen.chairStuck += devices.some((d) => d.derived().tokens['evac-chair#1']?.state === 'in-transit') ? 1 : 0;
    }
    console.info('schedule coverage', seen);
    for (const count of Object.values(seen)) expect(count).toBeGreaterThan(50);
  });
});

describe('honest crews across partitions', () => {
  it('never mint a right, on any replica, at any moment', () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 60 }), (steps) => {
        const devices = runCrew(steps, (ds) => ds.forEach((d) => expectConserved(d.state())));
        expectConserved(stateOf(derive(union(devices))));
      }),
      { numRuns: RUNS },
    );
  });

  it('never let two actors believe they may spend the same token', () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 60 }), (steps) => {
        runCrew(steps, (ds) => {
          for (const id of allTokens) expect(spenders(ds, id).length).toBeLessThanOrEqual(1);
        });
      }),
      { numRuns: RUNS },
    );
  });

  it('never sign two commitments of one token, and merge with no violations', () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 60 }), (steps) => {
        const events = union(runCrew(steps, () => {}));
        const commitments = events.flatMap((e) => (e.type === 'right.committed' ? e.body.tokens : []));
        expect(new Set(commitments).size).toBe(commitments.length);

        const merged = derive(events);
        expect(merged.violations).toEqual([]);
        const byId = new Map(events.map((e) => [e.id, e]));
        for (const t of Object.values(merged.tokens)) expectLegalChain(t, byId);
      }),
      { numRuns: RUNS },
    );
  });

  it('honour every commitment after merging', () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 60 }), (steps) => {
        const events = union(runCrew(steps, () => {}));
        const merged = derive(events);
        for (const e of events) {
          if (e.type !== 'right.committed') continue;
          for (const id of e.body.tokens) expect(token(merged, id)).toMatchObject({ state: 'committed', committedTo: e.body.taskId });
        }
      }),
      { numRuns: RUNS },
    );
  });
});

describe('forked holder', () => {
  it('is detected, conservative and replica-independent, whichever way the fork goes', () => {
    const spend = fc.constantFrom('commit' as const, 'offer' as const);
    fc.assert(
      fc.property(spend, spend, fc.nat({ max: 3 }), fc.nat({ max: 3 }), fc.array(step, { maxLength: 25 }), (left, right, warmL, warmR, prefix) => {
        const devices = runCrew(prefix, () => {});
        exchange(...devices);
        const chair = token(devices[0]!.derived(), 'evac-chair#1');
        fc.pre(chair.state === 'held' && chair.holder !== null);
        const original = devices.find((d) => d.actor === chair.holder)!;
        const twin = original.clone();
        const other = (d: Device) => CREW.find((a) => a !== d.actor)!;

        for (let i = 0; i < warmL; i += 1) original.emit('task.accepted', { taskId: `w${i}`, via: 'tap' });
        for (let i = 0; i < warmR; i += 1) twin.emit('task.accepted', { taskId: `w${i}`, via: 'tap' });
        const a = left === 'commit' ? original.commit(['evac-chair#1'], 'left') : original.offer(['evac-chair#1'], other(original), 'left');
        const b = right === 'commit' ? twin.commit(['evac-chair#1'], 'right') : twin.offer(['evac-chair#1'], other(twin), 'right');

        const events = union([...devices, twin]);
        const merged = derive(events);
        const clock = (x: { lamport: number; id: EventId }) => [x.lamport, x.id] as const;
        const [winner, loser] = clock(a)[0] < clock(b)[0] || (clock(a)[0] === clock(b)[0] && a.id < b.id) ? [a, b] : [b, a];

        const fork = merged.violations.find((v) => v.kind === 'token-fork' && v.tokenId === 'evac-chair#1');
        expect(fork, 'fork is reported').toBeDefined();
        expect(fork!.severity).toBe('violation');
        expect(fork!.events[0]).toBe(winner.id);
        expect(fork!.events).toContain(loser.id);
        expect(token(merged, 'evac-chair#1').chain).toContain(winner.id);
        expect(token(merged, 'evac-chair#1').chain).not.toContain(loser.id);
        expectConserved(stateOf(merged));

        const shuffled = [...events].reverse();
        expect(derive(shuffled)).toEqual(merged);
      }),
      { numRuns: RUNS },
    );
  });
});

describe('lost acknowledgement', () => {
  it('never refunds, however much else the sender learns', () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 40 }), fc.boolean(), (noise, yes) => {
        const sender = new Device(ACCESS);
        const recipient = new Device(MEDICS);
        sender.offer(['evac-chair#1'], MEDICS, 'held-up');
        exchange(sender, recipient);
        if (yes) recipient.accept('held-up');
        else recipient.decline('held-up');

        const others = runCrew(noise, () => {}).filter((d) => d.actor === SUPPLY);
        const elsewhere = others.flatMap((d) => d.all()).filter((e) => e.actor === SUPPLY);
        sender.receive(elsewhere);

        const view = sender.state();
        expect(view.tokens['evac-chair#1']).toMatchObject({ state: 'in-transit', holder: null });
        expect(canCommit(view, ACCESS, ['evac-chair#1'])).toMatchObject({ ok: false, code: 'TOKEN_IN_TRANSIT' });
        expect(findTokens(view, ACCESS, 'evac-chair', 1)).toEqual([]);
        expectConserved(view);

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

/**
 * Arbitrary signed nonsense: any actor, any token, any transfer, any clock, any causes. Stands in
 * for every faulty or hostile peer. Nothing here is a valid history by construction.
 */
const soup = fc
  .array(
    fc.record({
      actor: fc.constantFrom(...CREW, 'actor-stranger'),
      tokens: fc.subarray([...allTokens, 'ghost#1']),
      transfer: fc.constantFrom('t1', 't2', 't3', 't4'),
      to: fc.constantFrom(...CREW),
      task: fc.constantFrom('a', 'b', 'c'),
      kind: fc.constantFrom('commit', 'offer', 'accept', 'decline'),
      lamport: fc.nat({ max: 12 }),
      causes: fc.array(fc.nat(), { maxLength: 2 }),
    }),
    { maxLength: 40 },
  )
  .map((rows) => {
    const events: AnyEvent[] = [];
    const devices = new Map<ActorId, Device>();
    rows.forEach((r) => {
      const d = devices.get(r.actor) ?? new Device(r.actor);
      devices.set(r.actor, d);
      const overrides = {
        lamport: r.lamport,
        parents: events.length ? r.causes.map((c) => events[c % events.length]!.id) : [],
      };
      if (r.kind === 'commit') events.push(d.emit('right.committed', { tokens: r.tokens, taskId: r.task }, overrides) as AnyEvent);
      else if (r.kind === 'offer') events.push(d.emit('right.offered', { transfer: r.transfer, tokens: r.tokens, to: r.to }, overrides) as AnyEvent);
      else if (r.kind === 'accept') events.push(d.emit('right.accepted', { transfer: r.transfer }, overrides) as AnyEvent);
      else events.push(d.emit('right.declined', { transfer: r.transfer }, overrides) as AnyEvent);
    });
    return events;
  });

describe('hostile histories', () => {
  it('never mint a right, and every chain stays a legal replay', () => {
    fc.assert(
      fc.property(soup, (events) => {
        const derived = derive(events);
        expectConserved(stateOf(derived));
        const byId = new Map(events.map((e) => [e.id, e]));
        for (const t of Object.values(derived.tokens)) expectLegalChain(t, byId);
      }),
      { numRuns: 1000 },
    );
  });

  it('commit no token twice', () => {
    fc.assert(
      fc.property(soup, (events) => {
        const byId = new Map(events.map((e) => [e.id, e]));
        for (const t of Object.values(derive(events).tokens)) {
          const commits = t.chain.filter((id) => byId.get(id)?.type === 'right.committed');
          expect(commits.length).toBeLessThanOrEqual(1);
          if (commits.length === 1) expect(t.chain.at(-1)).toBe(commits[0]);
        }
      }),
      { numRuns: 1000 },
    );
  });

  it('let only the stated recipient move a token out of transit', () => {
    fc.assert(
      fc.property(soup, (events) => {
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
      { numRuns: 1000 },
    );
  });

  it('report every spend that changed nothing', () => {
    fc.assert(
      fc.property(soup, (events) => {
        const { tokens, violations } = derive(events);
        const used = new Set(Object.values(tokens).flatMap((t) => t.chain));
        const reported = new Set(violations.flatMap((v) => v.events));
        for (const e of events) {
          if (e.type !== 'right.committed' && e.type !== 'right.offered') continue;
          if (e.body.tokens.length === 0) continue;
          expect(used.has(e.id) || reported.has(e.id)).toBe(true);
        }
      }),
      { numRuns: 1000 },
    );
  });
});

describe('order independence', () => {
  it('gives every replica the same answer for the same events', () => {
    fc.assert(
      fc.property(soup, fc.infiniteStream(fc.nat()), (events, noise) => {
        const baseline = derive(events);
        const shuffled = [...events].map((e) => ({ e, k: noise.next().value })).sort((a, b) => a.k - b.k).map((x) => x.e);
        const duplicated = [...shuffled, ...events.slice(0, 5)];
        expect(derive(shuffled)).toEqual(baseline);
        expect(derive(duplicated)).toEqual(baseline);
      }),
      { numRuns: 1000 },
    );
  });

  it('holds for merged honest histories too', () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 60 }), fc.infiniteStream(fc.nat()), (steps, noise) => {
        const events = union(runCrew(steps, () => {}));
        const shuffled = events.map((e) => ({ e, k: noise.next().value })).sort((a, b) => a.k - b.k).map((x) => x.e);
        expect(derive(shuffled)).toEqual(derive(events));
      }),
      { numRuns: RUNS },
    );
  });

  it('settles replicas that gossip until they hold the same events', () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 60 }), (steps) => {
        const devices = runCrew(steps, () => {});
        exchange(...devices);
        const [first, ...rest] = devices.map((d) => d.derived());
        for (const view of rest) expect(view).toEqual(first);
      }),
      { numRuns: RUNS },
    );
  });
});
