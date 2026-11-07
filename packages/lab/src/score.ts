import type { Json, TaskId, TokenId } from '@afterlink/protocol';
import type { Scenario } from './scenario.ts';
import type { SystemReport, TraceEntry } from './system.ts';

/** Raw per-run measurements. Every figure in SUMMARY.md and headline.json is computed from these. */
export interface RunMetrics {
  tasksReported: number;
  tasksCompleted: number;
  completedDuringOutage: number;
  p1ReportedDuringOutage: number;
  p1CompletedDuringOutage: number;
  /** Ms from the cut to the first assignment or typed refusal inside the window. Null when nothing was decided. */
  firstDecisionMs: number | null;
  decidedInWindow: number;
  exclusiveDoubleBookings: number;
  unsafeActions: number;
  dependencyViolations: number;
  lostCompletions: number;
  conservationBreaches: number;
  attacksAccepted: number;
  unauthorisedCommits: number | null;
  replayDivergence: number | null;
  /** Sum of the eight counts above. */
  invariantViolations: number;
  unsafeAllocationsRefused: number;
  /** Refusals where ground truth shows the alternative was a real over-commitment or an action on a false fact. */
  refusalsConfirmedByTruth: number;
  duplicateEffortTasks: number;
  converged: number;
  reconcileMs: number | null;
  bytesToReconcile: number | null;
  /** The part of bytesToReconcile spent backfilling an observer, not reaching peers. */
  observerBytesToReconcile: number | null;
  bytesTotal: number;
  rightsInTransit: number | null;
  conflictsSurfaced: number;
  conflictsUnresolved: number;
  silentOverwrites: number;
  attacksRejected: number;
  attacksDetected: number;
  ferryNewFirst: number | null;
  ferryNewSecond: number | null;
  restartDefects: number | null;
}

const UNSAFE_CODES = new Set(['NO_RIGHT', 'TOKEN_IN_TRANSIT', 'STALE_KNOWLEDGE', 'BLOCKED_BY_CONTINGENCY']);

function truthAt(s: Scenario, key: string, t: number): Json | undefined {
  let value: Json | undefined;
  for (const c of s.truth) if (c.key === key && c.at <= t) value = c.value;
  return value;
}

function inWindow(s: Scenario, t: number): boolean {
  return s.windows.some((w) => t >= w.from && t <= w.to);
}

/** Token commitments still standing at the end: walking away from a task gives back what was booked for it. */
function standingCommitments(trace: TraceEntry[]): Map<TokenId, Set<string>> {
  const out = new Map<TokenId, Set<string>>();
  for (const e of [...trace].sort((a, b) => a.t - b.t)) {
    if (e.kind === 'abandon') {
      for (const set of out.values()) set.delete(`${e.task}|${e.actor}`);
    } else if (e.kind === 'commit') {
      const set = out.get(e.token) ?? new Set<string>();
      set.add(`${e.task}|${e.actor}`);
      out.set(e.token, set);
    }
  }
  return out;
}

export interface ScoreInput {
  scenario: Scenario;
  trace: TraceEntry[];
  report: SystemReport;
  reconcileMs: number | null;
  bytesToReconcile: number | null;
  observerBytesToReconcile: number | null;
  bytesTotal: number;
}

export function score({ scenario: s, trace, report, reconcileMs, bytesToReconcile, observerBytesToReconcile, bytesTotal }: ScoreInput): RunMetrics {
  const specs = new Map(s.incidents.map((i) => [i.spec.id, i.spec]));
  const firstDone = new Map<TaskId, number>();
  const completers = new Map<TaskId, Set<number>>();
  for (const e of trace) {
    if (e.kind !== 'complete' || !specs.has(e.task)) continue;
    if (!firstDone.has(e.task)) firstDone.set(e.task, e.t);
    const who = completers.get(e.task) ?? new Set<number>();
    who.add(e.actor);
    completers.set(e.task, who);
  }

  let completedDuringOutage = 0;
  let p1CompletedDuringOutage = 0;
  for (const [task, t] of firstDone) {
    if (!inWindow(s, t)) continue;
    completedDuringOutage++;
    if (specs.get(task)?.priority === 1) p1CompletedDuringOutage++;
  }
  const p1ReportedDuringOutage = s.incidents.filter((i) => i.spec.priority === 1 && inWindow(s, i.at)).length;

  const from = s.windows[0]?.from ?? 0;
  const to = s.windows[0]?.to ?? s.horizonMs;
  const firstDecision = trace.find((e) => (e.kind === 'assign' || e.kind === 'refuse') && e.t >= from && e.t <= to);
  const firstDecisionMs = firstDecision ? firstDecision.t - from : null;

  const commitments = standingCommitments(trace);
  let exclusiveDoubleBookings = 0;
  for (const set of commitments.values()) exclusiveDoubleBookings += Math.max(0, set.size - 1);

  let unsafeActions = 0;
  let dependencyViolations = 0;
  for (const e of trace) {
    if (e.kind !== 'start') continue;
    const spec = specs.get(e.task);
    if (!spec) continue;
    if (!spec.reversible && (spec.reliesOn ?? []).some((key) => truthAt(s, key, e.t) === false)) unsafeActions++;
    for (const parent of spec.dependsOn) {
      const done = firstDone.get(parent);
      if (done === undefined || done > e.t) dependencyViolations++;
    }
  }

  const refusals = new Map<string, Extract<TraceEntry, { kind: 'refuse' }>>();
  for (const e of trace) {
    if (e.kind !== 'refuse' || !UNSAFE_CODES.has(e.code)) continue;
    const key = `${e.task}|${e.code}`;
    if (!refusals.has(key)) refusals.set(key, e);
  }
  const issued = new Map(s.world.resources.map((r) => [r.id, r.tokens.map((t) => t.id)]));
  const commitsOfOthers = (resource: string, task: TaskId) =>
    (issued.get(resource) ?? []).filter((token) => [...(commitments.get(token) ?? [])].some((c) => !c.startsWith(`${task}|`))).length;
  let refusalsConfirmedByTruth = 0;
  for (const r of refusals.values()) {
    const spec = specs.get(r.task);
    if (!spec) continue;
    const overCommit = spec.needs.some((n) => commitsOfOthers(n.resource, r.task) + n.count > (issued.get(n.resource)?.length ?? 0));
    const falseFact = (spec.reliesOn ?? []).some((key) => truthAt(s, key, r.t) === false);
    if (overCommit || falseFact) refusalsConfirmedByTruth++;
  }

  const attacksAccepted = report.attacks.filter((a) => a.outcome === 'accepted').length;
  const attacksRejected = report.attacks.filter((a) => a.outcome === 'rejected' || a.outcome === 'no-effect').length;
  const attacksDetected = report.attacks.filter((a) => a.outcome === 'detected').length;

  const invariantViolations =
    exclusiveDoubleBookings +
    unsafeActions +
    dependencyViolations +
    report.lostCompletions +
    report.conservationBreaches +
    attacksAccepted +
    (report.unauthorisedCommits ?? 0) +
    (report.replayDivergence ?? 0);

  return {
    tasksReported: s.incidents.length,
    tasksCompleted: firstDone.size,
    completedDuringOutage,
    p1ReportedDuringOutage,
    p1CompletedDuringOutage,
    firstDecisionMs,
    decidedInWindow: firstDecisionMs === null ? 0 : 1,
    exclusiveDoubleBookings,
    unsafeActions,
    dependencyViolations,
    lostCompletions: report.lostCompletions,
    conservationBreaches: report.conservationBreaches,
    attacksAccepted,
    unauthorisedCommits: report.unauthorisedCommits,
    replayDivergence: report.replayDivergence,
    invariantViolations,
    unsafeAllocationsRefused: refusals.size,
    refusalsConfirmedByTruth,
    duplicateEffortTasks: [...completers.values()].filter((w) => w.size > 1).length,
    converged: report.converged ? 1 : 0,
    reconcileMs,
    bytesToReconcile,
    observerBytesToReconcile,
    bytesTotal,
    rightsInTransit: report.rightsInTransit,
    conflictsSurfaced: report.conflictsSurfaced,
    conflictsUnresolved: report.conflictsUnresolved,
    silentOverwrites: report.silentOverwrites,
    attacksRejected,
    attacksDetected,
    ferryNewFirst: report.ferryNewFirst,
    ferryNewSecond: report.ferryNewSecond,
    restartDefects: report.restartDefects,
  };
}
