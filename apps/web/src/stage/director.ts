import { generateKeys } from '@afterlink/protocol';
import type { ActorId, AnyEvent, DecisionRecord, EventId, EventType, LinkInfo, PartitionEpisode, RefusalCode, SyncSummary, TaskId, TeamId } from '@afterlink/protocol';
import { festivalCapsule, provision, scenarioBeats, scenarioSplit, type DemoBeat } from '@afterlink/mission';
import { DeviceHandle, deviceSrc, type CompactTask, type CompactView, type DeviceReport, type FramePixels } from '../bridge';
import { saveDebriefInput } from '../bridge/missionStore';
import { HqController } from '../hq';
import { allOpen, groupsOf, readPairs, type LinkBook, type Pair } from './graph';
import { castFor, STEPS, type Cast, type StepId } from './story';

const WAIT_SIGNAL_MS = 8_000;
const WAIT_ACTION_MS = 25_000;
const WAIT_LINKS_MS = 30_000;
const WAIT_SYNC_MS = 25_000;
const FRAME_MIN_MS = 170;
const FRAME_WAIT_MS = 500;
const FRAME_ROUNDS = 4;
const SENDER_FRAME_MS = 70;

export interface Seat {
  id: ActorId;
  team: TeamId;
  name: string;
  src: string;
  view: CompactView | null;
  links: LinkInfo[];
  signalUp: boolean;
}

export interface Mark {
  tone: 'request' | 'refused' | 'granted' | 'carry';
  text: string;
}

/** Refusals that protected something, the same set the debrief counts. Not "this is not my skill". */
const PROTECTIVE = new Set<RefusalCode>(['NO_RIGHT', 'TOKEN_IN_TRANSIT', 'STALE_KNOWLEDGE', 'HUMAN_APPROVAL_REQUIRED']);

export interface CarryState {
  phase: 'preparing' | 'walking' | 'scanning' | 'done' | 'failed';
  sender: ActorId;
  receiver: ActorId;
  have: number;
  total: number;
  newEvents: number;
}

export interface HqView {
  state: 'live' | 'blind';
  teams: number;
  done: number;
  lastConfirmedAt: number | null;
  blindFrom: number | null;
  blindTo: number | null;
  firstAt: number | null;
  ticks: { id: EventId; at: number; late: boolean }[];
}

export interface Snapshot {
  run: number;
  ready: boolean;
  mission: string;
  objective: string;
  resource: string;
  seats: Seat[];
  pairs: Pair[];
  groups: ActorId[][];
  step: StepId;
  busy: boolean;
  line: string;
  done: number;
  refused: number;
  hq: HqView;
  marks: Record<ActorId, Mark | undefined>;
  decisions: Record<ActorId, DecisionRecord[]>;
  titles: Record<TaskId, string>;
  carry: CarryState | null;
  error: string | null;
}

interface Internal extends Seat {
  handle: DeviceHandle;
  off: () => void;
  eventCount: number;
  received: Map<ActorId, number>;
}

interface HqEntry {
  id: EventId;
  wall: number;
  type: EventType;
  late: boolean;
}

const RANK: Record<CompactTask['status'], number> = { open: 0, deferred: 1, refused: 2, conflicted: 2, cancelled: 2, claimed: 3, accepted: 4, completed: 5 };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const lower = (s: string) => (s ? s[0]!.toLowerCase() + s.slice(1) : s);

class Waiting extends Error {}

/** Plays one solo mission: boots the devices, owns the HQ worker and runs every step for real. */
export class Director {
  private listeners = new Set<() => void>();
  private seats: Internal[] = [];
  private hq: HqController | null = null;
  private offHq: (() => void) | null = null;
  private cast: Cast | null = null;
  private run = 0;
  private stepIndex = 0;
  private busy = false;
  private ready = false;
  private line = '';
  private mission = '';
  private objective = '';
  private error: string | null = null;
  private marks: Record<ActorId, Mark | undefined> = {};
  private decisions: Record<ActorId, Map<string, DecisionRecord>> = {};
  private titles: Record<TaskId, string> = {};
  private carry: CarryState | null = null;
  private hqEntries = new Map<EventId, HqEntry>();
  private hqTeams = 0;
  private hqLastAt: number | null = null;
  private killedAt: number | null = null;
  private restoredAt: number | null = null;
  private splitGroups: ActorId[][] = [];
  private lastContact = new Map<ActorId, SyncSummary>();
  private waiters = new Set<() => void>();
  private cached: Snapshot | null = null;
  private queued = false;
  private frames = new Map<number, FramePixels>();
  private frameSink: ((pixels: FramePixels) => void) | null = null;
  private latestFrame: FramePixels | null = null;
  private frameTotal = 0;
  private ferryId = '';
  private arrived: (() => void) | null = null;
  private ferryEnded: ((ok: boolean) => void) | null = null;

  pulses: { peer: (from: ActorId, to: ActorId) => void; hq: (from: ActorId) => void } = {
    peer: () => undefined,
    hq: () => undefined,
  };

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  snapshot = (): Snapshot => (this.cached ??= this.build());

  start() {
    const run = ++this.run;
    this.teardown();
    this.stepIndex = 0;
    this.busy = false;
    this.ready = false;
    this.error = null;
    this.carry = null;
    this.marks = {};
    this.decisions = {};
    this.titles = {};
    this.hqEntries = new Map();
    this.hqTeams = 0;
    this.hqLastAt = null;
    this.killedAt = null;
    this.restoredAt = null;
    this.splitGroups = [];
    this.lastContact = new Map();
    this.line = '';

    const issuer = generateKeys();
    const capsule = festivalCapsule(issuer);
    const { bundles } = provision(capsule, issuer, `solo-${run}-${Date.now().toString(36)}`);
    const cast = castFor(capsule, scenarioBeats, scenarioSplit);
    this.cast = cast;
    this.mission = capsule.name;
    this.objective = capsule.objective;
    this.titles = Object.fromEntries(capsule.tasks.map((t) => [t.id, t.title]));

    const hq = new HqController();
    this.hq = hq;
    this.offHq = hq.subscribe(() => run === this.run && this.onHq());
    this.seats = cast.order.map((team, i) => {
      const bundle = bundles[team]!;
      const handle = new DeviceHandle(`${run}-${i}-${team}`);
      const seat: Internal = {
        id: bundle.actor.publicKey,
        team,
        name: bundle.name,
        src: deviceSrc(handle.slot),
        view: null,
        links: [],
        signalUp: false,
        handle,
        eventCount: 0,
        received: new Map(),
        off: () => undefined,
      };
      seat.off = handle.on((report) => {
        if (run === this.run) this.onReport(seat, report);
      });
      hq.attach(handle);
      handle.send({ kind: 'provision', bundle, autopilot: true, fresh: true });
      return seat;
    });
    hq.start();
    this.emit();
    void this.whenLive(run);
  }

  stop() {
    this.run++;
    this.teardown();
    this.wake();
  }

  attach(id: ActorId, frame: HTMLIFrameElement | null) {
    this.seats.find((s) => s.id === id)?.handle.attach(frame);
  }

  advance = () => {
    const step = STEPS[this.stepIndex];
    if (!this.ready || this.busy || !step) return;
    const run = this.run;
    this.busy = true;
    this.stepIndex = Math.min(this.stepIndex + 1, STEPS.length - 1);
    this.emit();
    this.play(step, run)
      .catch((e: unknown) => {
        if (run === this.run && e instanceof Waiting) this.say(e.message);
        else if (run === this.run) this.say('That step could not finish. Restart to run it again.');
      })
      .finally(() => {
        if (run !== this.run) return;
        this.busy = false;
        this.emit();
      });
  };

  /** The courier has physically reached the receiver. */
  carried() {
    this.arrived?.();
  }

  /** The courier shows each frame as it passes. */
  onFrames(sink: ((pixels: FramePixels) => void) | null) {
    this.frameSink = sink;
    if (sink && this.latestFrame) sink(this.latestFrame);
  }

  private play(step: StepId, run: number): Promise<void> {
    switch (step) {
      case 'break':
        return this.breakNetwork(run);
      case 'split':
        return this.splitTeams(run);
      case 'contest':
        return this.contest(run);
      case 'carry':
        return this.carryUpdate(run);
      case 'restore':
        return this.restore(run);
      case 'debrief':
        return this.debrief(run);
    }
  }

  private async whenLive(run: number) {
    try {
      await this.until(run, () => this.seats.every((s) => s.view && s.signalUp) && allOpen(this.pairs()), WAIT_LINKS_MS, 'The devices did not connect. Restart to try again.');
    } catch (e) {
      if (run === this.run) {
        this.error = (e as Error).message;
        this.emit();
      }
      return;
    }
    const cast = this.cast!;
    this.ready = true;
    this.raise(cast.connected);
    this.say(cast.connected.label);
    const task = await this.until(run, () => this.handled(cast.connected.spec!.id), WAIT_ACTION_MS, '').catch(() => null);
    if (run !== this.run || !task || this.stepIndex > 0) return;
    this.clearMark(cast.connected.team);
    this.say(`${this.nameOf(task.owner)} took it.`);
  }

  private async breakNetwork(run: number) {
    const cast = this.cast!;
    this.killedAt = Date.now();
    this.hq?.kill();
    this.say('HQ is gone.');
    await this.until(run, () => this.seats.every((s) => !s.signalUp), WAIT_SIGNAL_MS, 'A device has not noticed HQ is gone yet.');
    this.marks = {};
    this.raise(cast.hqDown);
    this.say(cast.hqDown.label);
    const task = await this.until(run, () => this.handled(cast.hqDown.spec!.id), WAIT_ACTION_MS, 'No team has picked this up yet.');
    this.clearMark(cast.hqDown.team);
    this.say(`${this.nameOf(task.owner)} took it from ${this.seatOf(cast.hqDown.team).name}, peer to peer.`);
  }

  private async splitTeams(run: number) {
    const cast = this.cast!;
    if (cast.held) {
      const held = cast.held;
      this.raise(held);
      await this.until(run, () => this.seats.every((s) => s.view?.tasks.some((t) => t.id === held.spec!.id && t.owner)), WAIT_ACTION_MS, 'Waiting for a team to take the request.');
      this.clearMark(held.team);
    }
    const left = this.seats.filter((s) => cast.left.includes(s.team));
    const right = this.seats.filter((s) => cast.right.includes(s.team));
    for (const s of this.seats) if (s.view) this.lastContact.set(s.id, s.view.summary);
    for (const s of left) s.handle.send({ kind: 'setFaults', plan: { blocked: right.map((r) => r.id) } });
    for (const s of right) s.handle.send({ kind: 'setFaults', plan: { blocked: left.map((l) => l.id) } });
    this.splitGroups = [left.map((s) => s.id), right.map((s) => s.id)];
    await this.until(run, () => this.groups().length > 1, WAIT_SIGNAL_MS, 'The links have not dropped yet.');
    this.say('Two groups. Neither can see the other.');
    for (const beat of cast.split) this.raise(beat);
    await this.until(run, () => cast.split.every((b) => this.handled(b.spec!.id)), WAIT_ACTION_MS, 'A group is still working on its request.');
    for (const beat of cast.split) this.clearMark(beat.team);
    this.say('Each group handled its own request.');
  }

  private async contest(run: number) {
    const cast = this.cast!;
    const refused = cast.refused.spec!.id;
    const granted = cast.granted.spec!.id;
    this.seatOf(cast.refused.team).handle.send({ kind: 'addTask', spec: cast.refused.spec!, source: { kind: 'human', ref: cast.refused.id } });
    this.seatOf(cast.granted.team).handle.send({ kind: 'addTask', spec: cast.granted.spec!, source: { kind: 'human', ref: cast.granted.id } });
    this.remember(cast.refused);
    this.remember(cast.granted);
    const { seat, decision } = await this.until(run, () => this.refusalOf(refused), WAIT_ACTION_MS, 'Waiting for the refusal.');
    this.marks = { ...this.marks, [seat.id]: { tone: 'refused', text: 'Refused' } };
    this.say(`${seat.name} refused: ${lower(decision.reason.replace(/^Cannot start:\s*/, ''))}`);
    const task = await this.until(run, () => this.committed(granted), WAIT_ACTION_MS, 'Waiting for the allocation.');
    if (task.owner) this.marks = { ...this.marks, [task.owner]: { tone: 'granted', text: 'Allocated' } };
    this.emit();
  }

  private async carryUpdate(run: number) {
    const cast = this.cast!;
    const sender = this.seatOf(cast.sender);
    const receiver = this.seatOf(cast.receiver);
    const obs = cast.ferry.observation!;
    const before = sender.view?.eventCount ?? 0;
    const heldBefore = receiver.view?.tasks.filter((t) => t.owner === receiver.id).map((t) => t.id) ?? [];
    this.marks = {};
    this.say(cast.ferry.label);
    sender.handle.send({ kind: 'observe', key: obs.key, value: obs.value, options: { subject: obs.subject } });
    await this.until(run, () => (sender.view?.eventCount ?? 0) > before, WAIT_SIGNAL_MS, 'The sender did not record it.');

    this.ferryId = `ferry-${run}-${Date.now().toString(36)}`;
    this.frames = new Map();
    this.frameTotal = 0;
    this.latestFrame = null;
    this.carry = { phase: 'preparing', sender: sender.id, receiver: receiver.id, have: 0, total: 0, newEvents: 0 };
    this.emit();
    const arrived = new Promise<void>((resolve) => (this.arrived = resolve));
    const ended = new Promise<boolean>((resolve) => (this.ferryEnded = resolve));
    sender.handle.send({ kind: 'ferryStart', ferryId: this.ferryId, remote: this.lastContact.get(receiver.id), frameMs: SENDER_FRAME_MS });
    await this.until(run, () => this.frames.size > 0, WAIT_SIGNAL_MS, 'The sender did not produce a code.');
    await sleep(700);
    if (run !== this.run) return;
    this.setCarry({ phase: 'walking' });
    await Promise.race([arrived, sleep(5000)]);
    if (run !== this.run) return;
    await this.until(run, () => this.frameTotal > 0 && this.frames.size >= this.frameTotal, WAIT_ACTION_MS, 'The sender stopped showing frames.');
    this.setCarry({ phase: 'scanning' });
    await this.scan(run, receiver);
    const ok = await Promise.race([ended, sleep(3000).then(() => false)]);
    if (run !== this.run) return;
    if (!ok) {
      this.setCarry({ phase: 'failed' });
      this.say('The update did not verify. Nothing was applied.');
      return;
    }
    this.setCarry({ phase: 'done' });
    const events = this.carry?.newEvents ?? 0;
    this.marks = { [receiver.id]: { tone: 'carry', text: `${events} signed ${events === 1 ? 'event' : 'events'} verified` } };
    this.say(`${receiver.name} now knows what only ${sender.name} saw. No network involved.`);
    const known = new Set(heldBefore);
    const took = await this.until(run, () => receiver.view?.tasks.find((t) => t.owner === receiver.id && !known.has(t.id)), 4000, '').catch(() => null);
    if (run === this.run && took) this.say(`${receiver.name} now knows what only ${sender.name} saw, and took ${lower(took.title)}.`);
  }

  /** Replays the sender's frames at the receiver's scanner until its assembler is complete. */
  private async scan(run: number, receiver: Internal) {
    for (let round = 0; round < FRAME_ROUNDS; round++) {
      for (let i = 0; i < this.frameTotal; i++) {
        const c = this.carry;
        if (run !== this.run || !c || c.phase !== 'scanning') return;
        if (c.total > 0 && c.have >= c.total) return;
        const pixels = this.frames.get(i);
        if (!pixels) continue;
        this.latestFrame = pixels;
        this.frameSink?.(pixels);
        const data = new Uint8ClampedArray(pixels.data);
        const started = performance.now();
        receiver.handle.send({ kind: 'ferryFrame', ferryId: this.ferryId, pixels: { width: pixels.width, height: pixels.height, data } }, [data.buffer]);
        await this.settle(run, () => (this.carry?.have ?? 0) > c.have, FRAME_WAIT_MS);
        const left = FRAME_MIN_MS - (performance.now() - started);
        if (left > 0) await sleep(left);
      }
    }
  }

  private async restore(run: number) {
    this.restoredAt = Date.now();
    this.carry = null;
    this.marks = {};
    this.hq?.restore();
    for (const s of this.seats) s.handle.send({ kind: 'setFaults', plan: { blocked: [] } });
    this.say('HQ is back. Links are forming.');
    await this.until(run, () => allOpen(this.pairs()) && this.seats.every((s) => s.signalUp), WAIT_LINKS_MS, 'Links are still coming back.');
    this.say('Teams are exchanging what they missed.');
    await this.until(run, () => this.converged(), WAIT_SYNC_MS, 'Devices are still catching up.');
    await this.settle(run, () => this.settledHq(), 3000);
    const late = [...this.hqEntries.values()].filter((e) => e.late).length;
    this.say(`Contact restored. HQ just learned ${late} ${late === 1 ? 'event' : 'events'} it never saw happen.`);
  }

  private async debrief(run: number) {
    const all = await Promise.all(this.seats.map((s) => this.eventsOf(s)));
    if (run !== this.run) return;
    const events = new Map<EventId, AnyEvent>();
    const hqSeen = new Set<EventId>();
    for (const r of all) {
      for (const e of r.events) events.set(e.id, e);
      for (const id of r.hqSeen) hqSeen.add(id);
    }
    await saveDebriefInput({ events: [...events.values()], hqSeen: [...hqSeen], episodes: this.episodes(events) });
    if (run === this.run) window.location.hash = '/debrief';
  }

  private eventsOf(seat: Internal): Promise<Extract<DeviceReport, { kind: 'events' }>> {
    return new Promise((resolve) => {
      const requestId = `${seat.id}-${Date.now()}`;
      const off = seat.handle.on((r) => {
        if (r.kind !== 'events' || r.requestId !== requestId) return;
        off();
        resolve(r);
      });
      seat.handle.send({ kind: 'requestEvents', requestId });
    });
  }

  /** The interval HQ could not see, tallied from the events that really happened inside it. */
  private episodes(events: Map<EventId, AnyEvent>): PartitionEpisode[] {
    if (this.killedAt === null) return [];
    const from = this.killedAt;
    const to = this.restoredAt;
    const inside = [...events.values()].filter((e) => e.wall >= from && (to === null || e.wall <= to));
    const count = (...types: EventType[]) => inside.filter((e) => types.includes(e.type)).length;
    return [
      {
        id: 'hq-blind',
        from,
        to,
        groups: this.splitGroups.length ? this.splitGroups : [this.seats.map((s) => s.id)],
        tasksDone: count('task.completed'),
        decisions: count('task.claimed', 'task.covered', 'task.refused', 'task.deferred'),
        refusals: count('task.refused'),
      },
    ];
  }

  private raise(beat: DemoBeat) {
    if (!beat.spec) return;
    const seat = this.seatOf(beat.team);
    seat.handle.send({ kind: 'addTask', spec: beat.spec, source: { kind: 'human', ref: beat.id } });
    this.remember(beat);
    this.marks = { ...this.marks, [seat.id]: { tone: 'request', text: 'New request' } };
    this.emit();
  }

  private remember(beat: DemoBeat) {
    if (beat.spec) this.titles = { ...this.titles, [beat.spec.id]: beat.spec.title };
  }

  private clearMark(team: TeamId) {
    const id = this.seatOf(team).id;
    if (this.marks[id]?.tone !== 'request') return;
    const { [id]: _gone, ...rest } = this.marks;
    this.marks = rest;
    this.emit();
  }

  private say(line: string) {
    this.line = line;
    this.emit();
  }

  private setCarry(patch: Partial<CarryState>) {
    if (this.carry) this.carry = { ...this.carry, ...patch };
    this.emit();
    this.wake();
  }

  private seatOf(team: TeamId): Internal {
    return this.seats.find((s) => s.team === team)!;
  }

  private nameOf(actor?: ActorId): string {
    return this.seats.find((s) => s.id === actor)?.name ?? 'A team';
  }

  /** The furthest any device has seen a task go. */
  private task(id: TaskId): CompactTask | null {
    let best: CompactTask | null = null;
    for (const s of this.seats) {
      const t = s.view?.tasks.find((x) => x.id === id);
      if (t && (!best || RANK[t.status] > RANK[best.status])) best = t;
    }
    return best;
  }

  private handled(id: TaskId): CompactTask | null {
    const t = this.task(id);
    return t?.owner && RANK[t.status] >= RANK.claimed ? t : null;
  }

  private committed(id: TaskId): CompactTask | null {
    const t = this.handled(id);
    return t && this.seats.some((s) => s.view?.tokens.some((k) => k.committedTo === id)) ? t : null;
  }

  private refusalOf(id: TaskId): { seat: Internal; decision: DecisionRecord } | null {
    for (const seat of this.seats) {
      const decision = seat.view?.refusals.find((d) => d.taskId === id);
      if (decision) return { seat, decision };
    }
    return null;
  }

  private converged(): boolean {
    const heads = this.seats.map((s) => JSON.stringify(Object.entries(s.view?.summary.heads ?? {}).map(([a, h]) => [a, h.seq]).sort()));
    return heads.every((h) => h === heads[0]);
  }

  private settledHq(): boolean {
    const total = Math.max(...this.seats.map((s) => s.view?.eventCount ?? 0));
    return this.hqEntries.size >= total - 1;
  }

  private pairs(): Pair[] {
    const book: LinkBook = {};
    for (const s of this.seats) book[s.id] = s.links;
    return readPairs(this.seats.map((s) => s.id), book);
  }

  private groups(): ActorId[][] {
    return groupsOf(this.seats.map((s) => s.id), this.pairs());
  }

  private onReport(seat: Internal, report: DeviceReport) {
    switch (report.kind) {
      case 'view':
        this.onView(seat, report.view);
        break;
      case 'links':
        seat.links = report.links;
        seat.signalUp = report.signalUp;
        break;
      case 'ferryFrame':
        this.onSenderFrame(report);
        break;
      case 'ferrySent':
        this.frameTotal = report.frames;
        break;
      case 'ferryProgress':
        if (this.carry) this.carry = { ...this.carry, have: report.have, total: report.total };
        break;
      case 'ferryResult':
        if (this.carry) this.carry = { ...this.carry, newEvents: report.newEvents, have: this.carry.total };
        this.ferryEnded?.(true);
        break;
      case 'ferryRejected':
        this.ferryEnded?.(false);
        break;
      case 'refusal':
        this.note(seat, report.decision);
        break;
      case 'failed':
        this.error = report.message;
        break;
      default:
        return;
    }
    this.emit();
    this.wake();
  }

  private onSenderFrame(report: Extract<DeviceReport, { kind: 'ferryFrame' }>) {
    this.frameTotal = report.total;
    this.frames.set(report.index, report.pixels);
    this.latestFrame = report.pixels;
    if (this.carry && this.carry.total !== report.total) this.carry = { ...this.carry, total: report.total };
    this.frameSink?.(report.pixels);
  }

  private onView(seat: Internal, view: CompactView) {
    this.flow(seat, view);
    seat.view = view;
    seat.links = view.links;
    seat.signalUp = view.signalUp;
    for (const t of view.tasks) if (!this.titles[t.id]) this.titles = { ...this.titles, [t.id]: t.title };
    if (view.lastDecision) this.note(seat, view.lastDecision);
    for (const d of view.refusals) this.note(seat, d);
  }

  /** A pulse marks a real delivery: this device's log grew and that peer sent it something. */
  private flow(seat: Internal, view: CompactView) {
    const grew = view.eventCount > seat.eventCount;
    seat.eventCount = view.eventCount;
    for (const l of view.links) {
      const before = seat.received.get(l.peer) ?? 0;
      seat.received.set(l.peer, l.received);
      if (grew && l.state === 'open' && l.received > before) this.pulses.peer(l.peer, seat.id);
    }
  }

  private note(seat: Internal, d: DecisionRecord) {
    (this.decisions[seat.id] ??= new Map()).set(d.id, d);
  }

  private onHq() {
    const hq = this.hq?.snapshot();
    if (!hq) return;
    if (hq.alive && hq.state) {
      this.hqLastAt = hq.lastConfirmedAt;
      this.hqTeams = Object.values(hq.state.actors).filter((a) => a.connected).length;
      const authors = new Set<ActorId>();
      for (const e of hq.state.recent) {
        if (this.hqEntries.has(e.id)) continue;
        const late = this.restoredAt !== null && e.wall < this.restoredAt;
        this.hqEntries.set(e.id, { id: e.id, wall: e.wall, type: e.type, late });
        authors.add(e.actor);
      }
      for (const a of authors) this.pulses.hq(a);
    }
    this.emit();
    this.wake();
  }

  private teardown() {
    this.offHq?.();
    this.offHq = null;
    this.hq?.dispose();
    this.hq = null;
    for (const s of this.seats) {
      s.off();
      s.handle.dispose();
    }
    this.seats = [];
    this.frames = new Map();
    this.latestFrame = null;
  }

  private until<T>(run: number, read: () => T | null | false | undefined, timeoutMs: number, message: string): Promise<NonNullable<T>> {
    return new Promise((resolve, reject) => {
      const done = () => {
        this.waiters.delete(check);
        clearTimeout(timer);
      };
      const check = () => {
        if (run !== this.run) {
          done();
          reject(new Waiting(''));
          return;
        }
        const value = read();
        if (value) {
          done();
          resolve(value as NonNullable<T>);
        }
      };
      const timer = setTimeout(() => {
        done();
        reject(new Waiting(message));
      }, timeoutMs);
      this.waiters.add(check);
      check();
    });
  }

  private settle(run: number, read: () => boolean, ms: number): Promise<void> {
    return this.until(run, read, ms, '').then(
      () => undefined,
      () => undefined,
    );
  }

  private wake() {
    for (const w of [...this.waiters]) w();
  }

  private emit() {
    this.cached = null;
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => {
      this.queued = false;
      this.listeners.forEach((fn) => fn());
    });
  }

  private build(): Snapshot {
    const pairs = this.pairs();
    const status = new Map<TaskId, CompactTask['status']>();
    const refused = new Set<TaskId>();
    for (const s of this.seats) {
      for (const t of s.view?.tasks ?? []) {
        const cur = status.get(t.id);
        if (!cur || RANK[t.status] > RANK[cur]) status.set(t.id, t.status);
      }
      for (const d of s.view?.refusals ?? []) if (d.refusal && PROTECTIVE.has(d.refusal)) refused.add(d.taskId);
    }
    const decisions: Record<ActorId, DecisionRecord[]> = {};
    for (const [a, m] of Object.entries(this.decisions)) decisions[a] = [...m.values()].reverse();
    return {
      run: this.run,
      ready: this.ready,
      mission: this.mission,
      objective: this.objective,
      resource: this.cast?.resourceName ?? '',
      seats: this.seats.map(({ id, team, name, src, view, links, signalUp }) => ({ id, team, name, src, view, links, signalUp })),
      pairs,
      groups: groupsOf(this.seats.map((s) => s.id), pairs),
      step: STEPS[this.stepIndex]!,
      busy: this.busy,
      line: this.line,
      done: [...status.values()].filter((s) => s === 'completed').length,
      refused: refused.size,
      hq: this.hqView(),
      marks: this.marks,
      decisions,
      titles: this.titles,
      carry: this.carry,
      error: this.error,
    };
  }

  private hqView(): HqView {
    const entries = [...this.hqEntries.values()];
    const alive = this.hq?.snapshot().alive ?? false;
    return {
      state: alive ? 'live' : 'blind',
      teams: this.hqTeams,
      done: entries.filter((e) => e.type === 'task.completed').length,
      lastConfirmedAt: this.hqLastAt,
      blindFrom: this.killedAt,
      blindTo: this.restoredAt,
      firstAt: entries.length ? entries.reduce((m, e) => Math.min(m, e.wall), Infinity) : null,
      ticks: entries.map((e) => ({ id: e.id, at: e.wall, late: e.late })),
    };
  }
}
