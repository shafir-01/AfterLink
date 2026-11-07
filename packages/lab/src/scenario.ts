import type { Capability, ContingencyRule, FallbackPolicy, Json, Point, ResourceSpec, TaskSpec, TeamSpec, TokenId } from '@afterlink/protocol';
import { hashSeed, Rng } from './rng.ts';

export type FamilyId =
  | 'connected'
  | 'hub-death'
  | 'two-groups'
  | 'hub-death-split'
  | 'asymmetric'
  | 'loss'
  | 'duplication'
  | 'reorder'
  | 'retry-storm'
  | 'transfer-disconnect'
  | 'exclusive-race'
  | 'stale-observation'
  | 'restart-mid-partition'
  | 'ferry-twice'
  | 'incompatible-deps'
  | 'forged-replay'
  | 'membership-churn';

export interface World {
  teams: TeamSpec[];
  resources: ResourceSpec[];
  fallback: FallbackPolicy;
  contingencies: ContingencyRule[];
}

export interface Incident {
  at: number;
  /** Index of the team whose device hears about the incident. */
  reporter: number;
  spec: TaskSpec;
  /** Hands-on time once a worker starts. The same in every system. */
  durationMs: number;
}

export interface Quality {
  loss: number;
  duplicate: number;
  delayMs: number;
  reorder: boolean;
}

export type Attack =
  | 'forged-signature'
  | 'tampered-body'
  | 'outsider-key'
  | 'replayed-events'
  | 'forged-packet'
  | 'replayed-packet'
  | 'insider-fork';

export type FaultStep =
  | { at: number; kind: 'hub'; up: boolean }
  /** Replaces the set of cut links. Pairs are directed: [from, to] stops traffic that way only. `hubReach` lists teams that can reach the hub. */
  | { at: number; kind: 'links'; cut: [number, number][]; hubReach: number[] }
  | { at: number; kind: 'quality'; quality: Quality }
  | { at: number; kind: 'restart'; actor: number; downForMs: number }
  | { at: number; kind: 'ferry'; from: number; to: number; copies: number }
  | { at: number; kind: 'transfer'; token: TokenId; from: number; to: number }
  | { at: number; kind: 'observe'; actor: number; key: string; value: Json; validForMs: number }
  | { at: number; kind: 'attack'; attack: Attack; target: number };

export interface TruthChange {
  at: number;
  key: string;
  value: Json;
}

export interface Window {
  from: number;
  to: number;
}

export interface Scenario {
  family: FamilyId;
  seed: number;
  world: World;
  incidents: Incident[];
  faults: FaultStep[];
  /** Outage windows for "during outage" counts. The connected control uses a nominal window at the same place. */
  windows: Window[];
  cutAt: number | null;
  /** When the last fault clears: reconciliation is measured from here. */
  healAt: number | null;
  horizonMs: number;
  /** What was physically true over time, whatever any device believed. */
  truth: TruthChange[];
  notes: string[];
}

export const TIMING = {
  tickMs: 2_000,
  latencyMs: 20,
  connectedMs: 120_000,
  outageMs: 480_000,
  settleMs: 240_000,
  meanArrivalMs: 25_000,
  minDurationMs: 30_000,
  maxDurationMs: 100_000,
} as const;

const team = (id: string, name: string, capabilities: Capability[], home: Point): TeamSpec => ({ id, name, capabilities, home });

export function labWorld(tokens: { chairs?: number; aeds?: number; carts?: number } = {}): World {
  const { chairs = 2, aeds = 2, carts = 3 } = tokens;
  const numbered = (id: string, n: number, holderTeam: string) =>
    Array.from({ length: n }, (_, i) => ({ id: `${id}#${i + 1}`, holderTeam }));
  return {
    teams: [
      team('medics', 'Medics', ['first-aid', 'mobility'], { x: 20, y: 30 }),
      team('access', 'Access', ['mobility', 'first-aid', 'haul'], { x: 40, y: 70 }),
      team('facilities', 'Facilities', ['repair', 'haul'], { x: 70, y: 30 }),
      team('supply', 'Supply', ['haul', 'repair'], { x: 80, y: 70 }),
    ],
    resources: [
      { id: 'evac-chair', name: 'Evacuation chair', tokens: numbered('evac-chair', chairs, 'access') },
      { id: 'aed', name: 'AED', tokens: numbered('aed', aeds, 'medics') },
      { id: 'cart', name: 'Cart', tokens: numbered('cart', carts, 'supply') },
    ],
    fallback: { coverAfterMs: 60_000, coverMaxPriority: 2, humanApprovalKinds: [] },
    contingencies: [],
  };
}

interface Kind {
  kind: string;
  requires: Capability;
  priorities: (1 | 2 | 3)[];
  resource?: string;
  resourceShare?: number;
}

const KINDS: Kind[] = [
  { kind: 'first-aid', requires: 'first-aid', priorities: [1, 1, 2], resource: 'aed', resourceShare: 0.25 },
  { kind: 'evacuate', requires: 'mobility', priorities: [1, 1, 2], resource: 'evac-chair', resourceShare: 0.6 },
  { kind: 'access-help', requires: 'mobility', priorities: [2, 3, 3] },
  { kind: 'repair', requires: 'repair', priorities: [2, 2, 3] },
  { kind: 'haul', requires: 'haul', priorities: [2, 3, 3], resource: 'cart', resourceShare: 0.4 },
];

export function makeTask(id: string, k: { kind: string; requires: Capability; priority: 1 | 2 | 3; needs?: string; dependsOn?: string[]; reversible?: boolean; reliesOn?: string[] }, rng: Rng): TaskSpec {
  return {
    id,
    kind: k.kind,
    title: `${k.kind} ${id}`,
    brief: `Handle ${k.kind} at the marked spot.`,
    objective: 'keep-people-safe',
    priority: k.priority,
    location: { x: rng.int(0, 100), y: rng.int(0, 100) },
    locationName: `zone-${rng.int(1, 9)}`,
    requires: [k.requires],
    needs: k.needs ? [{ resource: k.needs, count: 1 }] : [],
    dependsOn: k.dependsOn ?? [],
    reversible: k.reversible ?? true,
    ...(k.reliesOn ? { reliesOn: k.reliesOn } : {}),
  };
}

function duration(rng: Rng): number {
  return rng.int(TIMING.minDurationMs, TIMING.maxDurationMs);
}

/** Poisson incident stream, each reported at a random team's device. */
export function arrivals(rng: Rng, from: number, to: number, meanGapMs: number, prefix = 't'): Incident[] {
  const out: Incident[] = [];
  let t = from + rng.exp(meanGapMs);
  let n = 0;
  while (t < to) {
    const k = rng.pick(KINDS);
    const spec = makeTask(`${prefix}-${++n}`, {
      kind: k.kind,
      requires: k.requires,
      priority: rng.pick(k.priorities),
      needs: k.resource && rng.chance(k.resourceShare ?? 0) ? k.resource : undefined,
    }, rng);
    out.push({ at: Math.round(t), reporter: rng.int(0, 3), spec, durationMs: duration(rng) });
    t += rng.exp(meanGapMs);
  }
  return out;
}

/** One guaranteed incident shortly after the cut, so time-to-decision measures the system, not arrival luck. */
function firstAfterCut(rng: Rng, cutAt: number, reporter?: number): Incident {
  const spec = makeTask('t-after-cut', { kind: 'access-help', requires: 'mobility', priority: 1 }, rng);
  return { at: cutAt + rng.int(1_000, 5_000), reporter: reporter ?? rng.int(0, 3), spec, durationMs: duration(rng) };
}

function crossPairs(groups: number[][]): [number, number][] {
  const pairs: [number, number][] = [];
  for (let i = 0; i < groups.length; i++) {
    for (let j = 0; j < groups.length; j++) {
      if (i === j) continue;
      for (const a of groups[i] as number[]) for (const b of groups[j] as number[]) pairs.push([a, b]);
    }
  }
  return pairs;
}

function splitTeams(rng: Rng): number[][] {
  const order = rng.shuffle([0, 1, 2, 3]);
  const size = rng.pick([1, 2, 2]);
  return [order.slice(size), order.slice(0, size)];
}

const ALL = [0, 1, 2, 3];

interface Frame {
  rng: Rng;
  cutAt: number;
  outageMs: number;
  healAt: number;
  horizonMs: number;
}

function frame(family: FamilyId, seed: number): Frame {
  const rng = new Rng(hashSeed('scenario', family, seed));
  const cutAt = TIMING.connectedMs + rng.int(-20_000, 20_000);
  const outageMs = TIMING.outageMs + rng.int(-60_000, 60_000);
  const healAt = cutAt + outageMs;
  return { rng, cutAt, outageMs, healAt, horizonMs: healAt + TIMING.settleMs };
}

function base(family: FamilyId, seed: number, f: Frame, world: World, incidents: Incident[], faults: FaultStep[], extra: Partial<Scenario> = {}): Scenario {
  const sorted = [...incidents].sort((a, b) => a.at - b.at);
  return {
    family,
    seed,
    world,
    incidents: sorted,
    faults: [...faults].sort((a, b) => a.at - b.at),
    windows: [{ from: f.cutAt, to: f.healAt }],
    cutAt: f.cutAt,
    healAt: f.healAt,
    horizonMs: f.horizonMs,
    truth: [],
    notes: [],
    ...extra,
  };
}

function load(f: Frame): Incident[] {
  return [...arrivals(f.rng.fork('arrivals'), 0, f.healAt, TIMING.meanArrivalMs), firstAfterCut(f.rng.fork('first'), f.cutAt)];
}

function qualityFamily(family: FamilyId, seed: number, q: (r: Rng) => Quality): Scenario {
  const f = frame(family, seed);
  const clean: Quality = { loss: 0, duplicate: 0, delayMs: 0, reorder: false };
  return base(family, seed, f, labWorld(), load(f), [
    { at: f.cutAt, kind: 'quality', quality: q(f.rng.fork('quality')) },
    { at: f.healAt, kind: 'quality', quality: clean },
  ]);
}

/** Tokens of one resource, all held by `holder`, and tasks for them on each side of the split. */
function scarceWorld(chairs: number): World {
  return labWorld({ chairs });
}

const GENERATORS: Record<FamilyId, (seed: number) => Scenario> = {
  connected(seed) {
    const f = frame('connected', seed);
    return base('connected', seed, f, labWorld(), load(f), [], { cutAt: null, healAt: null });
  },

  'hub-death'(seed) {
    const f = frame('hub-death', seed);
    return base('hub-death', seed, f, labWorld(), load(f), [
      { at: f.cutAt, kind: 'hub', up: false },
      { at: f.healAt, kind: 'hub', up: true },
    ]);
  },

  'two-groups'(seed) {
    const f = frame('two-groups', seed);
    const groups = splitTeams(f.rng.fork('split'));
    return base('two-groups', seed, f, labWorld(), load(f), [
      { at: f.cutAt, kind: 'links', cut: crossPairs(groups), hubReach: groups[0] as number[] },
      { at: f.healAt, kind: 'links', cut: [], hubReach: ALL },
    ]);
  },

  'hub-death-split'(seed) {
    const f = frame('hub-death-split', seed);
    const groups = splitTeams(f.rng.fork('split'));
    const splitAt = f.cutAt + f.rng.int(20_000, 60_000);
    return base('hub-death-split', seed, f, labWorld(), load(f), [
      { at: f.cutAt, kind: 'hub', up: false },
      { at: splitAt, kind: 'links', cut: crossPairs(groups), hubReach: [] },
      { at: f.healAt, kind: 'links', cut: [], hubReach: ALL },
      { at: f.healAt, kind: 'hub', up: true },
    ]);
  },

  asymmetric(seed) {
    const f = frame('asymmetric', seed);
    const r = f.rng.fork('topology');
    const [a, bridge, c, d] = r.shuffle(ALL) as [number, number, number, number];
    const cut: [number, number][] = [[a, c], [c, a], [a, d], [d, a]];
    if (r.chance(0.5)) cut.push([bridge, d]);
    return base('asymmetric', seed, f, labWorld(), load(f), [
      { at: f.cutAt, kind: 'links', cut, hubReach: [a, bridge] },
      { at: f.healAt, kind: 'links', cut: [], hubReach: ALL },
    ]);
  },

  loss: (seed) => qualityFamily('loss', seed, (r) => ({ loss: 0.05 + r.next() * 0.3, duplicate: 0, delayMs: 0, reorder: false })),
  duplication: (seed) => qualityFamily('duplication', seed, (r) => ({ loss: 0, duplicate: 0.1 + r.next() * 0.5, delayMs: 0, reorder: false })),
  reorder: (seed) => qualityFamily('reorder', seed, (r) => ({ loss: 0, duplicate: 0, delayMs: r.int(100, 2_000), reorder: true })),
  'retry-storm': (seed) => qualityFamily('retry-storm', seed, (r) => ({ loss: 0.1 + r.next() * 0.2, duplicate: 0.1 + r.next() * 0.3, delayMs: r.int(200, 3_000), reorder: true })),

  'transfer-disconnect'(seed) {
    const f = frame('transfer-disconnect', seed);
    const r = f.rng.fork('transfer');
    const to = r.pick([0, 2, 3]);
    const holder = 1;
    const groups = [[holder, ...ALL.filter((x) => x !== holder && x !== to)], [to]];
    const world = scarceWorld(1);
    const gapMs = r.pick([0, 5, 10, 25, 50, 100]);
    const incidents = load(f).map((i) => (i.spec.needs.some((n) => n.resource === 'evac-chair') ? { ...i, spec: { ...i.spec, needs: [] } } : i));
    const onHolderSide = makeTask('chair-near', { kind: 'evacuate', requires: 'mobility', priority: 1, needs: 'evac-chair' }, r);
    const onTakerSide = makeTask('chair-far', { kind: 'evacuate', requires: to === 0 ? 'mobility' : 'haul', priority: 1, needs: 'evac-chair' }, r);
    incidents.push({ at: f.cutAt + r.int(5_000, 15_000), reporter: holder, spec: onHolderSide, durationMs: duration(r) });
    incidents.push({ at: f.cutAt + r.int(5_000, 15_000), reporter: to, spec: onTakerSide, durationMs: duration(r) });
    return base('transfer-disconnect', seed, f, world, incidents, [
      { at: f.cutAt - gapMs, kind: 'transfer', token: 'evac-chair#1', from: holder, to },
      { at: f.cutAt, kind: 'links', cut: crossPairs(groups), hubReach: groups[0] as number[] },
      { at: f.healAt, kind: 'links', cut: [], hubReach: ALL },
    ], { notes: [`offer sent ${gapMs} ms before the cut`] });
  },

  'exclusive-race'(seed) {
    const f = frame('exclusive-race', seed);
    const r = f.rng.fork('race');
    const groups = [[0, 1], [2, 3]];
    const world = scarceWorld(1);
    const incidents = load(f).map((i) => (i.spec.needs.some((n) => n.resource === 'evac-chair') ? { ...i, spec: { ...i.spec, needs: [] } } : i));
    const when = f.cutAt + r.int(5_000, 60_000);
    const near = makeTask('chair-a', { kind: 'evacuate', requires: 'mobility', priority: 1, needs: 'evac-chair' }, r);
    const far = makeTask('chair-b', { kind: 'evacuate', requires: 'haul', priority: 1, needs: 'evac-chair' }, r);
    incidents.push({ at: when, reporter: 0, spec: near, durationMs: duration(r) });
    incidents.push({ at: when + r.int(0, 2_000), reporter: 2, spec: far, durationMs: duration(r) });
    return base('exclusive-race', seed, f, world, incidents, [
      { at: f.cutAt, kind: 'hub', up: false },
      { at: f.cutAt, kind: 'links', cut: crossPairs(groups), hubReach: [] },
      { at: f.healAt, kind: 'links', cut: [], hubReach: ALL },
      { at: f.healAt, kind: 'hub', up: true },
    ]);
  },

  'stale-observation'(seed) {
    const f = frame('stale-observation', seed);
    const r = f.rng.fork('stale');
    const key = 'gate.north.open';
    const validForMs = r.int(45_000, 120_000);
    const groups = [[0, 1], [2, 3]];
    const observedAt = f.cutAt - r.int(10_000, 30_000);
    const flipAt = f.cutAt + r.int(10_000, 40_000);
    const askAt = observedAt + validForMs + r.int(5_000, 60_000);
    const world = labWorld();
    world.contingencies = [{ id: 'gate-closed', when: { key, equals: false }, then: { blockKinds: ['through-gate'], note: 'The north gate is closed.' } }];
    const irreversible = makeTask('through-gate', { kind: 'through-gate', requires: 'mobility', priority: 1, reversible: false, reliesOn: [key] }, r);
    const reversible = makeTask('near-gate', { kind: 'access-help', requires: 'mobility', priority: 2, reversible: true, reliesOn: [key] }, r);
    const incidents = [
      ...load(f),
      { at: Math.max(askAt, flipAt + 1_000), reporter: 0, spec: irreversible, durationMs: duration(r) },
      { at: Math.max(askAt, flipAt + 1_000) + 5_000, reporter: 1, spec: reversible, durationMs: duration(r) },
    ];
    return base('stale-observation', seed, f, world, incidents, [
      { at: observedAt, kind: 'observe', actor: 0, key, value: true, validForMs },
      { at: f.cutAt, kind: 'links', cut: crossPairs(groups), hubReach: [0, 1] },
      { at: flipAt, kind: 'observe', actor: 2, key, value: false, validForMs },
      { at: f.healAt, kind: 'links', cut: [], hubReach: ALL },
    ], { truth: [{ at: 0, key, value: true }, { at: flipAt, key, value: false }] });
  },

  'restart-mid-partition'(seed) {
    const f = frame('restart-mid-partition', seed);
    const r = f.rng.fork('restart');
    const groups = splitTeams(r);
    const actor = r.int(0, 3);
    return base('restart-mid-partition', seed, f, labWorld(), load(f), [
      { at: f.cutAt, kind: 'links', cut: crossPairs(groups), hubReach: groups[0] as number[] },
      { at: f.cutAt + Math.round(f.outageMs * (0.3 + r.next() * 0.3)), kind: 'restart', actor, downForMs: r.int(10_000, 45_000) },
      { at: f.healAt, kind: 'links', cut: [], hubReach: ALL },
    ]);
  },

  'ferry-twice'(seed) {
    const f = frame('ferry-twice', seed);
    const r = f.rng.fork('ferry');
    const groups = splitTeams(r);
    const from = r.pick(groups[1] as number[]);
    const to = r.pick(groups[0] as number[]);
    const ferryAt = f.cutAt + Math.round(f.outageMs * (0.4 + r.next() * 0.3));
    return base('ferry-twice', seed, f, labWorld(), load(f), [
      { at: f.cutAt, kind: 'hub', up: false },
      { at: f.cutAt, kind: 'links', cut: crossPairs(groups), hubReach: [] },
      { at: ferryAt, kind: 'ferry', from, to, copies: 2 },
      { at: f.healAt, kind: 'links', cut: [], hubReach: ALL },
      { at: f.healAt, kind: 'hub', up: true },
    ]);
  },

  'incompatible-deps'(seed) {
    const f = frame('incompatible-deps', seed);
    const r = f.rng.fork('deps');
    const groups = [[0, 1], [2, 3]];
    const world = scarceWorld(1);
    const parentAt = f.cutAt - r.int(2_000, 8_000);
    const incidents = load(f).map((i) => (i.spec.needs.some((n) => n.resource === 'evac-chair') ? { ...i, spec: { ...i.spec, needs: [] } } : i));
    const parent = makeTask('clear-route', { kind: 'repair', requires: 'repair', priority: 1 }, r);
    const childNear = makeTask('use-route', { kind: 'evacuate', requires: 'mobility', priority: 1, dependsOn: [parent.id], needs: 'evac-chair' }, r);
    const childFar = makeTask('block-route', { kind: 'haul', requires: 'haul', priority: 2, dependsOn: [parent.id], needs: 'evac-chair' }, r);
    incidents.push({ at: parentAt, reporter: 2, spec: parent, durationMs: r.int(60_000, 100_000) });
    incidents.push({ at: f.cutAt + r.int(2_000, 20_000), reporter: 0, spec: childNear, durationMs: duration(r) });
    incidents.push({ at: f.cutAt + r.int(2_000, 20_000), reporter: 2, spec: childFar, durationMs: duration(r) });
    return base('incompatible-deps', seed, f, world, incidents, [
      { at: f.cutAt, kind: 'links', cut: crossPairs(groups), hubReach: [0, 1] },
      { at: f.healAt, kind: 'links', cut: [], hubReach: ALL },
    ]);
  },

  'forged-replay'(seed) {
    const f = frame('forged-replay', seed);
    const r = f.rng.fork('attack');
    const groups = [[0, 1], [2, 3]];
    const victim = r.int(0, 3);
    const attacks: Attack[] = ['forged-signature', 'tampered-body', 'outsider-key', 'replayed-events', 'forged-packet', 'replayed-packet', 'insider-fork'];
    const steps: FaultStep[] = attacks.map((attack, i) => ({
      at: f.cutAt + Math.round(f.outageMs * (0.2 + 0.1 * i)),
      kind: 'attack',
      attack,
      target: victim,
    }));
    return base('forged-replay', seed, f, labWorld(), load(f), [
      { at: f.cutAt, kind: 'links', cut: crossPairs(groups), hubReach: [0, 1] },
      ...steps,
      { at: f.healAt, kind: 'links', cut: [], hubReach: ALL },
    ]);
  },

  'membership-churn'(seed) {
    const f = frame('membership-churn', seed);
    const r = f.rng.fork('churn');
    const phases = r.int(3, 5);
    const step = Math.round(f.outageMs / phases);
    const faults: FaultStep[] = [];
    for (let i = 0; i < phases; i++) {
      const groups = splitTeams(r);
      faults.push({ at: f.cutAt + i * step, kind: 'links', cut: crossPairs(groups), hubReach: groups[0] as number[] });
    }
    faults.push({ at: f.healAt, kind: 'links', cut: [], hubReach: ALL });
    return base('membership-churn', seed, f, labWorld(), load(f), faults);
  },
};

export const FAMILIES = Object.keys(GENERATORS) as FamilyId[];

export function generateScenario(family: FamilyId, seed: number): Scenario {
  return GENERATORS[family](seed);
}
