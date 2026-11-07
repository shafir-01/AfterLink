import type { TaskId, TokenId } from '@afterlink/protocol';
import type { Rng } from './rng.ts';
import type { FaultStep, Incident, Scenario } from './scenario.ts';
import type { Sim } from './sim.ts';

export type SystemId = 'central' | 'board' | 'afterlink';
export const SYSTEMS: SystemId[] = ['central', 'board', 'afterlink'];

/** What happened in the field, in one shape for every system. All scoring reads this, so no system grades itself. */
export type TraceEntry =
  | { t: number; kind: 'assign'; actor: number; task: TaskId; via: 'plan' | 'cover' }
  | { t: number; kind: 'refuse'; actor: number; task: TaskId; code: string }
  | { t: number; kind: 'commit'; actor: number; task: TaskId; token: TokenId }
  | { t: number; kind: 'start'; actor: number; task: TaskId }
  | { t: number; kind: 'abandon'; actor: number; task: TaskId }
  | { t: number; kind: 'complete'; actor: number; task: TaskId };

export interface RunContext {
  scenario: Scenario;
  sim: Sim;
  rng: Rng;
  trace(entry: TraceEntry): void;
  durationOf(task: TaskId): number;
}

/**
 * rejected: stopped at the door. no-effect: taken in, changed nothing. detected: took effect and was
 * surfaced. accepted: took effect silently. assumed: not exercised, channel security is taken as given.
 */
export type AttackOutcome = 'rejected' | 'no-effect' | 'detected' | 'accepted' | 'assumed' | 'not-applicable';

export interface AttackResult {
  attack: string;
  outcome: AttackOutcome;
}

export interface SystemReport {
  /** Every replica holds the same record at the end of the run. */
  converged: boolean;
  /** Conflicts the system shows a human after merge. */
  conflictsSurfaced: number;
  /** Of those, still needing a decision. */
  conflictsUnresolved: number;
  /** Writes replaced by a merge with no record of the loser. */
  silentOverwrites: number;
  /** Tasks some worker finished that the merged record does not show as completed. */
  lostCompletions: number;
  /** Resource units not accounted for by the final record, per the system's own ledger. */
  conservationBreaches: number;
  /** Token spends by an actor that did not hold the token, found by an independent replay of the ledger. Null when the system has no rights model to replay. */
  unauthorisedCommits: number | null;
  /** Rights still in transit at the end of the run. */
  rightsInTransit: number | null;
  /** 1 when re-applying the whole record twice, in random order, gives a different result. Null when the system has no replayable record. */
  replayDivergence: number | null;
  attacks: AttackResult[];
  /** Kinds of invariant violation the system itself raised, one entry per conflict. */
  violations: string[];
  ferryNewFirst: number | null;
  ferryNewSecond: number | null;
  /** Events a restarted device re-issued or lost. */
  restartDefects: number | null;
}

export interface SystemUnderTest {
  readonly id: SystemId;
  start(): Promise<void>;
  inject(incident: Incident): void | Promise<void>;
  apply(step: FaultStep): void | Promise<void>;
  /** Bytes handed to the network so far, as UTF-8 JSON. */
  bytes(): number;
  /** Of those, bytes spent telling an observer rather than reaching peers. */
  observerBytes(): number;
  /** All replicas agree right now. */
  isConverged(): boolean;
  report(): SystemReport | Promise<SystemReport>;
  stop(): void;
}

export function emptyReport(): SystemReport {
  return {
    converged: false,
    conflictsSurfaced: 0,
    conflictsUnresolved: 0,
    silentOverwrites: 0,
    lostCompletions: 0,
    conservationBreaches: 0,
    unauthorisedCommits: null,
    rightsInTransit: null,
    replayDivergence: null,
    attacks: [],
    violations: [],
    ferryNewFirst: null,
    ferryNewSecond: null,
    restartDefects: null,
  };
}
