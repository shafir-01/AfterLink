/**
 * AfterLink shared contracts. Every package builds against this file.
 * Additive changes only. Serialised shapes are version 1.
 */

// ---------- Identifiers ----------
export type ActorId = string; // base64url Ed25519 public key
export type EventId = string; // base64url SHA-256 of the canonical unsigned envelope
export type MissionId = string;
export type TeamId = string;
export type TaskId = string;
export type TokenId = string; // one indivisible right, e.g. "evac-chair#1"
export type ResourceId = string; // resource class, e.g. "evac-chair"
export type TransferId = string;
export type Capability = string; // e.g. "first-aid", "mobility", "repair", "haul"

// ---------- Mission capsule: a signed, portable mission ----------
export interface TeamSpec {
  id: TeamId;
  name: string;
  capabilities: Capability[];
  /** Where the team starts, in abstract site coordinates 0..100. */
  home: Point;
}
export interface Point { x: number; y: number }

export interface ResourceSpec {
  id: ResourceId;
  name: string;
  /** Exclusive resources are numbered tokens. Each token has exactly one holder. */
  tokens: { id: TokenId; holderTeam: TeamId }[];
}

export type ObjectiveId = string;
export interface Objective {
  id: ObjectiveId;
  title: string;
  /** Lower rank wins when objectives compete. */
  rank: number;
}

export interface FallbackPolicy {
  /** A reachable team may start cover on a task whose owner is unreachable after this many ms. */
  coverAfterMs: number;
  /** Tasks at or above this priority may be covered without a human. 1 is the highest priority. */
  coverMaxPriority: number;
  /** Task kinds that must wait for a human even when authority is held. */
  humanApprovalKinds: string[];
}

export interface ContingencyRule {
  id: string;
  /** Observation that activates the rule. */
  when: { key: string; equals: Json };
  /** Task kinds whose location or route changes, or tasks that become blocked. */
  then: { blockKinds?: string[]; spawn?: TaskSpec[]; note: string };
}

export interface MissionCapsule {
  v: 1;
  id: MissionId;
  version: number;
  name: string;
  objective: string;
  objectives: Objective[];
  teams: TeamSpec[];
  resources: ResourceSpec[];
  tasks: TaskSpec[];
  contingencies: ContingencyRule[];
  fallback: FallbackPolicy;
  /** Organiser public key: root of authority for this mission. */
  issuer: ActorId;
  issuedAt: number;
}

// ---------- Tasks ----------
export type TaskStatus =
  | 'open'
  | 'claimed'
  | 'accepted'
  | 'completed'
  | 'deferred'
  | 'refused'
  | 'conflicted'
  | 'cancelled';

export interface TaskSpec {
  id: TaskId;
  kind: string;
  title: string;
  /** Short spoken and on-screen instruction for the field. */
  brief: string;
  objective: ObjectiveId;
  priority: 1 | 2 | 3;
  location: Point;
  locationName: string;
  requires: Capability[];
  /** Resource classes this task must hold a token of before commitment. */
  needs: { resource: ResourceId; count: number }[];
  dependsOn: TaskId[];
  /** Reversible work may proceed on stale knowledge. Irreversible work may not. */
  reversible: boolean;
  /** Keys of observations this task relies on. */
  reliesOn?: string[];
  deadlineMs?: number;
}

// ---------- Typed outcomes ----------
export type Outcome = 'ACCEPTED' | 'COMPLETED' | 'DEFERRED' | 'REFUSED' | 'CONFLICTED' | 'UNKNOWN';

export type RefusalCode =
  | 'NO_RIGHT' // the token is held by someone unreachable
  | 'NO_CAPABILITY'
  | 'DEPENDENCY_UNMET'
  | 'STALE_KNOWLEDGE'
  | 'HUMAN_APPROVAL_REQUIRED'
  | 'TOKEN_IN_TRANSIT'
  | 'BLOCKED_BY_CONTINGENCY';

export type NextStep = 'REQUEST_TRANSFER' | 'WAIT_FOR_CONTACT' | 'SUBSTITUTE' | 'ESCALATE' | 'CARRY_UPDATE';

// ---------- Decision records: why, on what knowledge ----------
export interface DecisionRecord {
  id: string;
  actor: ActorId;
  taskId: TaskId;
  outcome: Outcome;
  refusal?: RefusalCode;
  next?: NextStep[];
  /** One plain sentence a volunteer can understand. */
  reason: string;
  /** Rule from the capsule or protocol that governed this decision. */
  policy: string;
  /** Peers reachable at decision time. */
  reachable: ActorId[];
  /** Per-actor highest sequence seen at decision time: the knowledge horizon. */
  horizon: Record<ActorId, number>;
  /** Observation keys used, with age in ms at decision time. */
  inputs: { key: string; ageMs: number; state: KnowledgeState }[];
  tokens?: TokenId[];
  /** Candidates compared, for the "why me" explanation. */
  candidates?: { actor: ActorId; team: TeamId; score: number; note: string }[];
}

export type KnowledgeState = 'confirmed' | 'local' | 'stale' | 'contradicted' | 'pending' | 'unreachable';

// ---------- Observations ----------
export interface Observation {
  key: string; // e.g. "gate.north.open"
  value: Json;
  subject: string;
  observedAt: number;
  validForMs: number; // 0 = durable until contradicted
  source: ActorId;
}

// ---------- Event bodies ----------
export interface EventBodies {
  'mission.issued': { capsule: MissionCapsule };
  'actor.joined': { team: TeamId; name: string; credential: Credential };
  'task.created': { spec: TaskSpec; source: TaskSource };
  'task.claimed': { taskId: TaskId; decision: DecisionRecord };
  'task.accepted': { taskId: TaskId; via: 'tap' | 'voice' | 'auto' };
  'task.completed': { taskId: TaskId; evidence: string; via: 'tap' | 'voice' | 'auto' };
  'task.deferred': { taskId: TaskId; decision: DecisionRecord };
  'task.refused': { taskId: TaskId; decision: DecisionRecord };
  'task.released': { taskId: TaskId; reason: string };
  'task.covered': { taskId: TaskId; decision: DecisionRecord };
  'right.committed': { tokens: TokenId[]; taskId: TaskId };
  'right.offered': { transfer: TransferId; tokens: TokenId[]; to: ActorId };
  'right.accepted': { transfer: TransferId };
  'right.declined': { transfer: TransferId };
  'observation.recorded': { observation: Observation };
  'link.changed': { peer: ActorId; state: LinkState; transport: TransportKind };
  'ferry.received': { packetId: string; from: ActorId; events: number; newEvents: number };
  'conflict.resolved': { conflictId: string; resolution: string; keep: EventId[] };
}
export type EventType = keyof EventBodies;

export interface TaskSource {
  kind: 'capsule' | 'human' | 'voice' | 'external' | 'contingency';
  /** Stable external id, used for idempotent ingest. */
  ref?: string;
}

export interface Credential {
  /** Signed by the mission issuer. Binds a device key to a team for one mission. */
  mission: MissionId;
  actor: ActorId;
  team: TeamId;
  /** Exactly one custodian per team may act on the team's tokens. */
  custodian: boolean;
  sig: string;
}

/** Everything one device needs to act alone. Delivered by URL fragment, QR or postMessage. */
export interface ProvisionBundle {
  v: 1;
  room: string;
  genesis: EventEnvelope<'mission.issued'>;
  actor: { publicKey: ActorId; secretKey: string };
  team: TeamId;
  name: string;
  credential: Credential;
  /** Public identities of all provisioned actors, so peers can be verified offline. */
  roster: { actor: ActorId; team: TeamId; name: string; custodian: boolean; credential: Credential }[];
}

/** The only unit that crosses any transport. Identical over WebRTC, QR and memory. */
export interface EventEnvelope<T extends EventType = EventType> {
  v: 1;
  id: EventId;
  mission: MissionId;
  actor: ActorId;
  seq: number; // per-actor, starts at 1, no gaps
  prev: EventId | null; // hash chain within one actor's log
  parents: EventId[]; // causal heads seen from other actors
  lamport: number;
  wall: number; // display only, never authoritative
  type: T;
  body: EventBodies[T];
  sig: string; // base64url Ed25519 over the id bytes
}
export type AnyEvent = { [K in EventType]: EventEnvelope<K> }[EventType];

// ---------- Sync ----------
/** Per-actor head digest used for anti-entropy. */
export interface SyncSummary {
  mission: MissionId;
  heads: Record<ActorId, { seq: number; id: EventId }>;
}

export type WireMessage =
  | { t: 'summary'; summary: SyncSummary }
  | { t: 'events'; events: AnyEvent[]; final: boolean }
  | { t: 'ping'; n: number }
  | { t: 'pong'; n: number };

// ---------- Transport ----------
export type TransportKind = 'webrtc' | 'memory' | 'ferry';
export type LinkState = 'connecting' | 'open' | 'severed' | 'closed';

export interface LinkInfo {
  peer: ActorId;
  state: LinkState;
  transport: TransportKind;
  rttMs?: number;
  sent: number;
  received: number;
  lastHeardAt?: number;
}

/** Real link. Closing or severing must stop bytes, not just a flag. */
export interface Link {
  readonly peer: ActorId;
  readonly kind: TransportKind;
  readonly state: LinkState;
  send(msg: WireMessage): void;
  onMessage(fn: (msg: WireMessage) => void): void;
  onState(fn: (s: LinkState) => void): void;
  close(reason: 'severed' | 'closed'): void;
}

/** A faulty network between actors: fault injection acts on real links. */
export interface FaultPlan {
  /** Peers this actor must not talk to. */
  blocked: ActorId[];
  lossRate?: number; // 0..1
  duplicateRate?: number; // 0..1
  delayMs?: number;
  reorder?: boolean;
}

// ---------- Signalling ----------
export type SignalMessage =
  | { t: 'hello'; room: string; actor: ActorId }
  | { t: 'peers'; peers: ActorId[] }
  | { t: 'joined'; actor: ActorId }
  | { t: 'left'; actor: ActorId }
  | { t: 'signal'; from: ActorId; to: ActorId; data: unknown }
  /** Device to HQ observer. Read-only reporting; HQ never replies with decisions. */
  | { t: 'report'; actor: ActorId; events: AnyEvent[]; links: LinkInfo[] }
  /** External request entering through the ingress gateway, delivered to any connected device. */
  | { t: 'ingress'; ref: string; spec: TaskSpec };

export interface SignalClient {
  readonly connected: boolean;
  send(msg: SignalMessage): void;
  onMessage(fn: (msg: SignalMessage) => void): void;
  onState(fn: (up: boolean) => void): void;
  close(): void;
}

// ---------- Ferry: physical carriage ----------
export interface FerryPacket {
  v: 1;
  id: string;
  mission: MissionId;
  from: ActorId;
  createdAt: number;
  /** Only events the sender believes the receiver is missing, highest priority first. */
  events: AnyEvent[];
  /** The sender's summary, so the return trip can close the loop. */
  summary: SyncSummary;
  sig: string;
}

/** One frame of a chunked QR sequence. */
export interface FerryFrame {
  id: string; // packet id prefix
  i: number;
  n: number;
  data: string; // base64url slice of a deflated packet
  c?: string; // per-frame checksum
}

// ---------- Derived state ----------
export interface TaskRecord {
  spec: TaskSpec;
  status: TaskStatus;
  source: TaskSource;
  owner?: ActorId;
  coveredBy?: ActorId[];
  decisions: DecisionRecord[];
  createdBy: ActorId;
  updatedAt: number;
  evidence?: string;
}

export interface TokenRecord {
  id: TokenId;
  resource: ResourceId;
  holder: ActorId | null;
  holderTeam: TeamId;
  state: 'held' | 'in-transit' | 'committed';
  committedTo?: TaskId;
  transfer?: TransferId;
  /** Event ids from issue to current state. */
  chain: EventId[];
}

export interface ActorRecord {
  id: ActorId;
  team: TeamId;
  name: string;
  lastSeq: number;
  lastSeenWall: number;
}

export interface ConflictRecord {
  id: string;
  /** clean: merged automatically. policy: resolved by a rule. violation: invariant broken. */
  severity: 'policy' | 'violation';
  kind: 'duplicate-effort' | 'double-claim' | 'token-fork' | 'stale-decision' | 'forged-event' | 'unauthorised-action';
  taskId?: TaskId;
  tokenId?: TokenId;
  events: EventId[];
  summary: string;
  resolved: boolean;
  resolution?: string;
}

export interface MissionState {
  mission: MissionId;
  capsule: MissionCapsule | null;
  actors: Record<ActorId, ActorRecord>;
  tasks: Record<TaskId, TaskRecord>;
  tokens: Record<TokenId, TokenRecord>;
  observations: Record<string, Observation[]>;
  conflicts: ConflictRecord[];
  eventCount: number;
}

// ---------- After-action ----------
export interface PartitionEpisode {
  id: string;
  from: number;
  to: number | null;
  groups: ActorId[][];
  tasksDone: number;
  decisions: number;
  refusals: number;
}

export interface MissionRecord {
  mission: MissionId;
  events: number;
  actors: number;
  episodes: PartitionEpisode[];
  doneWhileHqBlind: number;
  refusedUnsafe: number;
  duplicatesPrevented: number;
  conflicts: ConflictRecord[];
  conservation: { resource: ResourceId; issued: number; committed: number; held: number; inTransit: number; ok: boolean }[];
  timeline: TimelineEntry[];
  unknowns: string[];
}

export interface TimelineEntry {
  at: number;
  lamport: number;
  actor: ActorId;
  team: TeamId;
  event: EventId;
  type: EventType;
  label: string;
  /** True when no central observer saw this at the time. */
  hiddenFromHq: boolean;
  taskId?: TaskId;
}

// ---------- Helper ----------
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
