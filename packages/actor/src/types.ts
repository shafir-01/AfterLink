import type {
  ActorId,
  AnyEvent,
  DecisionRecord,
  EventId,
  FaultPlan,
  FerryPacket,
  Json,
  Link,
  LinkInfo,
  MissionState,
  ProvisionBundle,
  ResourceId,
  SignalClient,
  SyncSummary,
  TaskId,
  TaskRecord,
  TaskSource,
  TaskSpec,
  TeamId,
  TokenId,
  TokenRecord,
  TransferId,
} from '@afterlink/protocol';
import type { LinkConnector } from '@afterlink/mesh';
import type { ActorStorage } from './storage.ts';

export interface ActorOptions {
  bundle: ProvisionBundle;
  connector: LinkConnector;
  signal?: SignalClient;
  storage?: ActorStorage;
  now?: () => number;
  /** Simulates a volunteer tapping accept and done. Must stay off on a real human device. */
  autopilot?: boolean;
  /** Pause before each simulated tap. */
  autopilotDelayMs?: number;
  tickMs?: number;
  /** Subscribers are called at most once per this interval. */
  notifyMs?: number;
}

export interface PendingTransfer {
  transfer: TransferId;
  tokens: TokenId[];
  from: ActorId;
}

export interface ActorView {
  self: { id: ActorId; team: TeamId; name: string; custodian: boolean };
  state: MissionState;
  links: LinkInfo[];
  reachable: ActorId[];
  myTasks: TaskRecord[];
  nextAction: TaskRecord | null;
  /** Held by me. */
  tokens: TokenRecord[];
  refusals: DecisionRecord[];
  lastDecision: DecisionRecord | null;
  horizon: Record<ActorId, number>;
  lastHeard: Record<ActorId, number>;
  summary: SyncSummary;
  pendingTransfers: PendingTransfer[];
  signalUp: boolean;
  /** Events this device delivered to the observer while they were happening. */
  hqSeen: EventId[];
  /** Events this device delivered to the observer only after a blind interval. */
  hqBackfilled: EventId[];
  /** Set while a durable write is failing. Nothing new leaves the device until it clears. */
  storageError: string | null;
}

export interface FerryResult {
  newEvents: number;
  duplicates: number;
  rejected: number;
  /** Authentic events held back until the events before them arrive. */
  buffered: number;
  /** Set when the whole packet was refused. */
  reason?: string;
}

export interface ObserveOptions {
  subject?: string;
  validForMs?: number;
}

export interface ActorNode {
  readonly id: ActorId;
  readonly team: TeamId;
  readonly name: string;
  start(): Promise<void>;
  stop(): void;
  /** Resolves once everything emitted so far is durable. */
  settled(): Promise<void>;
  view(): ActorView;
  subscribe(fn: (v: ActorView) => void): () => void;
  submitTask(spec: TaskSpec, source: TaskSource): void;
  acceptTask(id: TaskId, via?: 'tap' | 'voice' | 'auto'): boolean;
  declineTask(id: TaskId, reason: string): boolean;
  completeTask(id: TaskId, evidence: string, via?: 'tap' | 'voice' | 'auto'): boolean;
  offerTokens(tokens: TokenId[], to: ActorId): TransferId | null;
  answerTransfer(transfer: TransferId, accept: boolean): boolean;
  /** Asks a holder for rights a task needs. Travels like any event, so it can wait for contact or be carried. */
  requestTransfer(resource: ResourceId, taskId: TaskId, from?: ActorId): boolean;
  observe(key: string, value: Json, opts?: ObserveOptions): void;
  setFaults(plan: FaultPlan): void;
  setSignal(c: SignalClient | null): void;
  adoptLink(link: Link): void;
  buildFerry(remote?: SyncSummary): FerryPacket;
  ingestFerry(p: FerryPacket): FerryResult;
  events(): AnyEvent[];
}
