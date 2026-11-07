import type { MetricKey, ResultsFile } from './report.ts';
import type { RunRecord } from './run.ts';
import { TIMING, type FamilyId } from './scenario.ts';
import type { MetricSummary } from './stats.ts';
import type { SystemId } from './system.ts';

const metric = (file: ResultsFile, family: FamilyId, system: SystemId, key: MetricKey): MetricSummary | undefined =>
  file.summary[family]?.[system]?.[key];

const n1 = (x: number | null | undefined) => (x === null || x === undefined ? 'n/a' : x.toFixed(1));
const n2 = (x: number | null | undefined) => (x === null || x === undefined ? 'n/a' : x.toFixed(2));

function withCi(s: MetricSummary | undefined): string {
  if (!s || s.mean === null || !s.ci95) return 'n/a';
  return `${n1(s.mean)} [${n1(s.ci95.lo)}, ${n1(s.ci95.hi)}]`;
}

function seconds(s: MetricSummary | undefined): string {
  return s?.mean === null || s?.mean === undefined ? 'none' : `${(s.mean / 1000).toFixed(1)} s`;
}

function kilobytes(s: MetricSummary | undefined): string {
  return s?.mean === null || s?.mean === undefined ? 'n/a' : `${(s.mean / 1000).toFixed(0)} kB`;
}

function overlap(a: MetricSummary | undefined, b: MetricSummary | undefined): boolean {
  if (!a?.ci95 || !b?.ci95) return false;
  return a.ci95.lo <= b.ci95.hi && b.ci95.lo <= a.ci95.hi;
}

function total(runs: RunRecord[], system: SystemId, key: keyof RunRecord['metrics'], keep: (r: RunRecord) => boolean = () => true): number {
  let sum = 0;
  for (const r of runs) {
    if (r.system !== system || !keep(r)) continue;
    const v = r.metrics[key];
    if (typeof v === 'number') sum += v;
  }
  return sum;
}

function runsWith(runs: RunRecord[], system: SystemId, key: keyof RunRecord['metrics'], keep: (r: RunRecord) => boolean = () => true): [number, number] {
  const mine = runs.filter((r) => r.system === system && keep(r));
  return [mine.filter((r) => (r.metrics[key] as number | null) !== 0 && r.metrics[key] !== null).length, mine.length];
}

/** One sentence for the debrief, with every number read from the summary. */
export function oneLineClaim(file: ResultsFile): string {
  const a = metric(file, 'hub-death-split', 'afterlink', 'completedDuringOutage')?.mean;
  const c = metric(file, 'hub-death-split', 'central', 'completedDuringOutage')?.mean;
  const b = metric(file, 'exclusive-race', 'board', 'exclusiveDoubleBookings')?.mean;
  const al = metric(file, 'exclusive-race', 'afterlink', 'exclusiveDoubleBookings')?.mean;
  return `With the hub dead and the peers split, AfterLink completed ${n1(a)} tasks per outage against ${n1(c)} for a central dispatcher, and in the race for one chair it averaged ${n2(al)} double-bookings per run against ${n2(b)} for a last-write-wins board.`;
}

/** The first rows the debrief shows: label, then value. Every number is read from the summary. */
export function displayRows(file: ResultsFile): Record<string, string> {
  const s = 'hub-death-split';
  const a = (k: MetricKey, f: FamilyId = s) => metric(file, f, 'afterlink', k);
  const c = (k: MetricKey, f: FamilyId = s) => metric(file, f, 'central', k);
  const b = (k: MetricKey, f: FamilyId = s) => metric(file, f, 'board', k);
  const noDecision = c('firstDecisionMs')?.missing ?? 0;
  return {
    'Seeded runs': `${file.runs.length} over ${file.meta.families.length} fault families`,
    'Tasks done in outage': `AfterLink ${n1(a('completedDuringOutage')?.mean)}, central ${n1(c('completedDuringOutage')?.mean)}, board ${n1(b('completedDuringOutage')?.mean)}`,
    'First decision after cut': `AfterLink ${seconds(a('firstDecisionMs'))}, central none in ${noDecision} of ${file.meta.runsPerFamily} runs`,
    'Double-bookings, one chair': `AfterLink ${n2(a('exclusiveDoubleBookings', 'exclusive-race')?.mean)}, board ${n2(b('exclusiveDoubleBookings', 'exclusive-race')?.mean)}`,
    'Unsafe starts on a false fact': `AfterLink ${n2(a('unsafeActions', 'stale-observation')?.mean)}, board ${n2(b('unsafeActions', 'stale-observation')?.mean)}`,
    'Converged after rejoining': `AfterLink ${n1((a('converged')?.mean ?? 0) * 100)}%`,
    'Bytes to reconcile': `AfterLink ${kilobytes(a('bytesToReconcile'))}, board ${kilobytes(b('bytesToReconcile'))}, central ${kilobytes(c('bytesToReconcile'))}`,
    'Forged events accepted': `AfterLink ${total(file.runs, 'afterlink', 'attacksAccepted')}, board ${total(file.runs, 'board', 'attacksAccepted')}`,
  };
}

function findings(file: ResultsFile): string[] {
  const { runs } = file;
  const s: FamilyId = 'hub-death-split';
  const out: string[] = ['## What the data shows', ''];
  const a = (k: MetricKey, f: FamilyId = s) => metric(file, f, 'afterlink', k);
  const c = (k: MetricKey, f: FamilyId = s) => metric(file, f, 'central', k);
  const b = (k: MetricKey, f: FamilyId = s) => metric(file, f, 'board', k);

  out.push(`- **Work during the outage.** Hub dead and peers split: AfterLink ${withCi(a('completedDuringOutage'))} tasks, central ${withCi(c('completedDuringOutage'))}, board ${withCi(b('completedDuringOutage'))}. Priority-1: AfterLink ${withCi(a('p1CompletedDuringOutage'))}, central ${withCi(c('p1CompletedDuringOutage'))}, board ${withCi(b('p1CompletedDuringOutage'))}.`);
  out.push(overlap(a('completedDuringOutage'), b('completedDuringOutage'))
    ? '- **AfterLink does not out-work the board.** Their intervals overlap on tasks done during that outage. What separates them is safety, not throughput.'
    : `- **Throughput against the board differs.** AfterLink ${withCi(a('completedDuringOutage'))} against ${withCi(b('completedDuringOutage'))}.`);
  out.push(`- **When the hub survives.** With the hub alive on one side of a split, central did ${withCi(c('completedDuringOutage', 'two-groups'))} tasks and AfterLink ${withCi(a('completedDuringOutage', 'two-groups'))}. Connected, the three are ${withCi(c('completedDuringOutage', 'connected'))}, ${withCi(b('completedDuringOutage', 'connected'))} and ${withCi(a('completedDuringOutage', 'connected'))} (central, board, AfterLink): no system has a throughput edge when nothing is wrong.`);

  const honest = (r: RunRecord) => r.family !== 'forged-replay';
  const [boardRuns, boardAll] = runsWith(runs, 'board', 'exclusiveDoubleBookings', honest);
  const [mineRuns, mineAll] = runsWith(runs, 'afterlink', 'exclusiveDoubleBookings', honest);
  out.push(`- **Double-bookings.** Excluding the attack family: AfterLink ${total(runs, 'afterlink', 'exclusiveDoubleBookings', honest)} in ${mineAll} runs, central ${total(runs, 'central', 'exclusiveDoubleBookings', honest)}, board ${total(runs, 'board', 'exclusiveDoubleBookings', honest)} (in ${boardRuns} of ${boardAll} runs).${mineRuns === 0 ? '' : ` AfterLink had double-bookings in ${mineRuns} runs.`} A compromised custodian holding a valid key can still sign a double spend: see the attack table. AfterLink detects that, it does not prevent it.`);
  out.push(`- **False facts.** Irreversible work started on a fact that was false: AfterLink ${total(runs, 'afterlink', 'unsafeActions')}, central ${total(runs, 'central', 'unsafeActions')}, board ${total(runs, 'board', 'unsafeActions')}, all families.`);
  out.push(`- **Cost of being safe.** In the one-chair race AfterLink finished ${withCi(a('p1CompletedDuringOutage', 'exclusive-race'))} priority-1 tasks in the outage against the board's ${withCi(b('p1CompletedDuringOutage', 'exclusive-race'))}, because it refused what the board double-booked. After a disconnect during a transfer the numbers are ${withCi(a('p1CompletedDuringOutage', 'transfer-disconnect'))} and ${withCi(b('p1CompletedDuringOutage', 'transfer-disconnect'))}. A right in transit stays locked for both sides until contact returns, by design.`);
  out.push(`- **Bandwidth.** AfterLink is the most expensive system on the wire. Connected, it sends ${kilobytes(a('bytesTotal', 'connected'))} per run against ${kilobytes(b('bytesTotal', 'connected'))} for the board and ${kilobytes(c('bytesTotal', 'connected'))} for central. After the hub-dead split it spends ${kilobytes(a('bytesToReconcile'))} to reconcile (${kilobytes(a('observerBytesToReconcile'))} of that backfilling the observer) against ${kilobytes(b('bytesToReconcile'))} and ${kilobytes(c('bytesToReconcile'))}.`);
  const notConverged = runs.filter((r) => r.system === 'afterlink' && !r.metrics.converged);
  const families = [...new Set(notConverged.map((r) => r.family))];
  out.push(notConverged.length === 0
    ? `- **Convergence.** Every AfterLink run converged.`
    : `- **Convergence.** ${notConverged.length} AfterLink runs ended without converging, all in: ${families.join(', ')}. See Known defects below.`);
  const unauthorised = total(runs, 'afterlink', 'unauthorisedCommits', honest);
  const surfaced = runs.filter((r) => r.system === 'afterlink' && honest(r) && (r.violations ?? []).length > 0).length;
  const doubled = total(runs, 'afterlink', 'exclusiveDoubleBookings', honest);
  out.push(surfaced === 0
    ? `- **Honest devices.** No violation was raised against an honest device outside the attack family.`
    : `- **Honest devices.** Outside the attack family, ${surfaced} AfterLink runs raised a violation against an honest device, and an independent replay of the rights ledger counted ${unauthorised} spends by a non-holder. ${doubled === 0 ? 'None became a double-booking.' : `${doubled} double-bookings occurred.`} See Known defects below.`);
  const lost = total(runs, 'afterlink', 'lostCompletions', (r) => r.family === 'forged-replay');
  if (lost > 0) out.push(`- **After a key is compromised.** A device that finds a fork under its own key stops signing, so ${lost} tasks it finished in the attack family never reached the record. That is the safe side of the trade, and it is a real loss of history for that device.`);
  out.push('');
  return out;
}

export function narrative(file: ResultsFile): string {
  const minutes = (ms: number) => (ms / 60_000).toFixed(0);
  return [
    ...findings(file),
    '## How it was measured',
    '',
    `All three systems face the same generated scenario for a seed: the same incidents at the same virtual times, the same hands-on durations, the same fault schedule. Four teams, one device each, one job at a time per team. Time is virtual: about ${minutes(TIMING.connectedMs)} minutes connected, about ${minutes(TIMING.outageMs)} minutes of fault, ${minutes(TIMING.settleMs)} minutes to settle. One scoring function outside all three systems reads one field trace, so no system grades itself.`,
    '',
    '**AfterLink** is the real product: `ActorNode`, `Mesh`, anti-entropy, the planner, the token ledger and Ed25519-signed events, over `MemoryNetwork` in virtual time. Only the volunteer is simulated, tapping accept and done. Faults act on real links and signalling. Double-bookings are counted from the signed events by the lab, and rights are replayed by an independent ledger walk, not by the product\'s own checks.',
    '',
    '**Central dispatcher** is written to be as strong as the design allows: durable ledger, immediate assignment, per-device work queues that keep people busy through an outage, retries over loss, and silent-owner reassignment under the same policy AfterLink uses. It stops assigning only when it cannot be reached. Teams that can reach the hub keep working normally during a split, and all resources sit in one pool with no transfers needed.',
    '',
    '**Offline board (LWW)** works with no server. Each device edits locally, claims up to the same queue depth as AfterLink, pushes every write at once, gossips deltas over links with the same reconnection limits as the real mesh, follows the same cover rule, and has perfect clocks. It lacks only what makes it a last-write-wins board: no rights model, no validity on facts, no record of losing writes.',
    '',
    'Choices that favour the baselines: board completions count even when the task used a double-booked item, a central worker gets credit for queued work finished during an outage, and wire attacks on both baselines are assumed stopped by authenticated channels rather than tested. A carried board export has nothing to verify, so forged and replayed packets are really applied to it.',
    '',
    'Limits on what this shows: bytes are UTF-8 JSON sizes, in-memory links stand in for WebRTC, one device per team, the volunteer always does what the screen says, and the workload is synthetic. "Unsafe allocations refused" is the raw count of typed refusals and "confirmed" is the stricter count where ground truth shows the alternative was a real over-commitment or an action on a false fact. Refusals that simply asked a reachable holder for a transfer are not counted. The mandate family for AI, voice and n8n outages is not run, because no system here calls those services. Results describe this workload and these fault models, nothing wider.',
  ].join('\n');
}
