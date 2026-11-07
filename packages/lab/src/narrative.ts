import type { ResultsFile } from './report.ts';
import type { FamilyId } from './scenario.ts';
import type { MetricKey } from './report.ts';
import { TIMING } from './scenario.ts';
import type { SystemId } from './system.ts';

function mean(file: ResultsFile, family: FamilyId, system: SystemId, metric: MetricKey): number | null {
  return file.summary[family]?.[system]?.[metric]?.mean ?? null;
}

const n1 = (x: number | null) => (x === null ? 'n/a' : x.toFixed(1));

/** One sentence for the debrief, with every number read from the summary. */
export function oneLineClaim(file: ResultsFile): string {
  const f: FamilyId = 'hub-death-split';
  const a = mean(file, f, 'afterlink', 'completedDuringOutage');
  const c = mean(file, f, 'central', 'completedDuringOutage');
  const b = mean(file, 'exclusive-race', 'board', 'exclusiveDoubleBookings');
  const al = mean(file, 'exclusive-race', 'afterlink', 'exclusiveDoubleBookings');
  return `With the hub dead and the peers split, AfterLink completed ${n1(a)} tasks per outage against ${n1(c)} for a central dispatcher, with ${n1(al)} double-bookings of the one chair against ${n1(b)} for a last-write-wins board.`;
}

export function narrative(file: ResultsFile): string {
  const minutes = (ms: number) => (ms / 60_000).toFixed(0);
  return [
    '## How to read this',
    '',
    `All three systems face the same generated scenario for a seed: the same incidents at the same virtual times, the same hands-on durations, the same fault schedule. Four teams, one device each, one job at a time per team. Time is virtual: about ${minutes(TIMING.connectedMs)} minutes connected, about ${minutes(TIMING.outageMs)} minutes of fault, ${minutes(TIMING.settleMs)} minutes to settle. A scoring function outside all three systems reads one field trace, so no system grades itself.`,
    '',
    '**AfterLink** is the real product: `ActorNode`, `Mesh`, anti-entropy, the planner, the token ledger and Ed25519-signed events, over `MemoryNetwork` in virtual time. Only the volunteer is simulated, tapping accept and done. Faults act on real links and signalling.',
    '',
    '**Central dispatcher** is written to be as strong as the design allows: durable ledger, immediate assignment, per-device work queues that keep people busy through an outage, retries over loss, and silent-owner reassignment under the same policy AfterLink uses. It stops assigning only when it cannot be reached. Teams that can reach the hub keep working normally during a split.',
    '',
    '**Offline board (LWW)** works with no server. Each device edits locally, pushes every write at once, gossips deltas over the same links with the same reconnection limits as the real mesh, follows the same cover rule, and has perfect clocks. It lacks only what makes it a last-write-wins board: no rights model, no validity on facts, no record of losing writes. Peers are authenticated on the wire, so outsiders are stopped there; a carried board export has nothing to verify.',
    '',
    'Scoring choices that favour the baselines: board completions count even when the task used a double-booked item, and a central worker gets credit for queued work finished during an outage.',
    '',
    'Limits on what this shows: bytes are UTF-8 JSON sizes, in-memory links stand in for WebRTC, and the volunteer always does what the screen says. The mandate family for AI, voice and n8n outages is not run, because no system here calls those services; their absence from the decision path is checked by the actor and relay tests instead. Results describe this workload and these fault models, nothing wider.',
  ].join('\n');
}
