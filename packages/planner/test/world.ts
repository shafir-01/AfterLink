import fc from 'fast-check';
import type {
  ActorId,
  ActorRecord,
  MissionCapsule,
  MissionState,
  Observation,
  TaskRecord,
  TaskSpec,
  TaskStatus,
  TeamId,
  TokenRecord,
} from '@afterlink/protocol';
import { plan, type PlannerAction } from '../src/index.ts';

export const NOW = 1_800_000_000_000;

export const MEDIC = 'actor-medic';
export const ACCESS = 'actor-access';
export const FACILITIES = 'actor-facilities';
export const SUPPLY = 'actor-supply';
export const FOUR: ActorId[] = [MEDIC, ACCESS, FACILITIES, SUPPLY];

export function capsule(over: Partial<MissionCapsule> = {}): MissionCapsule {
  return {
    v: 1,
    id: 'test-mission',
    version: 1,
    name: 'Test',
    objective: 'Keep everyone safe',
    objectives: [
      { id: 'safety', title: 'Safety', rank: 1 },
      { id: 'service', title: 'Service', rank: 3 },
    ],
    teams: [
      { id: 'medics', name: 'Medics', capabilities: ['first-aid'], home: { x: 10, y: 10 } },
      { id: 'access', name: 'Access', capabilities: ['mobility'], home: { x: 90, y: 10 } },
      { id: 'facilities', name: 'Facilities', capabilities: ['repair', 'haul'], home: { x: 90, y: 90 } },
      { id: 'supply', name: 'Supply', capabilities: ['stock', 'haul'], home: { x: 10, y: 90 } },
    ],
    resources: [
      { id: 'aed', name: 'AED', tokens: [] },
      { id: 'evac-chair', name: 'Evacuation chair', tokens: [] },
      { id: 'cart', name: 'Cart', tokens: [] },
    ],
    tasks: [],
    contingencies: [],
    fallback: { coverAfterMs: 8_000, coverMaxPriority: 1, humanApprovalKinds: ['site-closure'] },
    issuer: 'issuer',
    issuedAt: NOW - 3_600_000,
    ...over,
  };
}

export function spec(id: string, over: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id,
    kind: 'general',
    title: `Task ${id}`,
    brief: 'Do it',
    objective: 'safety',
    priority: 2,
    location: { x: 50, y: 50 },
    locationName: 'Middle',
    requires: [],
    needs: [],
    dependsOn: [],
    reversible: true,
    ...over,
  };
}

export function taskRecord(s: TaskSpec, over: Partial<TaskRecord> = {}): TaskRecord {
  return { spec: s, status: 'open', source: { kind: 'human' }, decisions: [], createdBy: MEDIC, updatedAt: NOW - 60_000, ...over };
}

export function token(id: string, holder: ActorId | null, over: Partial<TokenRecord> = {}): TokenRecord {
  return { id, resource: id.split('#')[0]!, holder, holderTeam: 'medics', state: 'held', chain: [], ...over };
}

export function report(key: string, value: Observation['value'], source: ActorId, ageMs = 1_000, validForMs = 0, subject = key): Observation {
  return { key, value, subject, observedAt: NOW - ageMs, validForMs, source };
}

export function world(o: {
  capsule?: MissionCapsule;
  actors?: Record<ActorId, TeamId>;
  tasks?: TaskRecord[];
  tokens?: TokenRecord[];
  observations?: Observation[];
}): MissionState {
  const actors: Record<ActorId, ActorRecord> = {};
  const roster = o.actors ?? { [MEDIC]: 'medics', [ACCESS]: 'access', [FACILITIES]: 'facilities', [SUPPLY]: 'supply' };
  for (const [id, team] of Object.entries(roster)) actors[id] = { id, team, name: team, lastSeq: 0, lastSeenWall: 0 };
  const observations: Record<string, Observation[]> = {};
  for (const obs of o.observations ?? []) (observations[obs.key] ??= []).push(obs);
  return {
    mission: 'test-mission',
    capsule: o.capsule ?? capsule(),
    actors,
    tasks: Object.fromEntries((o.tasks ?? []).map((t) => [t.spec.id, t])),
    tokens: Object.fromEntries((o.tokens ?? []).map((t) => [t.id, t])),
    observations,
    conflicts: [],
    eventCount: 0,
  };
}

export interface Tick {
  self: ActorId;
  reachable?: ActorId[];
  now?: number;
  lastHeard?: Record<ActorId, number>;
}

/** Plans for one actor. Unless told otherwise, everyone on the roster is in contact and just heard from. */
export function tick(state: MissionState, t: Tick): PlannerAction[] {
  const reachable = (t.reachable ?? Object.keys(state.actors)).filter((a) => a !== t.self);
  const now = t.now ?? NOW;
  return plan({
    self: t.self,
    state,
    reachable,
    now,
    horizon: { [t.self]: 7 },
    lastHeard: t.lastHeard ?? Object.fromEntries(Object.keys(state.actors).map((a) => [a, now])),
  });
}

export function ofType<T extends PlannerAction['type']>(actions: PlannerAction[], type: T): Extract<PlannerAction, { type: T }>[] {
  return actions.filter((a): a is Extract<PlannerAction, { type: T }> => a.type === type);
}

/** Folds planner actions into a state the way the reducer does, without the cost of signing events. */
export function applyActions(state: MissionState, actor: ActorId, actions: PlannerAction[], now = NOW): MissionState {
  const next = structuredClone(state);
  for (const a of actions) {
    const task = next.tasks[a.taskId]!;
    task.updatedAt = now;
    switch (a.type) {
      case 'claim':
        task.owner = actor;
        task.status = 'claimed';
        task.decisions.push(a.decision);
        break;
      case 'cover':
        task.coveredBy = [...(task.coveredBy ?? []), actor];
        task.decisions.push(a.decision);
        break;
      case 'refuse':
      case 'defer':
        task.decisions.push(a.decision);
        if (!task.owner) task.status = a.type === 'refuse' ? 'refused' : 'deferred';
        break;
      case 'release':
        task.decisions.push({ ...a.decision, outcome: 'UNKNOWN', policy: 'task.released' });
        break;
      case 'request-transfer':
        break;
    }
  }
  return next;
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

export function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let s = seed >>> 0 || 1;
  for (let i = out.length - 1; i > 0; i--) {
    s = Math.imul(s, 1664525) + 1013904223;
    const j = (s >>> 0) % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const TEAMS: TeamId[] = ['medics', 'access', 'facilities', 'supply'];
const SKILLS = ['first-aid', 'mobility', 'repair', 'haul', 'stock'];
const RESOURCES = ['aed', 'evac-chair', 'cart'];
const KEYS = ['gate.north', 'gate.west', 'field.flooded'];
const KINDS = ['general', 'north-route', 'site-closure'];
const STATUSES: TaskStatus[] = ['open', 'open', 'open', 'refused', 'deferred', 'claimed', 'accepted', 'completed', 'cancelled'];

const rawTask = fc.record({
  kind: fc.constantFrom(...KINDS),
  priority: fc.constantFrom(1 as const, 2 as const, 3 as const),
  objective: fc.constantFrom('safety', 'service'),
  x: fc.integer({ min: 0, max: 100 }),
  y: fc.integer({ min: 0, max: 100 }),
  requires: fc.subarray(SKILLS, { maxLength: 2 }),
  needs: fc.array(fc.record({ resource: fc.constantFrom(...RESOURCES), count: fc.integer({ min: 1, max: 2 }) }), { maxLength: 2 }),
  depends: fc.array(fc.nat(), { maxLength: 2 }),
  reversible: fc.boolean(),
  reliesOn: fc.subarray(KEYS, { maxLength: 2 }),
  deadlineIn: fc.option(fc.integer({ min: -60_000, max: 1_200_000 }), { nil: undefined }),
  status: fc.constantFrom(...STATUSES),
  owner: fc.nat(),
  coveredBy: fc.option(fc.nat(), { nil: undefined }),
});

const rawToken = fc.record({
  resource: fc.constantFrom(...RESOURCES),
  holder: fc.nat(),
  state: fc.constantFrom<TokenRecord['state']>('held', 'held', 'held', 'in-transit', 'committed'),
  committedTo: fc.nat(),
});

const rawReport = fc.record({
  key: fc.constantFrom(...KEYS),
  value: fc.boolean(),
  source: fc.nat(),
  ageMs: fc.integer({ min: 0, max: 600_000 }),
  validForMs: fc.constantFrom(0, 60_000, 300_000),
});

/** Random mission states with every status, a mix of token states, and disputed reports. */
export const anyWorld = fc
  .record({
    teams: fc.array(fc.constantFrom(...TEAMS), { minLength: 1, maxLength: 9 }),
    tasks: fc.array(rawTask, { maxLength: 24 }),
    tokens: fc.array(rawToken, { maxLength: 10 }),
    reports: fc.array(rawReport, { maxLength: 8 }),
    blocked: fc.boolean(),
  })
  .map(({ teams, tasks, tokens, reports, blocked }) => {
    const ids = teams.map((_, i) => `a${i}`);
    const pick = (n: number) => ids[n % ids.length]!;
    const taskIds = tasks.map((_, i) => `t${i}`);
    const records = tasks.map((t, i) => {
      const s = spec(`t${i}`, {
        kind: t.kind,
        priority: t.priority,
        objective: t.objective,
        location: { x: t.x, y: t.y },
        requires: t.requires,
        needs: t.needs,
        dependsOn: i ? [...new Set(t.depends.map((d) => taskIds[d % i]!))] : [],
        reversible: t.reversible,
        ...(t.reliesOn.length ? { reliesOn: t.reliesOn } : {}),
        ...(t.deadlineIn === undefined ? {} : { deadlineMs: NOW + t.deadlineIn }),
      });
      const owned = t.status === 'claimed' || t.status === 'accepted' || t.status === 'completed';
      return taskRecord(s, {
        status: t.status,
        ...(owned ? { owner: pick(t.owner) } : {}),
        ...(owned && t.coveredBy !== undefined && pick(t.coveredBy) !== pick(t.owner) ? { coveredBy: [pick(t.coveredBy)] } : {}),
      });
    });
    const tokenRecords = tokens.map((k, i) => {
      const moving = k.state === 'in-transit';
      const committed = k.state === 'committed' && taskIds.length > 0;
      return token(`${k.resource}#${i}`, moving ? null : pick(k.holder), {
        state: committed || moving ? k.state : 'held',
        ...(committed ? { committedTo: taskIds[k.committedTo % taskIds.length]! } : {}),
        ...(moving ? { transfer: `x${i}` } : {}),
      });
    });
    const state = world({
      capsule: capsule({
        contingencies: blocked
          ? [{ id: 'north-closed', when: { key: 'gate.north', equals: false }, then: { blockKinds: ['north-route'], note: 'North gate closed' } }]
          : [],
      }),
      actors: Object.fromEntries(ids.map((id, i) => [id, teams[i]!])),
      tasks: records,
      tokens: tokenRecords,
      observations: reports.map((r) => report(r.key, r.value, pick(r.source), r.ageMs, r.validForMs)),
    });
    return { state, ids };
  });
