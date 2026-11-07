import type {
  ActorId,
  DecisionRecord,
  NextStep,
  Outcome,
  Point,
  RefusalCode,
  ResourceId,
  TaskId,
  TaskRecord,
  TokenId,
} from '@afterlink/protocol';
import { minCostAssignment } from './assign.ts';
import * as say from './explain.ts';
import { capableMembers, factsFor, rightsGate, shakyFacts, taskGate, type Gate } from './gates.ts';
import {
  MAX_ACTIVE,
  contactInput,
  deadlineAt,
  distance,
  hasDeclined,
  hashText,
  heardAt,
  isActive,
  isUnowned,
  latestBy,
  readView,
  resourceName,
  teamName,
  tieBreak,
  type Input,
  type Member,
  type PlanInput,
  type TransferAsk,
  type View,
} from './view.ts';

export type { PlanInput } from './view.ts';

export type PlannerAction =
  | { type: 'claim'; taskId: TaskId; decision: DecisionRecord; tokens: TokenId[] }
  | { type: 'cover'; taskId: TaskId; decision: DecisionRecord; tokens: TokenId[] }
  | { type: 'refuse'; taskId: TaskId; decision: DecisionRecord }
  | { type: 'defer'; taskId: TaskId; decision: DecisionRecord }
  | { type: 'release'; taskId: TaskId; reason: string; decision: DecisionRecord }
  | { type: 'request-transfer'; resource: ResourceId; from: ActorId; count: number; taskId: TaskId; decision: DecisionRecord };

/** Priority dwarfs every other term, so urgent work is never traded for a shorter walk. */
const PRIORITY_COST = 1000;
const RANK_COST = 20;
const RANK_CAP = 10;
const LOAD_COST = 30;
/** Dearer than crossing the whole site: a capable holder beats any handover, which can stall or fail. */
const TRANSFER_COST = 150;
/** Buckets rather than a smooth curve, so peers ticking moments apart still agree. */
const URGENCY_COST: readonly [withinMs: number, cost: number][] = [
  [60_000, 0],
  [5 * 60_000, 30],
  [10 * 60_000, 60],
];
const RELAXED_COST = 90;
const NO_DEADLINE_COST = 120;
/** Ties sit below one unit of cost and are settled by a stable hash of the pairing. */
const TIE_SPAN = 1024;
const CANDIDATES_SHOWN = 6;

interface Job {
  task: TaskRecord;
  cover: boolean;
  capable: Member[];
  willing: Set<ActorId>;
  needs: Map<ResourceId, number>;
  fixedCost: number;
  hash: number;
}

interface Slot {
  member: Member;
  load: number;
  at: Point;
}

interface Assignment {
  member: Member;
  tokens: TokenId[];
  asks: TransferAsk[];
}

type RightsPath = 'held' | 'transfer' | null;

function urgencyCost(view: View, task: TaskRecord): number {
  const due = deadlineAt(task, view.capsule);
  if (due === undefined) return NO_DEADLINE_COST;
  const left = due - view.input.now;
  for (const [withinMs, cost] of URGENCY_COST) if (left <= withinMs) return cost;
  return RELAXED_COST;
}

function fixedCost(view: View, task: TaskRecord): number {
  const rank = view.capsule.objectives.find((o) => o.id === task.spec.objective)?.rank ?? RANK_CAP;
  return (task.spec.priority - 1) * PRIORITY_COST + Math.min(Math.max(rank, 0), RANK_CAP) * RANK_COST + urgencyCost(view, task);
}

function totalNeeds(task: TaskRecord): Map<ResourceId, number> {
  const needs = new Map<ResourceId, number>();
  for (const { resource, count } of task.spec.needs) needs.set(resource, (needs.get(resource) ?? 0) + count);
  return needs;
}

function rightsPath(view: View, job: Job, actor: ActorId): RightsPath {
  let path: RightsPath = 'held';
  for (const [resource, count] of job.needs) {
    if (view.pool.count(actor, resource) >= count) continue;
    if (view.pool.inContact(resource) < count) return null;
    path = 'transfer';
  }
  return path;
}

function pairCost(fixed: number, away: number, load: number, transfer: boolean): number {
  return fixed + away + LOAD_COST * load + (transfer ? TRANSFER_COST : 0);
}

function slotCost(view: View, job: Job, slot: Slot): number {
  if (!job.willing.has(slot.member.id)) return Infinity;
  const path = rightsPath(view, job, slot.member.id);
  if (!path) return Infinity;
  const cost = pairCost(job.fixedCost, distance(slot.at, job.task.spec.location), slot.load, path === 'transfer');
  return cost * TIE_SPAN + tieBreak(job.hash, slot.member.hash, TIE_SPAN);
}

/**
 * Min-cost assignment in rounds. Each round gives every actor with room at most one task,
 * solved exactly; the next round sees where each actor ended up and how loaded it now is.
 * Runs over the whole group, so identical views give every member the same answer.
 */
function assignJobs(view: View, jobs: readonly Job[]): Map<TaskId, Assignment> {
  const assigned = new Map<TaskId, Assignment>();
  const slots: Slot[] = view.group.map((member) => ({ member, load: member.load, at: member.at }));
  let pending = jobs;
  for (;;) {
    const open = slots.filter((s) => s.load < MAX_ACTIVE);
    if (!open.length || !pending.length) return assigned;

    const matrix: number[][] = open.map(() => []);
    const columns: Job[] = [];
    for (const job of pending) {
      const costs = open.map((slot) => slotCost(view, job, slot));
      if (costs.every((c) => c === Infinity)) continue;
      columns.push(job);
      costs.forEach((c, row) => matrix[row]!.push(c));
    }
    if (!columns.length) return assigned;

    const picks = minCostAssignment(matrix)
      .map((column, row) => ({ column, row }))
      .filter((p) => p.column >= 0)
      .sort((a, b) => a.column - b.column);

    let progressed = false;
    for (const { row, column } of picks) {
      const slot = open[row]!;
      const job = columns[column]!;
      if (!rightsPath(view, job, slot.member.id)) continue;
      assigned.set(job.task.spec.id, { member: slot.member, ...view.pool.reserve(slot.member.id, job.needs) });
      slot.load++;
      slot.at = job.task.spec.location;
      progressed = true;
    }
    if (!progressed) return assigned;
    pending = columns.filter((j) => !assigned.has(j.task.spec.id));
  }
}

/** One actor speaks for the group on a stopped task, so a refusal is not said four times. */
function spokesperson(view: View, task: TaskRecord, capable: readonly Member[]): ActorId {
  const pool = capable.length ? capable : view.group;
  const taskHash = hashText(task.spec.id);
  let best = pool[0]!;
  let bestCost = Infinity;
  for (const m of pool) {
    const cost = distance(m.at, task.spec.location) * TIE_SPAN + tieBreak(taskHash, m.hash, TIE_SPAN);
    if (cost < bestCost) {
      best = m;
      bestCost = cost;
    }
  }
  return best.id;
}

function signature(refusal: RefusalCode | undefined, next: readonly NextStep[] | undefined): string {
  return `${refusal ?? ''}|${(next ?? []).join(',')}`;
}

function isSameVerdict(d: DecisionRecord | undefined, refusal: RefusalCode, next: readonly NextStep[]): boolean {
  return !!d && signature(d.refusal, d.next) === signature(refusal, next);
}

/** The record already holds this verdict, from this actor or as the group's latest word. */
function alreadySaid(task: TaskRecord, self: ActorId, refusal: RefusalCode, next: readonly NextStep[]): boolean {
  return isSameVerdict(task.decisions[task.decisions.length - 1], refusal, next) || isSameVerdict(latestBy(task, self), refusal, next);
}

function compareCandidates(view: View, task: TaskRecord, needs: ReadonlyMap<ResourceId, number>): NonNullable<DecisionRecord['candidates']> {
  const { requires } = task.spec;
  const fixed = fixedCost(view, task);
  const rows = view.group.map((m) => {
    const skills = view.skills.get(m.team.id)!;
    const missing = requires.filter((c) => !skills.has(c));
    const held = [...needs.keys()].filter((r) => view.holdings.get(m.id)?.has(r));
    const away = distance(m.at, task.spec.location);
    const eligible = !missing.length && m.load < MAX_ACTIVE && !hasDeclined(task, m.id);
    const notes = [
      ...(missing.length ? [`no ${say.listOf(missing.map(say.capabilityName))}`] : []),
      ...(hasDeclined(task, m.id) ? ['declined'] : []),
      ...(m.load >= MAX_ACTIVE ? ['at capacity'] : []),
      `${away} away`,
      `${m.load} active`,
      ...held.map((r) => `holds ${say.thingName(resourceName(view, r))}`),
    ];
    const lacking = [...needs.keys()].some((r) => !held.includes(r));
    const score = eligible ? pairCost(fixed, away, m.load, lacking) : -1;
    return { actor: m.id, team: m.team.id, score, note: notes.join(', ') };
  });
  rows.sort((a, b) => {
    if ((a.score < 0) !== (b.score < 0)) return a.score < 0 ? 1 : -1;
    return a.score - b.score || (a.actor < b.actor ? -1 : 1);
  });
  return rows.slice(0, CANDIDATES_SHOWN);
}

interface Verdict {
  outcome: Outcome;
  refusal?: RefusalCode;
  next?: NextStep[];
  reason: string;
  policy: string;
  inputs: Input[];
  tokens?: TokenId[];
}

function record(view: View, task: TaskRecord, needs: ReadonlyMap<ResourceId, number>, v: Verdict): DecisionRecord {
  const { self, now, horizon } = view.input;
  const taskId = task.spec.id;
  const stamp = `${self}|${taskId}|${v.outcome}|${signature(v.refusal, v.next)}|${now}`;
  return {
    id: `${hashText(stamp).toString(36)}-${hashText(`${stamp}|${v.reason}`).toString(36)}`,
    actor: self,
    taskId,
    outcome: v.outcome,
    ...(v.refusal ? { refusal: v.refusal } : {}),
    ...(v.next ? { next: v.next } : {}),
    reason: v.reason,
    policy: v.policy,
    reachable: [...view.peers],
    horizon: { ...horizon },
    inputs: v.inputs,
    ...(v.tokens?.length ? { tokens: v.tokens } : {}),
    candidates: compareCandidates(view, task, needs),
  };
}

function stopAction(view: View, task: TaskRecord, needs: ReadonlyMap<ResourceId, number>, gate: Gate): PlannerAction {
  const deferred = gate.refusal === 'DEPENDENCY_UNMET';
  const decision = record(view, task, needs, { ...gate, outcome: deferred ? 'DEFERRED' : 'REFUSED' });
  return { type: deferred ? 'defer' : 'refuse', taskId: task.spec.id, decision };
}

function fitReason(view: View, job: Job, tokens: readonly TokenId[]): string {
  const { me } = view;
  const { location, requires } = job.task.spec;
  const others = job.capable.filter((m) => m.id !== me.id);
  const away = distance(me.at, location);
  const held = [...new Set(tokens.map((t) => view.input.state.tokens[t]!.resource))].map((r) => resourceName(view, r));
  return say.assigned({
    team: me.team.name,
    capabilities: requires,
    only: !others.length,
    closest: others.every((m) => away <= distance(m.at, location)),
    leastBusy: others.every((m) => me.load < m.load),
    held,
    shaky: job.task.spec.reversible ? shakyFacts(factsFor(view, job.task)) : [],
  });
}

function inputsOf(view: View, task: TaskRecord): Input[] {
  return factsFor(view, task).map(({ key, ageMs, state }) => ({ key, ageMs, state }));
}

function claimAction(view: View, job: Job, tokens: TokenId[]): PlannerAction {
  const { task, needs } = job;
  const shaky = task.spec.reversible && shakyFacts(factsFor(view, task)).length > 0;
  const decision = record(view, task, needs, {
    outcome: 'ACCEPTED',
    reason: fitReason(view, job, tokens),
    policy: shaky ? 'task.reversible' : 'planner.min-cost-assignment',
    inputs: inputsOf(view, task),
    tokens,
  });
  return { type: 'claim', taskId: task.spec.id, decision, tokens };
}

function coverAction(view: View, job: Job, tokens: TokenId[]): PlannerAction {
  const { task, needs } = job;
  const owner = task.owner!;
  const decision = record(view, task, needs, {
    outcome: 'ACCEPTED',
    reason: say.covering(teamName(view, owner), view.input.now - heardAt(view, owner), task.spec.priority),
    policy: 'fallback.coverAfterMs',
    inputs: [...inputsOf(view, task), contactInput(view, owner)],
    tokens,
  });
  return { type: 'cover', taskId: task.spec.id, decision, tokens };
}

/** Rights are held by a peer in contact: say so once, and ask for them. */
function askActions(view: View, job: Job, asks: readonly TransferAsk[]): PlannerAction[] {
  const { task, needs } = job;
  const next: NextStep[] = ['REQUEST_TRANSFER'];
  if (isSameVerdict(latestBy(task, view.input.self), 'NO_RIGHT', next)) return [];
  const holders = [...new Set(asks.map((a) => teamName(view, a.from)))];
  const things = [...new Set(asks.map((a) => resourceName(view, a.resource)))];
  const decision = record(view, task, needs, {
    outcome: 'REFUSED',
    refusal: 'NO_RIGHT',
    next,
    reason: say.asking(holders, things),
    policy: 'authority.exclusive-token',
    inputs: [...inputsOf(view, task), ...asks.map((a) => contactInput(view, a.from))],
  });
  return [
    { type: 'refuse', taskId: task.spec.id, decision },
    ...asks.map((a): PlannerAction => ({ type: 'request-transfer', ...a, taskId: task.spec.id, decision })),
  ];
}

/** The owner and anyone covering have all gone quiet for longer than the mission allows. */
function isCoverable(view: View, task: TaskRecord): boolean {
  if (!isActive(task)) return false;
  const { coverAfterMs, coverMaxPriority } = view.capsule.fallback;
  if (task.spec.priority > coverMaxPriority) return false;
  const doers = [task.owner!, ...(task.coveredBy ?? [])];
  return doers.every((a) => !view.members.has(a) && view.input.now - heardAt(view, a) > coverAfterMs);
}

function lostClaim(task: TaskRecord, self: ActorId): boolean {
  if (!isActive(task) || task.owner === self || task.coveredBy?.includes(self)) return false;
  return latestBy(task, self)?.outcome === 'ACCEPTED';
}

function releaseAction(view: View, task: TaskRecord): PlannerAction {
  const reason = say.lostRace(teamName(view, task.owner!));
  const decision = record(view, task, totalNeeds(task), {
    outcome: 'CONFLICTED',
    reason,
    policy: 'task.claim-tie-break',
    inputs: inputsOf(view, task),
  });
  return { type: 'release', taskId: task.spec.id, reason, decision };
}

/**
 * Decides what this actor does next, from its own view alone.
 *
 * Every actor in contact runs the same assignment over the same group and acts only on its
 * own row, so no leader is needed: identical views give disjoint work, and differing views
 * meet at the claim tie-break. Pure and deterministic. Tasks stopped for the whole group are
 * reported by one spokesperson, and only when the record does not already say so, which
 * makes repeated ticks over an unchanged situation silent.
 */
export function plan(input: PlanInput): PlannerAction[] {
  const view = readView(input);
  if (!view) return [];
  const { self } = input;
  const actions: PlannerAction[] = [];
  const jobs: Job[] = [];

  for (const task of view.tasks) {
    if (lostClaim(task, self)) actions.push(releaseAction(view, task));
    const cover = isCoverable(view, task);
    if (!cover && !isUnowned(task)) continue;

    const capable = capableMembers(view, task);
    const needs = totalNeeds(task);
    const willing = capable.filter((m) => !hasDeclined(task, m.id));
    const gate = taskGate(view, task, capable, willing);
    if (gate) {
      const speaks = spokesperson(view, task, capable) === self;
      if (speaks && !alreadySaid(task, self, gate.refusal, gate.next)) actions.push(stopAction(view, task, needs, gate));
      continue;
    }
    jobs.push({
      task,
      cover,
      capable,
      willing: new Set(willing.map((m) => m.id)),
      needs,
      fixedCost: fixedCost(view, task),
      hash: hashText(task.spec.id),
    });
  }

  const assigned = assignJobs(view, jobs);

  for (const job of jobs) {
    const { task, needs } = job;
    const got = assigned.get(task.spec.id);
    if (got) {
      if (got.member.id !== self) continue;
      if (got.asks.length) actions.push(...askActions(view, job, got.asks));
      else actions.push(job.cover ? coverAction(view, job, got.tokens) : claimAction(view, job, got.tokens));
      continue;
    }
    if (job.capable.some((m) => job.willing.has(m.id) && rightsPath(view, job, m.id))) continue;
    if (spokesperson(view, task, job.capable) !== self) continue;
    const gate = rightsGate(view, task, needs);
    if (gate && !alreadySaid(task, self, gate.refusal, gate.next)) actions.push(stopAction(view, task, needs, gate));
  }
  return actions;
}
