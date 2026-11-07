import type { ActorId, DecisionRecord, LinkInfo, LinkState, MissionCapsule, Point, TaskId, TaskSpec, TeamId, TokenRecord } from '@afterlink/protocol';
import type { CompactTask, CompactView, FramePixels } from '../bridge';

export type StepId = 'break' | 'split' | 'contest' | 'carry' | 'restore' | 'debrief';

/** The three things a person can drop on the map. */
export type RequestKind = 'first-aid' | 'blocked-path' | 'wheelchair';

export type StagePhase = 'connecting' | 'live' | 'failed';

/** A short verdict sitting on a device. */
export interface StageMark {
  tone: 'request' | 'refused' | 'granted' | 'carry';
  text: string;
}

export interface StageDevice {
  id: ActorId;
  team: TeamId;
  name: string;
  /** The iframe address. The stage renders it; the map never needs it. */
  src: string;
  home: Point;
  /** This device's own report, null until it boots. Fog and ghosts must be drawn from this and nothing else. */
  view: CompactView | null;
  links: LinkInfo[];
  signalUp: boolean;
  /** What this team is working on, read from its own view. */
  task: CompactTask | null;
  /** Where the team should walk: its accepted or claimed task, otherwise home. */
  goal: Point;
  /** Newest first. */
  decisions: DecisionRecord[];
}

export interface StageLink {
  a: ActorId;
  b: ActorId;
  /** open: both ends report it. forming: not up yet. cut: an end reports it closed. */
  state: 'open' | 'forming' | 'cut';
  /** True while a fault plan blocks this pair. A cut you made, as opposed to one the network made. */
  blocked: boolean;
  /** Unblocked but still down: re-forming needs signalling, so it waits for HQ. */
  waitingForHq: boolean;
  aState?: LinkState;
  bState?: LinkState;
  rttMs?: number;
  sent: number;
  received: number;
  lastHeardAt?: number;
}

export interface StageHq {
  alive: boolean;
  state: 'live' | 'blind';
  /** Teams HQ can see right now, or last saw when dead. */
  teams: number;
  /** Tasks HQ knows are done. Frozen while dead. */
  done: number;
  /** "last confirmed at". Never advances while HQ is dead. */
  lastConfirmedAt: number | null;
  /** Every interval HQ was dead. */
  blind: { from: number; to: number | null }[];
  firstAt: number | null;
  /** What reached HQ, by event wall time. late: arrived only after a blind interval. */
  ticks: { id: string; at: number; late: boolean }[];
}

export interface StageCarry {
  phase: 'preparing' | 'walking' | 'scanning' | 'done' | 'failed';
  sender: ActorId;
  receiver: ActorId;
  /** Frames the receiver has decoded so far, of total. */
  have: number;
  total: number;
  newEvents: number;
  /** Suggested duration of the walk. */
  walkMs: number;
}

export interface StageStory {
  step: StepId;
  /** What the dominant button says. */
  label: string;
  /** True while the step's real effects are still landing. */
  busy: boolean;
  /** One short sentence, from what really happened. */
  line: string;
  /** Every story step has been played. */
  finished: boolean;
}

export interface StageScore {
  tasksFinished: number;
  /** Refusals that protected something, the same set the debrief counts. */
  unsafeRefused: number;
  linksCut: number;
  /** Invariant breaks any device has detected, such as a right promised twice. */
  violations: number;
}

/** Union of what every device reports. Nobody on the ground knows this: any visual using it must be labelled. */
export interface StageTruth {
  tasks: (CompactTask & { knownBy: ActorId[] })[];
  tokens: TokenRecord[];
}

export interface StageState {
  /** Changes on every restart. */
  run: number;
  phase: StagePhase;
  ready: boolean;
  error: string | null;
  capsule: MissionCapsule | null;
  /** Left to right. The two middle teams are either side of the story's split. */
  seats: StageDevice[];
  /** One per pair of devices. */
  pairs: StageLink[];
  /** Devices not cut off from each other. More than one entry means the network is split. */
  groups: ActorId[][];
  /** Where each team starts, from the signed capsule. */
  homes: Record<TeamId, Point>;
  hq: StageHq;
  story: StageStory;
  score: StageScore;
  /** The same two counts the sound mapper reads. */
  done: number;
  refused: number;
  carry: StageCarry | null;
  truth: StageTruth;
  marks: Record<ActorId, StageMark | undefined>;
  /** The team whose decisions are being explained, if any. */
  why: ActorId | null;
}

/** One-shot moments. Draw from these, then settle on `snapshot()`. Each one follows a real report. */
export type StageEvent =
  /** Events really reached `to` from `from`. */
  | { kind: 'sync'; from: ActorId; to: ActorId }
  /** A report really reached HQ. */
  | { kind: 'report'; actor: ActorId }
  | { kind: 'link'; a: ActorId; b: ActorId; state: StageLink['state'] }
  | { kind: 'hq'; alive: boolean }
  | { kind: 'request'; actor: ActorId; taskId: TaskId; point: Point; title: string }
  | { kind: 'claimed'; actor: ActorId; taskId: TaskId }
  | { kind: 'done'; actor: ActorId; taskId: TaskId }
  | { kind: 'refused'; actor: ActorId; taskId: TaskId; reason: string; protective: boolean }
  | { kind: 'allocated'; actor: ActorId; taskId: TaskId; resource: string }
  /** One real QR frame, exactly as rendered by the sender. Paint it on the courier. */
  | { kind: 'frame'; index: number; total: number; pixels: FramePixels }
  | { kind: 'carried'; to: ActorId; newEvents: number };

/** A superset of WorldController in src/world/contract.ts, which is what the map drives. */
export interface StageController {
  /** useSyncExternalStore(controller.subscribe, controller.snapshot). The snapshot is immutable. */
  subscribe(fn: () => void): () => void;
  snapshot(): StageState;
  on(fn: (e: StageEvent) => void): () => void;
  /** Real traffic only, as pulses. */
  onPulse(fn: (pulse: { kind: 'peer'; from: ActorId; to: ActorId } | { kind: 'hq'; from: ActorId }) => void): () => void;
  /** Binds a device iframe. Whoever renders the four iframes calls this. */
  attach(id: ActorId, frame: HTMLIFrameElement | null): void;

  /** Plays the next story step. Space and the big button call this. */
  advance(): void;
  /** Throws the mission away: new keys, new devices, new HQ. */
  restart(): void;

  /** worker.terminate() on HQ. */
  killHq(): void;
  /** A fresh HQ worker. Links that are unblocked re-form through it. */
  restoreHq(): void;
  /** Real setFaults on both ends: that RTCPeerConnection closes. */
  cut(a: ActorId, b: ActorId): void;
  /** Lifts the fault on both ends. The link only returns once signalling can reach both. */
  heal(a: ActorId, b: ActorId): void;
  /** Lifts every fault and restores HQ. */
  healAll(): void;
  /** A person tells this team about something on site. */
  addTask(by: ActorId, spec: TaskSpec, ref: string): void;
  /** Builds the request and raises it with the team nearest the point. Null while not live. */
  dropRequest(point: Point, kind: RequestKind): TaskId | null;
  /** Starts a real carry: signed packet, QR frames, decode at `to`. Ignored while one is running. */
  carry(from: ActorId, to: ActorId): void;
  /** The courier reached the receiver. Scanning starts. */
  carried(): void;
  /** Receives every QR frame the courier is showing. */
  onFrames(sink: ((pixels: FramePixels) => void) | null): void;

  /** Opens the on-demand explanation of a team's decisions. */
  openWhy(id: ActorId): void;
}
