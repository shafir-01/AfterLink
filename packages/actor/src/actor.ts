import { createEvent, EventLog, sha256 } from '@afterlink/protocol';
import type {
  ActorId,
  AnyEvent,
  DecisionRecord,
  EventBodies,
  EventEnvelope,
  EventId,
  EventType,
  FaultPlan,
  FerryPacket,
  Json,
  Link,
  LinkInfo,
  LinkState,
  MissionState,
  NextStep,
  Outcome,
  ProvisionBundle,
  RefusalCode,
  ResourceId,
  SignalClient,
  SyncSummary,
  TaskId,
  TaskRecord,
  TaskSource,
  TaskSpec,
  TokenId,
  TransferId,
} from '@afterlink/protocol';
import { attachSync, Mesh, systemClock, type Clock, type LinkConnector } from '@afterlink/mesh';
import { buildPacket, verifyPacket } from '@afterlink/ferry';
import { canCommit, canOffer, canPerform, findTokens, pendingTransfers } from '@afterlink/authority';
import { reduce, validateTaskSpec } from '@afterlink/mission';
import { plan, type PlannerAction } from '@afterlink/planner';
import { SigningGate, type ChainPoint } from './gate.ts';
import { isFinished, isMine, TRANSFER_REQUEST_KEY, transferIdFor, transferRequests } from './rules.ts';
import { createMemoryStorage, type ActorMeta, type ActorStorage, type HighWaterMark } from './storage.ts';
import type { ActorNode, ActorOptions, ActorView, FerryResult, ObserveOptions } from './types.ts';
import { buildView } from './view.ts';

const DEFAULT_TICK_MS = 500;
const DEFAULT_NOTIFY_MS = 40;
const DEFAULT_AUTOPILOT_MS = 1500;
/** An event delivered to the observer later than this was not seen as it happened. */
const HQ_LIVE_WINDOW_MS = 5000;
const REPORT_BATCH = 100;
const MAX_DECIDE_PASSES = 4;
/** Shown to the person scanning. Age alone never rejects a packet: events prove themselves. */
const FERRY_STALE_MS = 10 * 60_000;

const NEXT_STEPS: Partial<Record<RefusalCode, NextStep[]>> = {
  NO_RIGHT: ['REQUEST_TRANSFER', 'WAIT_FOR_CONTACT', 'CARRY_UPDATE'],
  TOKEN_IN_TRANSIT: ['WAIT_FOR_CONTACT'],
  NO_CAPABILITY: ['SUBSTITUTE'],
};

class Actor implements ActorNode {
  readonly id: ActorId;
  readonly team: string;
  readonly name: string;

  private readonly bundle: ProvisionBundle;
  private readonly keys: { publicKey: ActorId; secretKey: string };
  private readonly mission: string;
  private readonly peers: ActorId[];
  private readonly custodian: boolean;
  private readonly connector: LinkConnector;
  private readonly storage: ActorStorage;
  private readonly clock: Clock;
  private readonly now: () => number;
  /** Intervals use this, so a wall clock stepping backwards cannot silence cover. */
  private readonly mono: () => number;
  private readonly tickMs: number;
  private readonly notifyMs: number;
  private readonly autopilot: boolean;
  private readonly autopilotDelayMs: number;

  private readonly log: EventLog;
  private mesh: Mesh | null = null;
  private sync: { nudge(): void; stop(): void } | null = null;
  private signal: SignalClient | null;
  private faults: FaultPlan = { blocked: [] };

  private gate = new SigningGate({ seq: 0, id: null }, null);
  private running = false;
  private stepping = false;
  private tickHandle: unknown = null;
  private stepHandle: unknown = null;
  private notifyHandle: unknown = null;

  /** Own events signed but not yet durable. They count for local decisions and go nowhere else. */
  private unflushed: AnyEvent[] = [];
  private writeQueue: AnyEvent[] = [];
  private writing: Promise<void> | null = null;
  private batching = 0;
  private storageError: string | null = null;
  private head: { seq: number; id: EventId | null; lamport: number } = { seq: 0, id: null, lamport: 0 };
  private markSeq = 0;
  private joined = false;

  private stateKey = -1;
  private stateCache: MissionState | null = null;
  private viewCache: ActorView | null = null;
  private readonly subscribers = new Set<(v: ActorView) => void>();

  private readonly heardAt = new Map<ActorId, number>();
  private readonly linkFacts = new Map<ActorId, LinkState>();
  private readonly linkHealth = new Map<ActorId, number>();
  /** Peers whose view of this actor's chain has been checked since their link came up. */
  private readonly checked = new Set<ActorId>();
  private readonly accepted = new Set<TaskId>();
  private readonly ferrySeen = new Set<string>();
  private readonly pilotSince = new Map<string, number>();

  private readonly hqLive = new Set<EventId>();
  private readonly hqLate = new Set<EventId>();
  private reportedThisSession = new Set<EventId>();
  private readonly blindSpans: { from: number; to: number }[] = [];
  private blindFrom: number | null = null;
  private metaDirty = false;

  constructor(o: ActorOptions) {
    this.bundle = o.bundle;
    this.keys = o.bundle.actor;
    this.id = o.bundle.actor.publicKey;
    this.team = o.bundle.team;
    this.name = o.bundle.name;
    this.mission = o.bundle.genesis.mission;
    this.peers = o.bundle.roster.map((r) => r.actor).filter((a) => a !== this.id);
    this.custodian = o.bundle.credential.custodian;
    this.connector = o.connector;
    this.storage = o.storage ?? createMemoryStorage();
    this.clock = o.connector.clock ?? systemClock;
    this.now = o.now ?? (() => this.clock.now());
    this.mono = o.connector.clock ? () => this.clock.now() : () => performance.now();
    this.tickMs = o.tickMs ?? DEFAULT_TICK_MS;
    this.notifyMs = o.notifyMs ?? DEFAULT_NOTIFY_MS;
    this.autopilot = o.autopilot ?? false;
    this.autopilotDelayMs = o.autopilotDelayMs ?? DEFAULT_AUTOPILOT_MS;
    this.signal = o.signal ?? null;
    this.log = new EventLog(this.mission);
    this.log.ingest(o.bundle.genesis);
  }

  // ---------- Lifecycle ----------

  async start(): Promise<void> {
    if (this.running) return;
    if (!(await this.storage.acquire())) {
      await this.readOnly();
      return;
    }
    const mark = await this.restore();
    this.gate = new SigningGate(this.head, mark);

    const mesh = new Mesh({
      self: this.id,
      peers: this.peers,
      signal: this.signal ?? undefined,
      connector: this.connector,
      room: this.bundle.room,
      secretKey: this.keys.secretKey,
    });
    this.mesh = mesh;
    mesh.onLinkChange((info) => this.onLink(info));
    mesh.onSignalState((up) => this.onSignal(up));
    mesh.onIngress((ref, spec) => this.onIngress(ref, spec));
    // Registered ahead of sync, so a summary can close the gate before anything acts on it.
    mesh.onMessage((peer, msg) => {
      if (msg.t === 'summary' && msg.summary.mission === this.mission) this.onPeerSummary(peer, msg.summary);
    });
    if (this.faults.blocked.length) mesh.setFaults(this.faults);
    this.sync = attachSync(mesh, this.log, (events, from) => this.onRemote(events, from));
    this.running = true;
    this.onGate();
    mesh.start();
    this.scheduleTick();
    this.kick();
  }

  private scheduleTick(): void {
    this.tickHandle = this.clock.setTimeout(() => {
      this.scheduleTick();
      this.tick();
    }, this.tickMs);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const handle of [this.tickHandle, this.stepHandle, this.notifyHandle]) {
      if (handle !== null) this.clock.clearTimeout(handle);
    }
    this.tickHandle = this.stepHandle = this.notifyHandle = null;
    this.sync?.stop();
    this.mesh?.stop();
    this.sync = null;
    this.mesh = null;
    this.viewCache = null;
    this.saveMeta();
    if (this.writing) void this.writing.finally(() => this.storage.close?.());
    else this.storage.close?.();
  }

  async settled(): Promise<void> {
    while (this.writing) await this.writing;
    if (this.storageError) throw new Error(this.storageError);
  }

  /** Another runtime owns this identity here: show what is stored, and touch nothing. */
  private async readOnly(): Promise<void> {
    const stored = await this.storage.load();
    if (stored?.identity.publicKey === this.id && stored.identity.mission === this.mission) {
      this.log.ingestMany(stored.events);
    }
    this.gate.twin();
    this.changed();
  }

  private async restore(): Promise<ChainPoint | null> {
    const stored = await this.storage.load();
    const held = await this.storage.readMark();
    const mark: HighWaterMark | null = held?.actor === this.id && held.mission === this.mission ? held : null;
    this.markSeq = mark?.seq ?? 0;
    if (stored?.identity.publicKey === this.id && stored.identity.mission === this.mission) {
      this.log.ingestMany(stored.events);
      for (const e of stored.events) if (e.actor === this.id) this.learnOwn(e);
      this.faults = stored.meta.faults ?? this.faults;
      for (const id of stored.meta.hqLive ?? []) this.hqLive.add(id);
      for (const id of stored.meta.hqLate ?? []) this.hqLate.add(id);
      for (const id of stored.meta.ferrySeen ?? []) this.ferrySeen.add(id);
    } else {
      await this.storage.reset({ publicKey: this.id, secretKey: this.keys.secretKey, mission: this.mission });
      this.enqueue([this.bundle.genesis]);
      await this.settled();
    }
    return mark;
  }

  private learnOwn(e: AnyEvent): void {
    if (e.seq > this.head.seq) this.head = { seq: e.seq, id: e.id, lamport: e.lamport };
    switch (e.type) {
      case 'actor.joined':
        this.joined = true;
        break;
      case 'task.accepted':
        this.accepted.add(e.body.taskId);
        break;
      case 'task.released':
        this.accepted.delete(e.body.taskId);
        break;
      case 'ferry.received':
        this.ferrySeen.add(e.body.packetId);
        break;
      case 'link.changed':
        this.linkFacts.set(e.body.peer, e.body.state);
        break;
    }
  }

  // ---------- The signing gate ----------

  private get mayAct(): boolean {
    return this.running && this.gate.phase === 'ready';
  }

  private holds = (id: EventId): boolean => this.log.has(id) || this.unflushed.some((e) => e.id === id);

  private onPeerSummary(peer: ActorId, summary: SyncSummary): void {
    const fresh = !this.checked.has(peer);
    this.checked.add(peer);
    this.onEvidence(summary);
    if (!fresh) return;
    const info = this.mesh?.links().find((l) => l.peer === peer);
    if (info) this.onLink(info);
    this.kick();
  }

  /**
   * A peer may know this chain better than this device does, so nothing is signed on a link
   * until that peer's summary has been read. Alone, there is nothing to wait for.
   */
  private get peersChecked(): boolean {
    return this.reachable().every((p) => this.checked.has(p));
  }

  private onEvidence(summary: SyncSummary): void {
    const before = this.gate.phase;
    this.gate.evidence(this.head, summary.heads[this.id], this.holds);
    if (this.gate.phase !== before) this.onGate();
  }

  /** When the gate opens, the device catches up on what it could not sign while it was shut. */
  private onGate(): void {
    this.changed();
    if (this.gate.phase !== 'ready') return;
    if (!this.joined) {
      const { team, name, credential } = this.bundle;
      this.emit('actor.joined', { team, name, credential });
    }
    for (const info of this.mesh?.links() ?? []) if (info.state === 'open') this.onLink(info);
    this.kick();
  }

  // ---------- Durable emission ----------

  /**
   * The only place this device signs. The event joins the shared log only after it and the
   * high-water mark are durable, so nothing a peer, packet or screen ever sees can be lost here.
   */
  private emit<T extends EventType>(type: T, body: EventBodies[T]): EventEnvelope<T> {
    if (this.gate.phase !== 'ready') throw new Error(`signing is shut: ${this.gate.phase}`);
    const e = createEvent({
      keys: this.keys,
      mission: this.mission,
      seq: this.head.seq + 1,
      prev: this.head.id,
      parents: this.log.heads().filter((id) => this.log.get(id)?.actor !== this.id),
      lamport: Math.max(this.log.lamport(), this.head.lamport) + 1,
      wall: this.now(),
      type,
      body,
    });
    this.learnOwn(e as AnyEvent);
    this.unflushed.push(e as AnyEvent);
    this.enqueue([e as AnyEvent]);
    this.changed();
    return e;
  }

  /** Everything emitted inside lands as one atomic write, so a crash cannot split a commit from its claim. */
  private together<R>(fn: () => R): R {
    this.batching++;
    try {
      return fn();
    } finally {
      this.batching--;
      this.drain();
    }
  }

  private enqueue(events: AnyEvent[]): void {
    this.writeQueue.push(...events);
    this.drain();
  }

  private markFor(batch: AnyEvent[]): HighWaterMark | undefined {
    let top: AnyEvent | undefined;
    for (const e of batch) if (e.actor === this.id && e.seq > (top?.seq ?? this.markSeq)) top = e;
    return top && { actor: this.id, mission: this.mission, seq: top.seq, id: top.id };
  }

  private drain(): void {
    if (this.writing || this.batching || !this.writeQueue.length) return;
    const batch = this.writeQueue.splice(0);
    const mark = this.markFor(batch);
    const failed = (err: unknown) => {
      this.writeQueue.unshift(...batch);
      this.storageError = err instanceof Error ? err.message : String(err);
      this.changed();
    };
    let result: void | Promise<void>;
    try {
      result = this.storage.append(batch, mark);
    } catch (err) {
      failed(err);
      return;
    }
    if (!result) {
      this.landed(batch, mark);
      return;
    }
    this.writing = result
      .then(
        () => this.landed(batch, mark),
        (err) => failed(err),
      )
      .finally(() => {
        this.writing = null;
        if (!this.storageError) this.drain();
      });
  }

  private landed(batch: AnyEvent[], mark: HighWaterMark | undefined): void {
    if (mark) this.markSeq = mark.seq;
    if (this.storageError) {
      this.storageError = null;
      this.changed();
    }
    const ids = new Set(batch.map((e) => e.id));
    const mine = this.unflushed.filter((e) => ids.has(e.id));
    if (!mine.length) return;
    this.unflushed = this.unflushed.filter((e) => !ids.has(e.id));
    this.log.ingestMany(mine);
    this.sync?.nudge();
    this.changed();
  }

  // ---------- Inbound ----------

  private onRemote(events: AnyEvent[], from: ActorId): void {
    if (!events.length) return;
    this.noteHeard(from, this.now());
    this.absorb(events);
  }

  /** Learning about an actor is not contact with it, so heard times follow the events themselves. */
  private absorb(events: AnyEvent[]): void {
    let own = false;
    for (const e of events) {
      if (e.actor !== this.id) {
        this.noteHeard(e.actor, e.wall);
        continue;
      }
      own = true;
      if (this.unflushed.some((u) => u.seq === e.seq && u.id !== e.id)) this.gate.halt();
      this.learnOwn(e);
    }
    this.enqueue(events);
    if (own) this.checkOwnChain();
    this.changed();
    this.kick();
  }

  private checkOwnChain(): void {
    const before = this.gate.phase;
    if (this.log.forks().some((f) => f.actor === this.id)) this.gate.halt();
    else this.gate.caughtUp(this.head, this.holds);
    if (this.gate.phase !== before) this.onGate();
  }

  private noteHeard(actor: ActorId, wall: number): void {
    if (!this.peers.includes(actor)) return;
    const at = this.mono() - Math.max(0, this.now() - wall);
    if (at > (this.heardAt.get(actor) ?? -Infinity)) this.heardAt.set(actor, at);
  }

  private lastHeard(): Record<ActorId, number> {
    const now = this.now();
    const mono = this.mono();
    const out: Record<ActorId, number> = {};
    for (const [actor, at] of this.heardAt) out[actor] = now - (mono - at);
    return out;
  }

  private onLink(info: LinkInfo): void {
    this.changed();
    if (info.state !== 'open') this.checked.delete(info.peer);
    if (!this.mayAct || info.state === 'connecting') return;
    if (info.state === 'open' && !this.checked.has(info.peer)) return;
    if ((info.state === 'open') === (this.linkFacts.get(info.peer) === 'open')) return;
    this.emit('link.changed', { peer: info.peer, state: info.state, transport: info.transport });
    this.kick();
  }

  private onSignal(up: boolean): void {
    if (!this.running) return;
    const at = this.now();
    if (up) {
      if (this.blindFrom !== null) this.blindSpans.push({ from: this.blindFrom, to: at });
      this.blindFrom = null;
      // A restarted observer starts blank and has no way to ask, so each session gets the whole log.
      this.reportedThisSession = new Set();
      this.kick();
    } else if (this.blindFrom === null) {
      this.blindFrom = at;
    }
    this.changed();
  }

  private onIngress(ref: string, spec: TaskSpec): void {
    if (!this.mayAct || validateTaskSpec(spec).length) return;
    const tasks = this.state().tasks;
    if (tasks[spec.id] || Object.values(tasks).some((t) => t.source.ref === ref)) return;
    this.emit('task.created', { spec, source: { kind: 'external', ref } });
    this.kick();
  }

  // ---------- Decision loop ----------

  private kick(): void {
    if (!this.running || this.stepHandle !== null) return;
    this.stepHandle = this.clock.setTimeout(() => {
      this.stepHandle = null;
      this.step();
    }, 0);
  }

  private tick(): void {
    if (!this.running) return;
    if (this.storageError) this.drain();
    this.noteLinkHealth();
    this.step();
  }

  private noteLinkHealth(): void {
    for (const l of this.mesh?.links() ?? []) {
      const at = l.lastHeardAt ?? 0;
      if (this.linkHealth.get(l.peer) === at) continue;
      this.linkHealth.set(l.peer, at);
      if (at) this.noteHeard(l.peer, this.now());
      this.changed();
    }
  }

  private step(): void {
    if (!this.running || this.stepping) return;
    this.stepping = true;
    try {
      if (this.mayAct && this.peersChecked) {
        this.together(() => {
          for (let pass = 0; pass < MAX_DECIDE_PASSES; pass++) {
            const before = this.head.seq;
            this.decide();
            if (this.head.seq === before) break;
          }
        });
      }
      this.report();
      this.flushMeta();
    } finally {
      this.stepping = false;
    }
  }

  private decide(): void {
    const now = this.now();
    this.takeRequestedRights();
    const state = this.state();
    const actions = plan({
      self: this.id,
      state,
      reachable: this.reachable(),
      now,
      horizon: this.horizon(),
      lastHeard: this.lastHeard(),
    });
    for (const a of actions) this.perform(a, state);
    this.answerRequests();
    if (this.autopilot) this.drive(now);
  }

  private perform(a: PlannerAction, state: MissionState): void {
    const task = state.tasks[a.taskId];
    switch (a.type) {
      case 'claim':
        if (this.spend(a.tokens, a.taskId)) this.emit('task.claimed', { taskId: a.taskId, decision: a.decision });
        break;
      case 'cover':
        if (this.spend(a.tokens, a.taskId)) this.emit('task.covered', { taskId: a.taskId, decision: a.decision });
        break;
      case 'refuse':
        if (!this.repeats(task, a.decision)) this.emit('task.refused', { taskId: a.taskId, decision: a.decision });
        break;
      case 'defer':
        if (!this.repeats(task, a.decision)) this.emit('task.deferred', { taskId: a.taskId, decision: a.decision });
        break;
      case 'release':
        this.emit('task.released', { taskId: a.taskId, reason: a.reason });
        break;
      case 'request-transfer':
        this.requestRights(a.taskId, a.resource, a.count, a.from, state);
        break;
    }
  }

  /** Planner output is checked against the newest state in the same synchronous step that signs. */
  private spend(tokens: TokenId[], taskId: TaskId): boolean {
    if (!tokens.length) return true;
    if (!canCommit(this.state(), this.id, tokens).ok) return false;
    this.emit('right.committed', { tokens, taskId });
    return true;
  }

  /** Decisions are facts, so the same verdict is stated once, not once per tick. */
  private repeats(task: TaskRecord | undefined, d: DecisionRecord): boolean {
    const last = task?.decisions.filter((x) => x.actor === this.id).at(-1);
    const said = (x: DecisionRecord) => `${x.outcome}|${x.refusal ?? ''}|${(x.next ?? []).join()}`;
    return !!last && said(last) === said(d);
  }

  private requestRights(taskId: TaskId, resource: ResourceId, count: number, from: ActorId, state: MissionState): void {
    const asked = transferRequests(state).some(
      (r) => r.by === this.id && r.taskId === taskId && r.resource === resource && r.from === from,
    );
    if (!asked) this.record(TRANSFER_REQUEST_KEY, { taskId, resource, count, from }, taskId, 0);
  }

  /**
   * A holder hands over a right it is not using, once per request, and only to a requester it can
   * reach: an offer into a partition would lock the right in transit for no one.
   */
  private answerRequests(): void {
    const state = this.state();
    const reachable = this.reachable();
    for (const r of transferRequests(state)) {
      if (r.from !== this.id || !reachable.includes(r.by)) continue;
      const task = state.tasks[r.taskId];
      if (!task || isFinished(task) || task.owner) continue;
      const need = task.spec.needs.find((n) => n.resource === r.resource);
      if (!need || r.count > need.count || !canPerform(state, r.by, task).ok) continue;
      const transfer = transferIdFor(r);
      if (this.offered(transfer)) continue;
      const free = findTokens(state, this.id, r.resource, r.count);
      if (free.length === r.count) this.emit('right.offered', { transfer, tokens: free, to: r.by });
    }
  }

  private offered(transfer: TransferId): boolean {
    const mine = [...this.log.byActor(this.id), ...this.unflushed];
    return mine.some((e) => e.type === 'right.offered' && e.body.transfer === transfer);
  }

  /** An offer answering this actor's own request needs no second confirmation. */
  private takeRequestedRights(): void {
    const state = this.state();
    const asked = new Set(transferRequests(state).filter((r) => r.by === this.id).map(transferIdFor));
    for (const t of pendingTransfers(state, this.id)) {
      if (asked.has(t.transfer)) this.answerTransfer(t.transfer, true);
    }
  }

  /** The simulated volunteer: one tap per delay, always through the public commands. */
  private drive(now: number): void {
    const state = this.state();
    const humanOnly = state.capsule?.fallback.humanApprovalKinds ?? [];
    for (const t of pendingTransfers(state, this.id)) this.answerTransfer(t.transfer, true);
    for (const task of Object.values(state.tasks)) {
      if (isFinished(task) || !isMine(task, this.id) || humanOnly.includes(task.spec.kind)) continue;
      const id = task.spec.id;
      const stage = this.accepted.has(id) ? 'complete' : 'accept';
      const key = `${id}:${stage}`;
      const since = this.pilotSince.get(key);
      if (since === undefined) {
        this.pilotSince.set(key, now);
        continue;
      }
      if (now - since < this.autopilotDelayMs) continue;
      this.pilotSince.delete(key);
      if (stage === 'accept') this.acceptTask(id, 'auto');
      else this.completeTask(id, `${task.spec.title} done`, 'auto');
    }
  }

  // ---------- Reporting to the observer ----------

  private report(): void {
    const mesh = this.mesh;
    if (!mesh?.signalUp || this.reportedThisSession.size >= this.log.size) return;
    const fresh = this.log.all().filter((e) => !this.reportedThisSession.has(e.id));
    const at = this.now();
    for (let i = 0; i < fresh.length; i += REPORT_BATCH) {
      const batch = fresh.slice(i, i + REPORT_BATCH);
      if (!mesh.report(batch)) return;
      for (const e of batch) {
        this.reportedThisSession.add(e.id);
        if (this.hqLive.has(e.id) || this.hqLate.has(e.id)) continue;
        (this.seenAsItHappened(e, at) ? this.hqLive : this.hqLate).add(e.id);
        this.metaDirty = true;
      }
    }
    this.changed();
  }

  private seenAsItHappened(e: AnyEvent, at: number): boolean {
    if (at - e.wall > HQ_LIVE_WINDOW_MS) return false;
    return !this.blindSpans.some((s) => e.wall >= s.from && e.wall <= s.to);
  }

  private saveMeta(): void {
    this.metaDirty = true;
    this.flushMeta();
  }

  private flushMeta(): void {
    if (!this.metaDirty) return;
    this.metaDirty = false;
    const meta: ActorMeta = {
      faults: this.faults,
      hqLive: [...this.hqLive],
      hqLate: [...this.hqLate],
      ferrySeen: [...this.ferrySeen],
    };
    try {
      void Promise.resolve(this.storage.saveMeta(meta)).catch(() => undefined);
    } catch {
      this.metaDirty = true;
    }
  }

  // ---------- Reading ----------

  /** What this device has signed counts for its own decisions, durable or not. */
  private state(): MissionState {
    const key = this.log.size + this.unflushed.length;
    if (this.stateCache && this.stateKey === key) return this.stateCache;
    const events = this.unflushed.length ? [...this.log.all(), ...this.unflushed] : this.log.all();
    this.stateCache = reduce(events, this.bundle.roster);
    this.stateKey = key;
    return this.stateCache;
  }

  private reachable(): ActorId[] {
    return this.mesh?.reachable() ?? [];
  }

  private horizon(): Record<ActorId, number> {
    const out: Record<ActorId, number> = {};
    for (const [actor, head] of Object.entries(this.log.summary().heads)) out[actor] = head.seq;
    if (this.head.seq) out[this.id] = this.head.seq;
    return out;
  }

  view(): ActorView {
    if (this.viewCache) return this.viewCache;
    const events = this.log.all();
    this.viewCache = buildView({
      self: { id: this.id, team: this.team, name: this.name, custodian: this.custodian },
      phase: this.gate.phase,
      phaseReason: this.gate.reason,
      state: this.unflushed.length ? reduce(events, this.bundle.roster) : this.state(),
      events,
      links: this.mesh?.links() ?? [],
      reachable: this.reachable(),
      horizon: this.horizon(),
      lastHeard: this.lastHeard(),
      summary: this.log.summary(),
      signalUp: this.mesh?.signalUp ?? false,
      hqSeen: [...this.hqLive],
      hqBackfilled: [...this.hqLate],
      storageError: this.storageError,
    });
    return this.viewCache;
  }

  subscribe(fn: (v: ActorView) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  /** Invalidates the view and coalesces subscriber calls: never more than one per notify interval. */
  private changed(): void {
    this.viewCache = null;
    if (this.notifyHandle !== null || !this.running || !this.subscribers.size) return;
    this.notifyHandle = this.clock.setTimeout(() => {
      this.notifyHandle = null;
      const v = this.view();
      for (const fn of this.subscribers) fn(v);
    }, this.notifyMs);
  }

  events(): AnyEvent[] {
    return this.log.all();
  }

  // ---------- Commands ----------

  submitTask(spec: TaskSpec, source: TaskSource): boolean {
    const problems = validateTaskSpec(spec);
    if (problems.length) throw new TypeError(problems[0]);
    if (!this.mayAct) return false;
    const tasks = this.state().tasks;
    if (tasks[spec.id]) return false;
    if (source.ref && Object.values(tasks).some((t) => t.source.ref === source.ref)) return false;
    this.emit('task.created', { spec, source });
    this.kick();
    return true;
  }

  acceptTask(id: TaskId, via: 'tap' | 'voice' | 'auto' = 'tap'): boolean {
    if (!this.mayAct) return false;
    const task = this.state().tasks[id];
    if (!task || isFinished(task)) return false;
    if (this.accepted.has(id)) return true;
    const done = this.together(() => {
      if (!isMine(task, this.id) && (task.owner || !this.volunteer(task))) return false;
      if (!this.commitRights(id)) return false;
      this.emit('task.accepted', { taskId: id, via });
      return true;
    });
    this.kick();
    return done;
  }

  /** A person taking an unowned task is an explicit local decision, recorded like any other. */
  private volunteer(task: TaskRecord): boolean {
    const id = task.spec.id;
    const able = canPerform(this.state(), this.id, task);
    if (!able.ok) {
      this.refuse(id, able.code, able.reason);
      return false;
    }
    if (!this.commitRights(id)) return false;
    const decision = this.localDecision(id, 'ACCEPTED', {
      reason: `${this.name} took this task by hand.`,
      policy: 'human.initiative',
    });
    this.emit('task.claimed', { taskId: id, decision });
    return true;
  }

  /** Spends what a task still needs from this actor. Refuses, on the record, when it is not held here. */
  private commitRights(id: TaskId): boolean {
    const state = this.state();
    const task = state.tasks[id];
    if (!task) return false;
    const picked: TokenId[] = [];
    for (const need of task.spec.needs) {
      const spent = Object.values(state.tokens).filter(
        (t) => t.committedTo === id && t.resource === need.resource && t.holder === this.id,
      ).length;
      const missing = need.count - spent;
      if (missing <= 0) continue;
      const found = findTokens(state, this.id, need.resource, missing);
      if (found.length < missing) {
        this.refuse(id, 'NO_RIGHT', `${this.name} holds no free ${need.resource} for this task.`);
        return false;
      }
      picked.push(...found);
    }
    return this.spend(picked, id);
  }

  private refuse(taskId: TaskId, refusal: RefusalCode, reason: string): void {
    const decision = this.localDecision(taskId, 'REFUSED', {
      refusal,
      next: NEXT_STEPS[refusal] ?? ['WAIT_FOR_CONTACT'],
      reason,
      policy: 'authority.commit',
    });
    if (!this.repeats(this.state().tasks[taskId], decision)) this.emit('task.refused', { taskId, decision });
  }

  private localDecision(
    taskId: TaskId,
    outcome: Outcome,
    fields: Pick<DecisionRecord, 'reason' | 'policy'> & Partial<DecisionRecord>,
  ): DecisionRecord {
    return {
      id: sha256(`${this.id}:${this.head.seq + 1}:${taskId}`).slice(0, 22),
      actor: this.id,
      taskId,
      outcome,
      reachable: this.reachable(),
      horizon: this.horizon(),
      inputs: [],
      ...fields,
    };
  }

  declineTask(id: TaskId, reason: string): boolean {
    if (!this.mayAct) return false;
    const task = this.state().tasks[id];
    if (!task || isFinished(task) || !isMine(task, this.id)) return false;
    this.together(() => {
      this.emit('task.released', { taskId: id, reason });
      // A refusal with no machine code is a person saying no, so the planner will not hand it straight back.
      const decision = this.localDecision(id, 'REFUSED', { reason, policy: 'human.declined' });
      this.emit('task.refused', { taskId: id, decision });
    });
    this.kick();
    return true;
  }

  completeTask(id: TaskId, evidence: string, via: 'tap' | 'voice' | 'auto' = 'tap'): boolean {
    if (!this.mayAct) return false;
    const task = this.state().tasks[id];
    if (!task || isFinished(task) || !isMine(task, this.id)) return false;
    const done = this.together(() => {
      if (!this.accepted.has(id) && !this.acceptTask(id, via)) return false;
      this.emit('task.completed', { taskId: id, evidence, via });
      return true;
    });
    this.kick();
    return done;
  }

  offerTokens(tokens: TokenId[], to: ActorId, opts: { carry?: boolean } = {}): TransferId | null {
    if (!this.mayAct || !tokens.length || !this.peers.includes(to)) return null;
    if (!opts.carry && !this.reachable().includes(to)) return null;
    if (!canOffer(this.state(), this.id, tokens).ok) return null;
    const transfer = sha256(`${this.id}:${this.head.seq + 1}:${tokens.join(',')}`).slice(0, 22);
    this.emit('right.offered', { transfer, tokens, to });
    this.kick();
    return transfer;
  }

  answerTransfer(transfer: TransferId, accept: boolean): boolean {
    if (!this.mayAct) return false;
    if (!pendingTransfers(this.state(), this.id).some((t) => t.transfer === transfer)) return false;
    this.emit(accept ? 'right.accepted' : 'right.declined', { transfer });
    this.kick();
    return true;
  }

  requestTransfer(resource: ResourceId, taskId: TaskId, from?: ActorId): boolean {
    if (!this.mayAct) return false;
    const state = this.state();
    const task = state.tasks[taskId];
    const need = task?.spec.needs.find((n) => n.resource === resource);
    if (!task || !need || isFinished(task)) return false;
    const holder = from ?? this.likelyHolder(state, resource);
    if (!holder || holder === this.id) return false;
    this.requestRights(taskId, resource, need.count, holder, state);
    this.kick();
    return true;
  }

  private likelyHolder(state: MissionState, resource: ResourceId): ActorId | undefined {
    const holders = Object.values(state.tokens)
      .filter((t) => t.resource === resource && t.state === 'held' && t.holder && t.holder !== this.id)
      .map((t) => t.holder as ActorId);
    const reachable = this.reachable();
    return holders.find((h) => reachable.includes(h)) ?? holders[0];
  }

  observe(key: string, value: Json, opts: ObserveOptions = {}): boolean {
    if (!this.mayAct) return false;
    this.record(key, value, opts.subject ?? key, opts.validForMs ?? 0);
    this.kick();
    return true;
  }

  private record(key: string, value: Json, subject: string, validForMs: number): void {
    const observation = { key, value, subject, observedAt: this.now(), validForMs, source: this.id };
    this.emit('observation.recorded', { observation });
  }

  setFaults(plan: FaultPlan): void {
    this.faults = plan;
    this.mesh?.setFaults(plan);
    this.saveMeta();
    this.changed();
    this.kick();
  }

  setSignal(c: SignalClient | null): void {
    this.signal = c;
    this.mesh?.setSignal(c);
    this.changed();
  }

  adoptLink(link: Link): boolean {
    const adopted = this.mesh?.adopt(link) ?? false;
    if (adopted) this.sync?.nudge();
    return adopted;
  }

  // ---------- Ferry ----------

  buildFerry(remote?: SyncSummary): FerryPacket {
    return buildPacket({ keys: this.keys, log: this.log, remote, wall: this.now() });
  }

  ingestFerry(p: FerryPacket): FerryResult {
    const refused = (reason: string): FerryResult => ({
      newEvents: 0,
      duplicates: 0,
      rejected: Array.isArray(p?.events) ? p.events.length : 0,
      buffered: 0,
      stale: false,
      reason,
    });
    if (!this.running) return refused('this device is not running');
    if (!this.bundle.roster.some((r) => r.actor === p?.from)) return refused('sender is not on this mission');
    const check = verifyPacket(p, { mission: this.mission });
    if (!check.ok) return refused(check.reason);

    const firstSight = !this.ferrySeen.has(p.id);
    const result = this.log.ingestMany(p.events);
    const newEvents = result.added.length - result.forks.length;
    if (result.added.length) {
      this.noteHeard(p.from, p.createdAt);
      this.absorb(result.added);
    }
    this.onEvidence(p.summary);
    this.ferrySeen.add(p.id);
    this.metaDirty = true;
    if (firstSight && newEvents > 0 && this.mayAct) {
      this.emit('ferry.received', { packetId: p.id, from: p.from, events: p.events.length, newEvents });
    }
    this.sync?.nudge();
    this.kick();
    return {
      newEvents,
      duplicates: result.duplicates,
      rejected: result.invalid.length + result.forks.length,
      buffered: result.gaps,
      stale: this.now() - p.createdAt > FERRY_STALE_MS,
    };
  }
}

export function createActor(o: ActorOptions): ActorNode {
  return new Actor(o);
}
