/**
 * Typed postMessage protocol between the stage and each device iframe.
 * The stage knows a device only through these messages: it never reaches into one.
 */
import type {
  ActorId,
  AnyEvent,
  ConflictRecord,
  DecisionRecord,
  EventId,
  FaultPlan,
  Json,
  LinkInfo,
  ProvisionBundle,
  SyncSummary,
  TaskId,
  TaskRecord,
  TaskSource,
  TaskSpec,
  TeamId,
  TokenId,
  TokenRecord,
} from '@afterlink/protocol';

export const BRIDGE_CHANNEL = 'afterlink/bridge/1';

/** RGBA pixels of one rendered QR frame. The buffer is transferred, not copied. */
export interface FramePixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface ObserveOptions {
  subject?: string;
  validForMs?: number;
}

/** Stage to device. */
export type DeviceCommand =
  /** Boot one actor. `fresh` wipes this device's stored state first. */
  | { kind: 'provision'; bundle: ProvisionBundle; autopilot?: boolean; tickMs?: number; fresh?: boolean }
  /** Hands over the HQ connection. ports[0] is the signalling port; the device proves HQ is alive by heartbeat on it. */
  | { kind: 'hqPort'; epoch: number }
  | { kind: 'setFaults'; plan: FaultPlan }
  | { kind: 'addTask'; spec: TaskSpec; source: TaskSource }
  | { kind: 'observe'; key: string; value: Json; options?: ObserveOptions }
  /** Build a signed packet and emit it as QR frames. */
  | { kind: 'ferryStart'; ferryId: string; remote?: SyncSummary; frameMs?: number }
  /** One rendered frame, exactly as the receiving device's camera would see it. */
  | { kind: 'ferryFrame'; ferryId: string; pixels: FramePixels }
  | { kind: 'requestEvents'; requestId: string }
  /** Stop and start the actor again from its own storage. */
  | { kind: 'restart' };

/** The part of a task the stage needs to draw. */
export interface CompactTask {
  id: TaskId;
  title: string;
  kind: string;
  status: TaskRecord['status'];
  priority: 1 | 2 | 3;
  locationName: string;
  location: { x: number; y: number };
  needs: TaskSpec['needs'];
  owner?: ActorId;
  coveredBy?: ActorId[];
  updatedAt: number;
}

/** What a device chooses to tell the stage about itself. */
export interface CompactView {
  self: { id: ActorId; team: TeamId; name: string; custodian: boolean };
  at: number;
  signalUp: boolean;
  reachable: ActorId[];
  links: LinkInfo[];
  eventCount: number;
  tasks: CompactTask[];
  myTasks: TaskId[];
  nextAction: TaskId | null;
  /** Every token as this device currently believes it stands. */
  tokens: TokenRecord[];
  /** Tokens held by this device. */
  held: TokenId[];
  refusals: DecisionRecord[];
  lastDecision: DecisionRecord | null;
  conflicts: ConflictRecord[];
  horizon: Record<ActorId, number>;
  lastHeard: Record<ActorId, number>;
  summary: SyncSummary;
  pendingTransfers: number;
  /** Set while a durable write is failing on this device. */
  storageError: string | null;
}

/** Device to stage. */
export type DeviceReport =
  /** The page loaded and is listening. Sent again after any reload. */
  | { kind: 'ready' }
  | { kind: 'booted'; actor: ActorId; team: TeamId; restored: boolean }
  | { kind: 'view'; view: CompactView }
  | { kind: 'links'; links: LinkInfo[]; reachable: ActorId[]; signalUp: boolean; at: number }
  | { kind: 'ferryFrame'; ferryId: string; packetId: string; index: number; total: number; pixels: FramePixels }
  | { kind: 'ferrySent'; ferryId: string; packetId: string; frames: number; events: number }
  | { kind: 'ferryProgress'; ferryId: string; have: number; total: number }
  | { kind: 'ferryResult'; ferryId: string; packetId: string; from: ActorId; newEvents: number; duplicates: number; rejected: number }
  | { kind: 'ferryRejected'; ferryId: string; reason: string }
  | { kind: 'refusal'; decision: DecisionRecord }
  /** The device's full log, plus what it managed to tell HQ at the time and only afterwards. */
  | { kind: 'events'; requestId: string; events: AnyEvent[]; hqSeen: EventId[]; hqBackfilled: EventId[] }
  | { kind: 'failed'; message: string };

export interface BridgeMessage<T> {
  channel: typeof BRIDGE_CHANNEL;
  body: T;
}

export function wrap<T>(body: T): BridgeMessage<T> {
  return { channel: BRIDGE_CHANNEL, body };
}

export function unwrap<T>(data: unknown): T | null {
  const message = data as Partial<BridgeMessage<T>> | null;
  return message && message.channel === BRIDGE_CHANNEL && message.body ? message.body : null;
}
