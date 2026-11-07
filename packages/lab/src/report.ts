import type { RunRecord } from './run.ts';
import type { FamilyId } from './scenario.ts';
import type { RunMetrics } from './score.ts';
import { summarize, type Interval, type MetricSummary } from './stats.ts';
import { SYSTEMS, type SystemId } from './system.ts';

export type MetricKey = keyof RunMetrics;

interface MetricInfo {
  key: MetricKey;
  label: string;
  /** Which way is better. Null when the number is context, not a score. */
  better: 'higher' | 'lower' | null;
  unit?: 'ms' | 'bytes' | 'share';
}

export const METRICS: MetricInfo[] = [
  { key: 'completedDuringOutage', label: 'Tasks completed during outage', better: 'higher' },
  { key: 'p1CompletedDuringOutage', label: 'Priority-1 tasks completed during outage', better: 'higher' },
  { key: 'tasksCompleted', label: 'Tasks completed, whole run', better: 'higher' },
  { key: 'decidedInWindow', label: 'Runs with a decision before the window closed', better: 'higher', unit: 'share' },
  { key: 'firstDecisionMs', label: 'Time to first useful decision after the cut', better: 'lower', unit: 'ms' },
  { key: 'exclusiveDoubleBookings', label: 'Exclusive double-bookings', better: 'lower' },
  { key: 'invariantViolations', label: 'Invariant violations, total', better: 'lower' },
  { key: 'unsafeActions', label: 'Irreversible work started on a false fact', better: 'lower' },
  { key: 'dependencyViolations', label: 'Work started before its dependency was done', better: 'lower' },
  { key: 'lostCompletions', label: 'Finished tasks missing from the merged record', better: 'lower' },
  { key: 'conservationBreaches', label: 'Resource conservation breaches', better: 'lower' },
  { key: 'attacksAccepted', label: 'Attacks that changed state', better: 'lower' },
  { key: 'duplicateEffects', label: 'Duplicate deliveries that changed state', better: 'lower' },
  { key: 'unsafeAllocationsRefused', label: 'Unsafe allocations refused', better: null },
  { key: 'refusalsConfirmedByTruth', label: 'Refusals ground truth confirms', better: null },
  { key: 'duplicateEffortTasks', label: 'Tasks finished by two teams', better: 'lower' },
  { key: 'converged', label: 'Runs that converged', better: 'higher', unit: 'share' },
  { key: 'reconcileMs', label: 'Time from heal to convergence', better: 'lower', unit: 'ms' },
  { key: 'bytesToReconcile', label: 'Bytes sent from heal to convergence', better: 'lower', unit: 'bytes' },
  { key: 'bytesTotal', label: 'Bytes sent, whole run', better: 'lower', unit: 'bytes' },
  { key: 'conflictsSurfaced', label: 'Conflicts surfaced after merge', better: null },
  { key: 'conflictsUnresolved', label: 'Conflicts left for a human', better: null },
  { key: 'silentOverwrites', label: 'Contested writes overwritten with no record', better: 'lower' },
  { key: 'attacksRejected', label: 'Attacks with no effect on state', better: null },
  { key: 'attacksDetected', label: 'Attacks that took effect and were surfaced', better: null },
  { key: 'ferryNewFirst', label: 'Records applied from the first ferry copy', better: null },
  { key: 'ferryNewSecond', label: 'Records applied from the repeat ferry copy', better: 'lower' },
  { key: 'restartDefects', label: 'Records lost or re-issued by a restart', better: 'lower' },
];

export const FAMILY_LABELS: Record<FamilyId, string> = {
  connected: 'Connected operation (control)',
  'hub-death': 'Central service dies after peers connect',
  'two-groups': 'Two isolated groups, hub stays with one, then rejoin',
  'hub-death-split': 'Hub dies, then the peers split, then rejoin',
  asymmetric: 'Asymmetric partition with a bridge peer',
  loss: 'Packet loss',
  duplication: 'Packet duplication',
  reorder: 'Packet reorder and delay',
  'retry-storm': 'Loss, duplication, reorder and delay together',
  'transfer-disconnect': 'Disconnect during a resource-right transfer',
  'exclusive-race': 'Simultaneous claims on one exclusive item',
  'stale-observation': 'Stale observation behind an irreversible task',
  'restart-mid-partition': 'Device restart mid-partition',
  'ferry-twice': 'QR ferry across the gap, delivered twice',
  'incompatible-deps': 'Competing assignments with incompatible dependencies',
  'forged-replay': 'Forged, tampered, replayed and insider events',
  'membership-churn': 'Repeated changes in peer membership',
};

export type FamilySummary = Partial<Record<SystemId, Partial<Record<MetricKey, MetricSummary>>>>;
export type Summary = Partial<Record<FamilyId, FamilySummary>>;

export function aggregate(runs: RunRecord[]): Summary {
  const groups = new Map<string, RunRecord[]>();
  for (const r of runs) {
    const key = `${r.family}\u0000${r.system}`;
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }
  const out: Summary = {};
  for (const [key, list] of groups) {
    const [family, system] = key.split('\u0000') as [FamilyId, SystemId];
    const metrics: Partial<Record<MetricKey, MetricSummary>> = {};
    for (const m of METRICS) metrics[m.key] = summarize(list.map((r) => r.metrics[m.key]));
    (out[family] ??= {})[system] = metrics;
  }
  return out;
}

export interface Meta {
  generatedAt: string;
  runsPerFamily: number;
  baseSeed: number;
  families: FamilyId[];
  systems: SystemId[];
  node: string;
  wallSeconds: number;
  timing: Record<string, number>;
}

export interface ResultsFile {
  meta: Meta;
  summary: Summary;
  runs: RunRecord[];
}

const SYSTEM_LABELS: Record<SystemId, string> = {
  central: 'Central dispatcher',
  board: 'Offline board (LWW)',
  afterlink: 'AfterLink',
};

function fmt(x: number, unit?: MetricInfo['unit']): string {
  if (unit === 'ms') return x >= 10_000 ? `${(x / 1000).toFixed(0)} s` : `${(x / 1000).toFixed(1)} s`;
  if (unit === 'bytes') return x >= 1_000_000 ? `${(x / 1_000_000).toFixed(2)} MB` : x >= 1_000 ? `${(x / 1_000).toFixed(1)} kB` : `${x.toFixed(0)} B`;
  if (unit === 'share') return `${(x * 100).toFixed(1)}%`;
  return Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(2);
}

function cell(s: MetricSummary | undefined, m: MetricInfo): string {
  if (!s || s.mean === null || !s.ci95) return 'n/a';
  if (m.unit === 'share') {
    const wilsonCi = s.nonZeroShare95;
    return `${fmt(s.mean, 'share')} (${s.nonZeroRuns}/${s.n})${wilsonCi ? ` [${fmt(wilsonCi.lo, 'share')}, ${fmt(wilsonCi.hi, 'share')}]` : ''}`;
  }
  const missing = s.missing > 0 ? `, none in ${s.missing} of ${s.n + s.missing}` : '';
  if (s.nonZeroRuns === 0) {
    const upper = s.nonZeroShare95 ? `, 95% upper bound ${fmt(s.nonZeroShare95.hi, 'share')} of runs` : '';
    return `0 in ${s.n} runs${upper}${missing}`;
  }
  return `${fmt(s.mean, m.unit)} [${fmt(s.ci95.lo, m.unit)}, ${fmt(s.ci95.hi, m.unit)}]${missing}`;
}

function intervalOf(s: MetricSummary | undefined, m: MetricInfo): Interval | null {
  if (!s) return null;
  return m.unit === 'share' ? s.nonZeroShare95 : s.ci95;
}

export interface Finding {
  family: FamilyId;
  metric: MetricKey;
  label: string;
  afterlink: string;
  baseline: SystemId;
  baselineValue: string;
}

/** Every metric where AfterLink is worse than a baseline and the 95% intervals do not overlap. */
export function unfavourable(summary: Summary, families: FamilyId[]): Finding[] {
  const out: Finding[] = [];
  for (const family of families) {
    const fam = summary[family];
    const mine = fam?.afterlink;
    if (!fam || !mine) continue;
    for (const m of METRICS) {
      if (!m.better) continue;
      const a = intervalOf(mine[m.key], m);
      if (!a) continue;
      for (const baseline of ['central', 'board'] as SystemId[]) {
        const b = intervalOf(fam[baseline]?.[m.key], m);
        if (!b) continue;
        const worse = m.better === 'higher' ? a.hi < b.lo : a.lo > b.hi;
        if (!worse) continue;
        out.push({
          family,
          metric: m.key,
          label: m.label,
          afterlink: cell(mine[m.key], m),
          baseline,
          baselineValue: cell(fam[baseline]?.[m.key], m),
        });
      }
    }
  }
  return out;
}

export function renderSummary(file: ResultsFile, narrative: string): string {
  const { meta, summary } = file;
  const lines: string[] = [];
  lines.push('# AfterLink Continuity: fault lab results', '');
  lines.push(`Generated ${meta.generatedAt} by \`npx tsx packages/lab/src/cli.ts --runs ${meta.runsPerFamily}\`. ${meta.families.length} scenario families, ${meta.runsPerFamily} seeded runs per family, ${meta.systems.length} systems on each seed, ${file.runs.length} runs in total. Node ${meta.node}. ${meta.wallSeconds} s of real time.`, '');
  lines.push('Every figure below is computed from `docs/results/results.json`. Replay any single run with `npx tsx packages/lab/src/cli.ts --replay <family>:<seed>:<system>`.', '');
  lines.push(narrative, '');

  lines.push('## Where AfterLink lost', '');
  lines.push('Generated from the data: every metric where AfterLink is worse than a baseline with non-overlapping 95% intervals.', '');
  const bad = unfavourable(summary, meta.families);
  if (bad.length === 0) {
    lines.push('None.', '');
  } else {
    lines.push('| Family | Metric | AfterLink | Baseline | Baseline value |', '|---|---|---|---|---|');
    for (const f of bad) lines.push(`| ${f.family} | ${f.label} | ${f.afterlink} | ${SYSTEM_LABELS[f.baseline]} | ${f.baselineValue} |`);
    lines.push('');
  }

  lines.push('## Results by family', '');
  lines.push('Cells are mean [95% interval]. Rates are shown with a Wilson interval. A count that is zero in every run shows the 95% upper bound on how often it could occur. "none in k of n" means k runs had no value, and those runs are excluded from the mean, not counted as zero.', '');
  for (const family of meta.families) {
    const fam = summary[family];
    if (!fam) continue;
    lines.push(`### ${FAMILY_LABELS[family]} (\`${family}\`)`, '');
    lines.push(`| Metric | ${meta.systems.map((s) => SYSTEM_LABELS[s]).join(' | ')} |`, `|---|${meta.systems.map(() => '---').join('|')}|`);
    for (const m of METRICS) {
      const cells = meta.systems.map((s) => cell(fam[s]?.[m.key], m));
      if (cells.every((c) => c === 'n/a')) continue;
      lines.push(`| ${m.label} | ${cells.join(' | ')} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export interface HeadlineValue {
  mean: number | null;
  ci95: [number, number] | null;
  n: number;
  /** Runs where this metric had no value at all. */
  noValue: number;
}

export interface HeadlineCard {
  id: string;
  label: string;
  family: FamilyId;
  familyLabel: string;
  metric: MetricKey;
  unit: 'count' | 'ms' | 'bytes' | 'share';
  better: 'higher' | 'lower' | null;
  values: Partial<Record<SystemId, HeadlineValue>>;
}

export interface Headline {
  generatedAt: string;
  source: 'docs/results/results.json';
  runsPerFamily: number;
  familiesRun: number;
  totalRuns: number;
  claim: string;
  systems: Record<SystemId, string>;
  cards: HeadlineCard[];
  /** Metrics where AfterLink did worse, kept next to the wins on purpose. */
  unfavourable: { family: FamilyId; label: string; afterlink: string; baseline: string; baselineValue: string }[];
}

const CARDS: { id: string; label: string; family: FamilyId; metric: MetricKey }[] = [
  { id: 'completed', label: 'Tasks completed during the outage', family: 'hub-death-split', metric: 'completedDuringOutage' },
  { id: 'priority', label: 'Priority-1 tasks completed during the outage', family: 'hub-death-split', metric: 'p1CompletedDuringOutage' },
  { id: 'first-decision', label: 'First useful decision after the cut', family: 'hub-death-split', metric: 'firstDecisionMs' },
  { id: 'double-bookings', label: 'Double-bookings of the one chair', family: 'exclusive-race', metric: 'exclusiveDoubleBookings' },
  { id: 'refused', label: 'Unsafe allocations refused', family: 'exclusive-race', metric: 'unsafeAllocationsRefused' },
  { id: 'unsafe', label: 'Irreversible work started on a false fact', family: 'stale-observation', metric: 'unsafeActions' },
  { id: 'converged', label: 'Runs that converged after rejoining', family: 'hub-death-split', metric: 'converged' },
  { id: 'bytes', label: 'Bytes to reconcile', family: 'hub-death-split', metric: 'bytesToReconcile' },
  { id: 'conflicts', label: 'Conflicts shown after merge', family: 'hub-death-split', metric: 'conflictsSurfaced' },
];

export function headline(file: ResultsFile, claim: string): Headline {
  const { meta, summary } = file;
  const cards: HeadlineCard[] = [];
  for (const c of CARDS) {
    const fam = summary[c.family];
    if (!fam) continue;
    const info = METRICS.find((m) => m.key === c.metric) as MetricInfo;
    const values: Partial<Record<SystemId, HeadlineValue>> = {};
    for (const system of SYSTEMS) {
      const s = fam[system]?.[c.metric];
      if (!s) continue;
      const ci = info.unit === 'share' ? s.nonZeroShare95 : s.ci95;
      values[system] = { mean: s.mean, ci95: ci ? [ci.lo, ci.hi] : null, n: s.n, noValue: s.missing };
    }
    cards.push({ id: c.id, label: c.label, family: c.family, familyLabel: FAMILY_LABELS[c.family], metric: c.metric, unit: info.unit ?? 'count', better: info.better, values });
  }
  return {
    generatedAt: meta.generatedAt,
    source: 'docs/results/results.json',
    runsPerFamily: meta.runsPerFamily,
    familiesRun: meta.families.length,
    totalRuns: file.runs.length,
    claim,
    systems: SYSTEM_LABELS,
    cards,
    unfavourable: unfavourable(summary, meta.families).map((f) => ({
      family: f.family,
      label: f.label,
      afterlink: f.afterlink,
      baseline: SYSTEM_LABELS[f.baseline],
      baselineValue: f.baselineValue,
    })),
  };
}
