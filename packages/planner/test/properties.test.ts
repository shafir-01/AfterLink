import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { ActorId, MissionState, TaskRecord } from '@afterlink/protocol';
import { knowledgeState, plan, type PlannerAction } from '../src/index.ts';
import { NOW, anyWorld, applyActions, capsule, deepFreeze, ofType, shuffled, spec, taskRecord, tick, token, world } from './world.ts';

const RUNS = { numRuns: 200 };

function isActive(t: TaskRecord): boolean {
  return t.status === 'claimed' || t.status === 'accepted';
}

/** How many rights of a class this actor can still spend: held, less what its active work needs. */
function spendable(state: MissionState, actor: ActorId, resource: string): number {
  const held = Object.values(state.tokens).filter((k) => k.resource === resource && k.holder === actor && k.state === 'held').length;
  let earmarked = 0;
  for (const t of Object.values(state.tasks)) {
    if (!isActive(t) || (t.owner !== actor && !t.coveredBy?.includes(actor))) continue;
    const needed = t.spec.needs.filter((n) => n.resource === resource).reduce((sum, n) => sum + n.count, 0);
    const spent = Object.values(state.tokens).filter((k) => k.committedTo === t.spec.id && k.resource === resource && k.holder === actor).length;
    earmarked += Math.max(0, needed - spent);
  }
  return held - earmarked;
}

function factStands(state: MissionState, key: string, group: ActorId[]): boolean {
  const reports = state.observations[key] ?? [];
  return reports.some((o) => ['confirmed', 'local'].includes(knowledgeState(o, NOW, reports, group)));
}

describe('authority', () => {
  it('never plans with authority it lacks', () => {
    fc.assert(
      fc.property(anyWorld, ({ state, ids }) => {
        const capsuleNow = state.capsule!;
        for (const self of ids) {
          const actions = tick(state, { self });
          const spendings = [...ofType(actions, 'claim'), ...ofType(actions, 'cover')];

          const spent = new Set<string>();
          for (const action of spendings) {
            const task = state.tasks[action.taskId]!;
            const needed = task.spec.needs.reduce((sum, n) => sum + n.count, 0);
            expect(action.tokens).toHaveLength(needed);
            for (const id of action.tokens) {
              const tokenRecord = state.tokens[id]!;
              expect(tokenRecord.holder).toBe(self);
              expect(tokenRecord.state).toBe('held');
              expect(spent.has(id)).toBe(false);
              spent.add(id);
            }
            const team = capsuleNow.teams.find((t) => t.id === state.actors[self]!.team)!;
            expect(task.spec.requires.every((c) => team.capabilities.includes(c))).toBe(true);
            expect(capsuleNow.fallback.humanApprovalKinds).not.toContain(task.spec.kind);
            for (const dep of task.spec.dependsOn) expect(state.tasks[dep]?.status).toBe('completed');
            if (!task.spec.reversible) {
              for (const key of task.spec.reliesOn ?? []) expect(factStands(state, key, ids)).toBe(true);
            }
          }

          for (const resource of capsuleNow.resources.map((r) => r.id)) {
            const planned = [...spent].filter((id) => state.tokens[id]!.resource === resource).length;
            if (planned) expect(planned).toBeLessThanOrEqual(spendable(state, self, resource));
          }

          for (const ask of ofType(actions, 'request-transfer')) {
            expect(ask.from).not.toBe(self);
            expect(ids).toContain(ask.from);
            expect(spendable(state, ask.from, ask.resource)).toBeGreaterThanOrEqual(ask.count);
          }
        }
      }),
      RUNS,
    );
  });

  it('asks only people it can reach, and only for work it could then do', () => {
    fc.assert(
      fc.property(anyWorld, fc.integer(), ({ state, ids }, seed) => {
        const [self, ...rest] = shuffled(ids, seed);
        const reachable = rest.slice(0, Math.floor(rest.length / 2));
        for (const ask of ofType(tick(state, { self: self!, reachable }), 'request-transfer')) {
          expect(reachable).toContain(ask.from);
        }
      }),
      RUNS,
    );
  });
});

describe('coordination without a leader', () => {
  it('gives disjoint work to everyone who shares a view', () => {
    fc.assert(
      fc.property(anyWorld, ({ state, ids }) => {
        const owners = new Map<string, ActorId>();
        const speakers = new Map<string, ActorId>();
        const tokens = new Set<string>();
        for (const self of ids) {
          const actions = tick(state, { self });
          for (const a of [...ofType(actions, 'claim'), ...ofType(actions, 'cover')]) {
            expect(owners.get(a.taskId)).toBeUndefined();
            owners.set(a.taskId, self);
            for (const id of a.tokens) {
              expect(tokens.has(id)).toBe(false);
              tokens.add(id);
            }
          }
          for (const a of [...ofType(actions, 'refuse'), ...ofType(actions, 'defer')]) {
            const prior = speakers.get(a.taskId);
            expect(prior === undefined || prior === self).toBe(true);
            speakers.set(a.taskId, self);
          }
        }
      }),
      RUNS,
    );
  });

  it('leaves no assignable task unclaimed while someone has room', () => {
    const tasks = Array.from({ length: 8 }, (_, i) => taskRecord(spec(`t${i}`)));
    const state = world({ tasks });
    const claimed = Object.keys(state.actors).flatMap((self) => ofType(tick(state, { self }), 'claim'));
    expect(claimed).toHaveLength(8);
  });
});

describe('determinism', () => {
  it('gives the same answer whatever order the view was assembled in', () => {
    fc.assert(
      fc.property(anyWorld, fc.integer(), ({ state, ids }, seed) => {
        const self = ids[0]!;
        const reordered: MissionState = {
          ...state,
          actors: Object.fromEntries(shuffled(Object.entries(state.actors), seed)),
          tasks: Object.fromEntries(shuffled(Object.entries(state.tasks), seed)),
          tokens: Object.fromEntries(shuffled(Object.entries(state.tokens), seed)),
        };
        const input = { self, now: NOW, horizon: { [self]: 3 }, lastHeard: {} };
        expect(plan({ ...input, state: reordered, reachable: shuffled(ids.slice(1), seed) })).toEqual(plan({ ...input, state, reachable: ids.slice(1) }));
      }),
      RUNS,
    );
  });

  it('does not touch its input', () => {
    fc.assert(
      fc.property(anyWorld, ({ state, ids }) => {
        const frozen = deepFreeze(state);
        for (const self of ids) expect(() => tick(frozen, { self })).not.toThrow();
      }),
      { numRuns: 100 },
    );
  });
});

describe('replanning', () => {
  it('moves unclaimed work off a peer that drops out', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 6 }), fc.integer({ min: 0, max: 3 }), (count, gone) => {
        const tasks = Array.from({ length: count }, (_, i) => taskRecord(spec(`t${i}`, { requires: ['haul'], location: { x: i * 10, y: i * 15 } })));
        const state = world({
          actors: { a0: 'facilities', a1: 'supply', a2: 'facilities', a3: 'supply' },
          tasks,
        });
        const peers = ['a0', 'a1', 'a2', 'a3'];
        const lost = peers[gone]!;
        const survivors = peers.filter((p) => p !== lost);

        const before = peers.flatMap((self) => ofType(tick(state, { self }), 'claim').map((c) => ({ self, id: c.taskId })));
        expect(before).toHaveLength(count);

        const after = survivors.flatMap((self) => ofType(tick(state, { self, reachable: survivors }), 'claim').map((c) => ({ self, id: c.taskId })));
        expect(new Set(after.map((a) => a.id)).size).toBe(count);
        expect(after.map((a) => a.self)).not.toContain(lost);
      }),
      RUNS,
    );
  });

  it('never leans on a peer that dropped out', () => {
    fc.assert(
      fc.property(anyWorld, fc.nat(), ({ state, ids }, n) => {
        const lost = ids[n % ids.length]!;
        const survivors = ids.filter((p) => p !== lost);
        for (const self of survivors) {
          const actions = tick(state, { self, reachable: survivors });
          for (const ask of ofType(actions, 'request-transfer')) expect(ask.from).not.toBe(lost);
          for (const action of [...ofType(actions, 'claim'), ...ofType(actions, 'cover')]) {
            for (const id of action.tokens) expect(state.tokens[id]!.holder).toBe(self);
          }
        }
      }),
      RUNS,
    );
  });

  it('covers claimed work exactly once after the owner goes quiet, with no leader to arrange it', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 3 }), fc.integer({ min: 1, max: 5 }), (ownerIndex, count) => {
        const peers = ['a0', 'a1', 'a2', 'a3'];
        const owner = peers[ownerIndex]!;
        const tasks = Array.from({ length: count }, (_, i) => taskRecord(spec(`t${i}`, { priority: 1 }), { status: 'accepted', owner }));
        const state = world({ actors: { a0: 'medics', a1: 'access', a2: 'facilities', a3: 'supply' }, tasks });
        const survivors = peers.filter((p) => p !== owner);
        const silent = { [owner]: NOW - 9_000 };

        const covers = survivors.flatMap((self) => ofType(tick(state, { self, reachable: survivors, lastHeard: silent }), 'cover'));
        expect(covers.map((c) => c.taskId).sort()).toEqual(tasks.map((t) => t.spec.id).sort());

        const early = { [owner]: NOW - 1_000 };
        expect(survivors.flatMap((self) => ofType(tick(state, { self, reachable: survivors, lastHeard: early }), 'cover'))).toEqual([]);
      }),
      RUNS,
    );
  });
});

describe('idempotence over ticks', () => {
  /** Runs every actor until nothing new is said, returning what each round produced. */
  function settle(start: MissionState, ids: ActorId[], rounds: number): { state: MissionState; said: PlannerAction[][] } {
    let state = start;
    const said: PlannerAction[][] = [];
    for (let round = 0; round < rounds; round++) {
      const spoken: PlannerAction[] = [];
      for (const self of ids) {
        const actions = tick(state, { self });
        spoken.push(...actions);
        state = applyActions(state, self, actions);
      }
      said.push(spoken);
      if (!spoken.length) break;
    }
    return { state, said };
  }

  it('repeats no refusal for an unchanged situation', () => {
    fc.assert(
      fc.property(anyWorld, ({ state, ids }) => {
        for (const self of ids) {
          const first = tick(state, { self });
          const after = applyActions(state, self, first);
          const second = tick(after, { self });
          const verdicts = (actions: PlannerAction[]) =>
            [...ofType(actions, 'refuse'), ...ofType(actions, 'defer')].map((a) => `${a.taskId}|${a.decision.refusal}|${a.decision.next?.join()}`);
          const repeated = verdicts(second).filter((v) => verdicts(first).includes(v));
          expect(repeated).toEqual([]);
        }
      }),
      RUNS,
    );
  });

  it('goes quiet: a whole group reaches a fixed point instead of chattering', () => {
    fc.assert(
      fc.property(anyWorld, ({ state, ids }) => {
        const { said } = settle(state, ids, 40);
        expect(said[said.length - 1]).toEqual([]);
      }),
      RUNS,
    );
  });

  it('stays quiet as time passes with nothing changing', () => {
    const task = taskRecord(spec('t', { priority: 3, requires: ['first-aid'], needs: [{ resource: 'aed', count: 1 }] }));
    let state = world({ tasks: [task], tokens: [token('aed#1', 'actor-access')] });
    const view = { self: 'actor-medic', reachable: ['actor-supply'] };
    state = applyActions(state, view.self, tick(state, view));
    for (let minute = 1; minute < 120; minute++) expect(tick(state, { ...view, now: NOW + minute * 60_000 })).toEqual([]);
  });
});

describe('speed', () => {
  it('handles 50 actors and 200 tasks well inside one tick', () => {
    const teams = ['medics', 'access', 'facilities', 'supply'];
    const actors = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`a${String(i).padStart(2, '0')}`, teams[i % 4]!]));
    const tasks = Array.from({ length: 200 }, (_, i) =>
      taskRecord(
        spec(`t${i}`, {
          priority: ((i % 3) + 1) as 1 | 2 | 3,
          location: { x: (i * 37) % 100, y: (i * 61) % 100 },
          requires: i % 4 === 0 ? [] : [['first-aid', 'mobility', 'haul'][i % 3]!],
          ...(i % 10 === 0 ? { needs: [{ resource: 'aed', count: 1 }] } : {}),
        }),
      ),
    );
    const tokens = Array.from({ length: 12 }, (_, i) => token(`aed#${i}`, `a${String(i * 4).padStart(2, '0')}`));
    const state = world({ capsule: capsule(), actors, tasks, tokens });
    const ids = Object.keys(actors);

    for (const self of ids.slice(0, 5)) tick(state, { self });
    const started = performance.now();
    for (const self of ids) tick(state, { self });
    const mean = (performance.now() - started) / ids.length;
    console.log(`plan(): ${mean.toFixed(2)} ms mean over ${ids.length} actors, 200 open tasks`);
    expect(mean).toBeLessThan(100);
  });
});
