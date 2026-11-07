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
import { attachSync, every, Mesh, systemClock, type Clock, type LinkConnector } from '@afterlink/mesh';
import { buildPacket, verifyPacket } from '@afterlink/ferry';
import { canCommit, findTokens } from '@afterlink/authority';
import { reduce } from '@afterlink/mission';
import { plan, type PlannerAction } from '@afterlink/planner';
import {
  activeRules,
  externalTaskId,
  isFinished,
  isMine,
  isTaskSpec,
  reservedFor,
  spawnerFor,
  TRANSFER_REQUEST_KEY,
  transferIdFor,
  transferRequests,
  transfersAddressedTo,
} from './rules.ts';
import { createMemoryStorage, type ActorMeta, type ActorStorage } from './storage.ts';
import type { ActorNode, ActorOptions, ActorView, FerryResult, ObserveOptions } from './types.ts';
import { buildView } from './view.ts';

const DEFAULT_TICK_MS = 500;
const DEFAULT_NOTIFY_MS = 40;
const DEFAULT_AUTOPILOT_MS = 1500;
/** An event delivered to the observer later than this was not seen as it happened. */
const HQ_LIVE_WINDOW_MS = 5000;
const REPORT_BATCH = 100;
const MAX_DECIDE_PASSES = 4;

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
  private readonly tickMs: number;
  private readonly notifyMs: number;
  private readonly autopilot: boolean;
  private readonly autopilotDelayMs: number;

  private readonly log: EventLog;
  private mesh: Mesh | null = null;
  private sync: { nudge(): void; stop(): void } | null = null;
  private signal: SignalClient | null;
  private faults: FaultPlan = { blocked: [] };

  private running = false;
  private stepping = false;
  private stopTick: (() => void) | null = null;
  private stepHandle: unknown = null;
  private notifyHandle: unknown = null;

  /** Own events signed but not yet durable. They count for local state and never leave the device. */
  private unflushed: AnyEvent[] = [];
  private writeQueue: AnyEvent[] = [];
  private writing: Promise<void> | null = null;
  private storageError: string | null = null;
  private head: { seq: number; id: EventId | null; lamport: number } = { seq: 0, id: null, lamport: 0 };

  private stateKey = -1;
  private stateCache: MissionState | null = null;
  private viewCache: ActorView | null = null;
  private readonly subscribers = new Set<(v: ActorView) => void>();

  private readonly heard: Record<ActorId, number> = {};
  private readonly linkFacts = new Map<ActorId, LinkState>();
  private readonly linkHealth = new Map<ActorId, number>();
  private readonly accepted = new Set<TaskId>();
  private readonly declined = new Set<TaskId>();
  private readonly ferried = new Set<string>();
  private readonly pilotSince = new Map<string, number>();

  private readonly hqLive = new Set<EventId>();
  private readonly hqLate = new Set<EventId>();
  private reportedThisSession = new Set<EventId>();
  private blindSpans: { from: number; to: number }[] = [];
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
    await this.restore();
    const startedAt = this.now();
    for (const p of this.peers) this.heard[p] ??= startedAt;

    const mesh = new Mesh({
      self: this.id,
      peers: this.peers,
      signal: this.signal ?? undefined,
      connector: this.connector,
      room: this.bundle.room,
    });
    this.mesh = mesh;
    mesh.onLinkChange((info) => this.onLink(info));
    mesh.onSignalState((up) => this.onSignal(up));
    mesh.onIngress((ref, spec) => this.onIngress(ref, spec));
    if (this.faults.blocked.length) mesh.setFaults(this.faults);
    this.sync = attachSync(mesh, this.log, (events, from) => this.onRemote(events, from));
    this.running = true;
    if (this.head.seq === 0) {
      const { team, name, credential } = this.bundle;
      this.emit('actor.joined', { team, name, credential });
    }
    mesh.start();

    if (!mesh.signalUp) this.blindFrom = startedAt;
    this.stopTick = every(this.clock, this.tickMs, () => this.tick());
    this.kick();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.stopTick?.();
    this.stopTick = null;
    if (this.stepHandle !== null) this.clock.clearTimeout(this.stepHandle);
    if (this.notifyHandle !== null) this.clock.clearTimeout(this.notifyHandle);
    this.stepHandle = this.notifyHandle = null;
    this.sync?.stop();
    this.mesh?.stop();
    this.sync = null;
    this.mesh = null;
    this.viewCache = null;
    this.saveMeta();
    void this.settled()
      .catch(() => undefined)
      .finally(() => this.storage.close?.());
  }

  async settled(): Promise<void> {
    while (this.writing) await this.writing;
    if (this.storageError) throw new Error(this.storageError);
  }

  private async restore(): Promise<void> {
    const stored = await this.storage.load();
    const mine = stored?.identity.publicKey === this.id && stored.identity.mission === this.mission;
    if (!stored || !mine) {
      await this.storage.reset({ publicKey: this.id, secretKey: this.keys.secretKey, mission: this.mission });
      this.enqueue([this.bundle.genesis]);
      await this.settled();
      return;
    }
    this.log.ingestMany(stored.events);
    for (const e of stored.events) {
      if (e.actor === this.id) this.learnOwn(e);
      this.heard[e.actor] = Math.max(this.heard[e.actor] ?? 0, e.wall);
    }
    this.faults = stored.meta.faults ?? this.faults;
    for (const id of stored.meta.hqLive ?? []) this.hqLive.add(id);
    for (const id of stored.meta.hqLate ?? []) this.hqLate.add(id);
  }

  private learnOwn(e: AnyEvent): void {
    if (e.seq > this.head.seq) this.head = { seq: e.seq, id: e.id, lamport: e.lamport };
    switch (e.type) {
      case 'task.claimed':
        this.declined.delete(e.body.taskId);
        break;
      case 'task.accepted':
        this.accepted.add(e.body.taskId);
        break;
      case 'task.released':
        this.accepted.delete(e.body.taskId);
        this.declined.add(e.body.taskId);
        break;
      case 'ferry.received':
        this.ferried.add(e.body.packetId);
        break;
      case 'link.changed':
        this.linkFacts.set(e.body.peer, e.body.state);
        break;
    }
  }

  // ---------- Durable emission ----------

  /** Signs now, reveals later: the event joins the shared log only after it is durable. */
  private emit<T extends EventType>(type: T, body: EventBodies[T]): EventEnvelope<T> {
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

  private enqueue(events: AnyEvent[]): void {
    this.writeQueue.push(...events);
    this.drain();
  }

  private drain(): void {
    if (this.writing || !this.writeQueue.length) return;
    const batch = this.writeQueue.splice(0);
    const failed = (err: unknown) => {
      this.writeQueue.unshift(...batch);
      this.storageError = err instanceof Error ? err.message : String(err);
      this.changed();
    };
    let result: void | Promise<void>;
    try {
      result = this.storage.append(batch);
    } catch (err) {
      failed(err);
      return;
    }
    if (!result) {
      this.landed(batch);
      return;
    }
    this.writing = result
      .then(
        () => this.landed(batch),
        (err) => failed(err),
      )
      .finally(() => {
        this.writing = null;
        if (!this.storageError) this.drain();
      });
  }

  private landed(batch: AnyEvent[]): void {
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
    this.heard[from] = this.now();
    this.absorb(events);
  }

  /** Learning about an actor is not contact with it: heard times follow the events themselves. */
  private absorb(events: AnyEvent[]): void {
    for (const e of events) {
      if (e.actor === this.id) this.learnOwn(e);
      else this.heard[e.actor] = Math.max(this.heard[e.actor] ?? 0, e.wall);
    }
    this.enqueue(events);
    this.changed();
    this.kick();
  }

  private onLink(info: LinkInfo): void {
    this.changed();
    if (!this.running || info.state === 'connecting') return;
    if (this.linkFacts.get(info.peer) === info.state) return;
    this.emit('link.changed', { peer: info.peer, state: info.state, transport: info.transport });
    this.kick();
  }

  private onSignal(up: boolean): void {
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
    if (!this.running || !isTaskSpec(spec)) return;
    const id = externalTaskId(ref);
    const tasks = this.state().tasks;
    if (tasks[id] || Object.values(tasks).some((t) => t.source.ref === ref)) return;
    this.emit('task.created', { spec: { ...spec, id }, source: { kind: 'external', ref } });
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
      this.heard[l.peer] = Math.max(this.heard[l.peer] ?? 0, at);
      this.changed();
    }
  }

  private step(): void {
    if (!this.running || this.stepping) return;
    this.stepping = true;
    try {
      for (let pass = 0; pass < MAX_DECIDE_PASSES; pass++) {
        const before = this.head.seq;
        this.decide();
        if (this.head.seq === before) break;
      }
      this.report();
      this.flushMeta();
    } finally {
      this.stepping = false;
    }
  }

  private decide(): void {
    const now = this.now();
    this.applyContingencies(now);
    const state = this.state();
    const actions = plan({
      self: this.id,
      state,
      reachable: this.reachable(),
      now,
      horizon: this.horizon(),
      lastHeard: { ...this.heard },
    });
    for (const a of actions) this.perform(a, state);
    this.answerRequests();
    this.takeRequestedRights();
    if (this.autopilot) this.drive(now);
  }

  private perform(a: PlannerAction, state: MissionState): void {
    const task = 'taskId' in a ? state.tasks[a.taskId] : undefined;
    switch (a.type) {
      case 'claim':
        if (!this.declined.has(a.taskId)) this.emit('task.claimed', { taskId: a.taskId, decision: a.decision });
        break;
      case 'cover':
        if (!this.declined.has(a.taskId)) this.emit('task.covered', { taskId: a.taskId, decision: a.decision });
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
        this.requestRights(a, state);
        break;
    }
  }

  /** Decisions are facts, so the same refusal is stated once, not once per tick. */
  private repeats(task: TaskRecord | undefined, d: DecisionRecord): boolean {
    const last = task?.decisions.filter((x) => x.actor === this.id).at(-1);
    return !!last && last.outcome === d.outcome && last.refusal === d.refusal;
  }

  private requestRights(a: Extract<PlannerAction, { type: 'request-transfer' }>, state: MissionState): void {
    const known = transferRequests(state).some(
      (r) => r.by === this.id && r.taskId === a.taskId && r.resource === a.resource && r.from === a.from,
    );
    if (known) return;
    this.record(TRANSFER_REQUEST_KEY, { taskId: a.taskId, resource: a.resource, count: a.count, from: a.from }, a.taskId, 0);
  }

  /** A holder hands over rights it is not using, once per request, only to a requester it can reach. */
  private answerRequests(): void {
    const state = this.state();
    const reachable = new Set(this.reachable());
    for (const r of transferRequests(state)) {
      if (r.from !== this.id || !reachable.has(r.by)) continue;
      const task = state.tasks[r.taskId];
      if (!task || isFinished(task) || isMine(task, this.id)) continue;
      const need = task.spec.needs.find((n) => n.resource === r.resource);
      if (!need || r.count > need.count) continue;
      const transfer = transferIdFor(r);
      if (this.offered(transfer)) continue;
      const free = findTokens(state, this.id, r.resource, Number.MAX_SAFE_INTEGER);
      const spare = free.length - reservedFor(state, this.id, r.resource);
      if (spare < r.count) continue;
      this.emit('right.offered', { transfer, tokens: free.slice(0, r.count), to: r.by });
    }
  }

  private offered(transfer: TransferId): boolean {
    const held = [...this.unflushed, ...this.log.byActor(this.id)];
    return held.some((e) => e.type === 'right.offered' && e.body.transfer === transfer);
  }

  /** An offer answering this actor's own request needs no second confirmation. */
  private takeRequestedRights(): void {
    const state = this.state();
    const asked = new Set(transferRequests(state).filter((r) => r.by === this.id).map(transferIdFor));
    for (const t of this.pending(state)) {
      if (asked.has(t.transfer)) this.answerTransfer(t.transfer, true);
    }
  }

  private pending(state: MissionState) {
    return transfersAddressedTo(this.id, state, this.allEvents());
  }

  private applyContingencies(now: number): void {
    const state = this.state();
    const rules = activeRules(state, now).filter((r) => r.then.spawn?.some((s) => !state.tasks[s.id]));
    if (!rules.length) return;
    const group = [this.id, ...this.reachable()];
    for (const rule of rules) {
      if (spawnerFor(rule.id, group) !== this.id) continue;
      for (const spec of rule.then.spawn ?? []) {
        if (state.tasks[spec.id]) continue;
        this.emit('task.created', { spec, source: { kind: 'contingency', ref: `${rule.id}:${spec.id}` } });
      }
    }
  }

  /** The simulated volunteer: one tap per delay, always through the public commands. */
  private drive(now: number): void {
    const state = this.state();
    for (const t of this.pending(state)) this.answerTransfer(t.transfer, true);
    for (const task of Object.values(state.tasks)) {
      if (isFinished(task) || !isMine(task, this.id)) continue;
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
    if (!fresh.length) return;
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
    const meta: ActorMeta = { faults: this.faults, hqLive: [...this.hqLive], hqLate: [...this.hqLate] };
    try {
      void Promise.resolve(this.storage.saveMeta(meta)).catch(() => undefined);
    } catch {
      this.metaDirty = true;
    }
  }

  // ---------- Reading ----------

  private allEvents(): AnyEvent[] {
    const all = this.log.all();
    return this.unflushed.length ? [...all, ...this.unflushed] : all;
  }

  private state(): MissionState {
    const key = this.log.size + this.unflushed.length;
    if (this.stateCache && this.stateKey === key) return this.stateCache;
    this.stateCache = reduce(this.allEvents(), this.bundle.roster);
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
    this.viewCache = buildView({
      self: { id: this.id, team: this.team, name: this.name, custodian: this.custodian },
      state: this.state(),
      events: this.allEvents(),
      links: this.mesh?.links() ?? [],
      reachable: this.reachable(),
      horizon: this.horizon(),
      lastHeard: { ...this.heard },
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

  private requireRunning(): void {
    if (!this.running) throw new Error('actor is not running');
  }

  submitTask(spec: TaskSpec, source: TaskSource): void {
    this.requireRunning();
    const tasks = this.state().tasks;
    if (tasks[spec.id]) return;
    if (source.ref && Object.values(tasks).some((t) => t.source.ref === source.ref)) return;
    this.emit('task.created', { spec, source });
    this.kick();
  }

  acceptTask(id: TaskId, via: 'tap' | 'voice' | 'auto' = 'tap'): boolean {
    this.requireRunning();
    const task = this.state().tasks[id];
    if (!task || isFinished(task)) return false;
    if (this.accepted.has(id)) return true;
    if (!isMine(task, this.id)) {
      if (task.owner) return false;
      if (!this.volunteer(task)) return false;
    }
    if (!this.commitRights(id)) return false;
    this.emit('task.accepted', { taskId: id, via });
    this.kick();
    return true;
  }

  /** A person taking an unowned task is an explicit local decision, recorded like any other. */
  private volunteer(task: TaskRecord): boolean {
    const skills = this.state().capsule?.teams.find((t) => t.id === this.team)?.capabilities ?? [];
    if (!task.spec.requires.every((c) => skills.includes(c))) {
      this.refuse(task.spec.id, 'NO_CAPABILITY', `${this.name} does not have the skills this task requires.`);
      return false;
    }
    const decision = this.localDecision(task.spec.id, 'ACCEPTED', {
      reason: `${this.name} took this task by hand.`,
      policy: 'human-initiative',
    });
    this.emit('task.claimed', { taskId: task.spec.id, decision });
    return true;
  }

  /** Spends the rights a task needs. Refuses, on the record, when they are not held here. */
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
    if (!picked.length) return true;
    const check = canCommit(state, this.id, picked);
    if (!check.ok) {
      this.refuse(id, check.code, check.reason);
      return false;
    }
    this.emit('right.committed', { tokens: picked, taskId: id });
    return true;
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
    this.requireRunning();
    const task = this.state().tasks[id];
    if (!task || isFinished(task) || !isMine(task, this.id)) return false;
    this.emit('task.released', { taskId: id, reason });
    this.kick();
    return true;
  }

  completeTask(id: TaskId, evidence: string, via: 'tap' | 'voice' | 'auto' = 'tap'): boolean {
    this.requireRunning();
    const task = this.state().tasks[id];
    if (!task || isFinished(task) || !isMine(task, this.id)) return false;
    if (!this.accepted.has(id) && !this.acceptTask(id, via)) return false;
    this.emit('task.completed', { taskId: id, evidence, via });
    this.kick();
    return true;
  }

  offerTokens(tokens: TokenId[], to: ActorId): TransferId | null {
    this.requireRunning();
    const state = this.state();
    if (!tokens.length || !this.peers.includes(to) || !canCommit(state, this.id, tokens).ok) return null;
    const transfer = sha256(`${this.id}:${this.head.seq + 1}:${tokens.join(',')}`).slice(0, 22);
    this.emit('right.offered', { transfer, tokens, to });
    this.kick();
    return transfer;
  }

  answerTransfer(transfer: TransferId, accept: boolean): boolean {
    this.requireRunning();
    if (!this.pending(this.state()).some((t) => t.transfer === transfer)) return false;
    this.emit(accept ? 'right.accepted' : 'right.declined', { transfer });
    this.kick();
    return true;
  }

  observe(key: string, value: Json, opts: ObserveOptions = {}): void {
    this.requireRunning();
    this.record(key, value, opts.subject ?? key, opts.validForMs ?? 0);
    this.kick();
  }

  requestTransfer(resource: ResourceId, taskId: TaskId, from?: ActorId): boolean {
    this.requireRunning();
    const state = this.state();
    const task = state.tasks[taskId];
    const need = task?.spec.needs.find((n) => n.resource === resource);
    if (!task || !need || isFinished(task)) return false;
    const holder = from ?? this.likelyHolder(state, resource);
    if (!holder || holder === this.id) return false;
    this.requestRights({ type: 'request-transfer', resource, from: holder, count: need.count, taskId }, state);
    this.kick();
    return true;
  }

  private likelyHolder(state: MissionState, resource: ResourceId): ActorId | undefined {
    const holders = Object.values(state.tokens)
      .filter((t) => t.resource === resource && t.state === 'held' && t.holder && t.holder !== this.id)
      .map((t) => t.holder as ActorId);
    const reachable = new Set(this.reachable());
    return holders.find((h) => reachable.has(h)) ?? holders[0];
  }

  /** Hands an already open link to the mesh, for transports negotiated outside it. */
  adoptLink(link: Link): void {
    this.requireRunning();
    this.mesh?.adopt(link);
    this.sync?.nudge();
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

  // ---------- Ferry ----------

  buildFerry(remote?: SyncSummary): FerryPacket {
    return buildPacket({ keys: this.keys, log: this.log, remote, wall: this.now() });
  }

  ingestFerry(p: FerryPacket): FerryResult {
    this.requireRunning();
    const refuse = (reason: string): FerryResult => ({
      newEvents: 0,
      duplicates: 0,
      rejected: Array.isArray(p?.events) ? p.events.length : 0,
      buffered: 0,
      reason,
    });
    if (!this.bundle.roster.some((r) => r.actor === p?.from)) return refuse('sender is not on this mission');
    const check = verifyPacket(p, { mission: this.mission });
    if (!check.ok) return refuse(check.reason);

    const result = this.log.ingestMany(p.events);
    if (result.added.length) this.absorb(result.added);
    this.heard[p.from] = Math.max(p.createdAt, this.heard[p.from] ?? 0);
    const summary: FerryResult = {
      newEvents: result.added.length - result.forks.length,
      duplicates: result.duplicates,
      rejected: result.invalid.length + result.forks.length,
      buffered: result.gaps,
    };
    if (!this.ferried.has(p.id)) {
      this.emit('ferry.received', { packetId: p.id, from: p.from, events: p.events.length, newEvents: summary.newEvents });
      this.sync?.nudge();
      this.kick();
    }
    return summary;
  }
}

export function createActor(o: ActorOptions): ActorNode {
  return new Actor(o);
}
