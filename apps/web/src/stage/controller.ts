import { generateKeys } from '@afterlink/protocol';
import type { ActorId, AnyEvent, DecisionRecord, EventId, EventType, LinkInfo, MissionCapsule, PartitionEpisode, Point, RefusalCode, SyncSummary, TaskId, TaskSpec, TeamId, TokenRecord } from '@afterlink/protocol';
import { festivalCapsule, isTaskDone, provision, scenarioBeats, scenarioSplit, validateTaskSpec, type DemoBeat } from '@afterlink/mission';
import type { CompactTask, CompactView, DeviceReport, FramePixels } from '../bridge';
import { saveDebriefInput } from '../bridge/missionStore';
import type { RequestKind, StageCarry, StageController, StageDevice, StageEvent, StageHq, StageLink, StageMark, StageState, StepId } from './contract';
import { allOpen, groupsOf, pairKey, readPairs, type LinkBook, type Pair } from './graph';
import { SoloHost, type DeviceLink, type MissionHost } from './host';
import { castFor, labelFor, STEPS, type Cast } from './story';

/** How long the simulated volunteers take over each tap, so a task takes seconds. */
const PACE_MS = 3500;
const WALK_MS = 4500;
const WALK_LIMIT_MS = 25_000;
const WAIT_SIGNAL_MS = 8_000;
const WAIT_ACTION_MS = 30_000;
const WAIT_HUMAN_MS = 180_000;
const WAIT_LINKS_MS = 30_000;
const WAIT_SYNC_MS = 25_000;
const FRAME_MIN_MS = 170;
const FRAME_WAIT_MS = 500;
const FRAME_ROUNDS = 4;
const SENDER_FRAME_MS = 70;
const SHOW_CODE_MS = 700;
const ENDING_AFTER_MS = 6000;

/** Refusals that protected something, the same set the debrief counts. Not "this is not my skill". */
const PROTECTIVE = new Set<RefusalCode>(['NO_RIGHT', 'TOKEN_IN_TRANSIT', 'STALE_KNOWLEDGE', 'HUMAN_APPROVAL_REQUIRED']);

const RANK: Record<CompactTask['status'], number> = { open: 0, deferred: 1, refused: 2, conflicted: 2, cancelled: 2, claimed: 3, accepted: 4, completed: 5 };

const REQUESTS: Record<RequestKind, Pick<TaskSpec, 'kind' | 'title' | 'brief' | 'priority' | 'requires' | 'needs' | 'reversible'> & { objective: string }> = {
  'first-aid': { kind: 'medical', title: 'Help someone who is hurt', brief: 'Someone here needs first aid. Go now.', objective: 'safety', priority: 1, requires: ['first-aid'], needs: [], reversible: true },
  'blocked-path': { kind: 'repair', title: 'Clear a blocked path', brief: 'Something is blocking the path here. Clear it.', objective: 'access', priority: 2, requires: ['repair'], needs: [], reversible: true },
  wheelchair: { kind: 'evacuation', title: 'Bring the evacuation chair', brief: 'Someone here cannot manage the stairs. Bring the evacuation chair.', objective: 'safety', priority: 1, requires: ['mobility'], needs: [{ resource: 'evac-chair', count: 1 }], reversible: false },
};

interface Seat {
  id: ActorId;
  team: TeamId;
  name: string;
  src: string;
  home: Point;
  view: CompactView | null;
  links: LinkInfo[];
  signalUp: boolean;
  handle: DeviceLink;
  off: () => void;
  eventCount: number;
  received: Map<ActorId, number>;
}

interface HqEntry {
  id: EventId;
  wall: number;
  /** Set when this event finished a task. */
  finished: TaskId | null;
  late: boolean;
}

class Waiting extends Error {}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const lower = (s: string) => (s ? s[0]!.toLowerCase() + s.slice(1) : s);
const away = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** One solo mission: boots the devices, owns HQ, and turns every story step and every gesture into a real command. */
export class MissionController implements StageController {
  private listeners = new Set<() => void>();
  private watchers = new Set<(e: StageEvent) => void>();
  private seats: Seat[] = [];
  private cast: Cast | null = null;
  private capsule: MissionCapsule | null = null;
  private run = 0;
  private phase: StageState['phase'] = 'connecting';
  private failure: string | null = null;
  private stepIndex = 0;
  private busy = false;
  private finished = false;
  private line = '';
  private marks: Record<ActorId, StageMark | undefined> = {};
  private decisions: Record<ActorId, Map<string, DecisionRecord>> = {};
  private carryState: StageCarry | null = null;
  private frameSink: ((pixels: FramePixels) => void) | null = null;
  private why: ActorId | null = null;
  private faults = new Map<ActorId, Set<ActorId>>();
  private linkStates = new Map<string, Pair['state']>();
  private linksCut = 0;
  private taskStatus = new Map<TaskId, CompactTask['status']>();
  private allocated = new Set<TaskId>();
  private drops = 0;
  private hqEntries = new Map<EventId, HqEntry>();
  private hqTeams = 0;
  private hqDone = 0;
  private hqLastAt: number | null = null;
  private everOpen = new Set<string>();
  private blind: { from: number; to: number | null }[] = [];
  private contact = new Map<ActorId, Map<ActorId, SyncSummary>>();
  private waiters = new Set<() => void>();
  private cached: StageState | null = null;
  private queued = false;
  private frames = new Map<number, FramePixels>();
  private frameTotal = 0;
  private ferryId = '';
  private arrived: (() => void) | null = null;
  private ferryEnded: ((ok: boolean) => void) | null = null;

  constructor(private readonly host: MissionHost = new SoloHost()) {}

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  snapshot = () => (this.cached ??= this.build());

  on = (fn: (e: StageEvent) => void) => {
    this.watchers.add(fn);
    return () => {
      this.watchers.delete(fn);
    };
  };

  onPulse = (fn: Parameters<StageController['onPulse']>[0]) =>
    this.on((e) => {
      if (e.kind === 'sync') fn({ kind: 'peer', from: e.from, to: e.to });
      if (e.kind === 'report') fn({ kind: 'hq', from: e.actor });
    });

  onFrames = (sink: ((pixels: FramePixels) => void) | null) => {
    this.frameSink = sink;
  };

  restart = () => this.start();

  start() {
    const run = ++this.run;
    this.teardown();
    this.phase = 'connecting';
    this.failure = null;
    this.stepIndex = 0;
    this.busy = false;
    this.finished = false;
    this.line = '';
    this.marks = {};
    this.decisions = {};
    this.carryState = null;
    this.why = null;
    this.faults = new Map();
    this.linkStates = new Map();
    this.linksCut = 0;
    this.taskStatus = new Map();
    this.allocated = new Set();
    this.drops = 0;
    this.hqEntries = new Map();
    this.hqTeams = 0;
    this.hqDone = 0;
    this.hqLastAt = null;
    this.everOpen = new Set();
    this.blind = [];
    this.contact = new Map();

    if (typeof RTCPeerConnection === 'undefined') {
      this.fail('This browser cannot open direct connections between devices.');
      return;
    }

    const issuer = generateKeys();
    const capsule = festivalCapsule(issuer);
    const { bundles } = provision(capsule, issuer, this.host.room(run));
    const cast = castFor(capsule, scenarioBeats, scenarioSplit);
    this.capsule = capsule;
    this.cast = cast;

    this.host.begin(
      () => {
        if (run === this.run) this.onHq();
      },
      (message) => {
        if (run === this.run) this.fail(message);
      },
    );
    this.seats = cast.order.map((team, i) => {
      const bundle = bundles[team]!;
      const { link, src } = this.host.device(run, i, bundle, PACE_MS);
      const seat: Seat = {
        id: bundle.actor.publicKey,
        team,
        name: bundle.name,
        src,
        home: capsule.teams.find((t) => t.id === team)!.home,
        view: null,
        links: [],
        signalUp: false,
        handle: link,
        off: () => undefined,
        eventCount: 0,
        received: new Map(),
      };
      seat.off = link.on((report) => {
        if (run === this.run) this.onReport(seat, report);
      });
      return seat;
    });
    this.host.ready(cast.order.map((team) => bundles[team]!), issuer);
    this.emit();
    void this.whenLive(run);
  }

  stop() {
    this.run++;
    this.teardown();
    this.wake();
  }

  /** Binds a device iframe. The stage renders these and keeps them alive. */
  attach(id: ActorId, frame: HTMLIFrameElement | null) {
    this.host.attach(id, frame);
  }

  // ---------- Story ----------

  advance = () => {
    const step = STEPS[this.stepIndex];
    if (this.phase !== 'live' || this.busy || !step) return;
    const run = this.run;
    this.busy = true;
    this.stepIndex = Math.min(this.stepIndex + 1, STEPS.length - 1);
    this.emit();
    this.play(step, run)
      .catch((e: unknown) => {
        if (run === this.run) this.say(e instanceof Waiting ? e.message : 'That step could not finish. Restart to run it again.');
      })
      .finally(() => {
        if (run !== this.run) return;
        this.busy = false;
        this.emit();
      });
  };

  private play(step: StepId, run: number): Promise<void> {
    switch (step) {
      case 'break':
        return this.storyBreak(run);
      case 'split':
        return this.storySplit(run);
      case 'contest':
        return this.storyContest(run);
      case 'carry':
        return this.storyCarry(run);
      case 'restore':
        return this.storyRestore(run);
      case 'debrief':
        return this.debrief(run);
    }
  }

  private async whenLive(run: number) {
    try {
      await this.until(run, () => this.seats.every((s) => s.view && s.signalUp) && allOpen(this.pairs()), this.host.humans ? Infinity : WAIT_LINKS_MS, 'The devices could not connect to each other. Restart to try again.');
    } catch (e) {
      if (run === this.run) this.fail((e as Error).message);
      return;
    }
    const beat = this.cast!.connected;
    this.phase = 'live';
    this.raise(beat);
    this.say(beat.label);
    const task = await this.until(run, () => this.handled(beat.spec!.id), this.actionMs(), '').catch(() => null);
    if (run !== this.run || !task) return;
    this.clearRequest(beat.team);
    if (this.stepIndex === 0) this.say(`${this.nameOf(task.owner)} took it.`);
  }

  private async storyBreak(run: number) {
    const beat = this.cast!.hqDown;
    this.killHq();
    this.say('HQ is gone.');
    await this.until(run, () => this.seats.every((s) => !s.signalUp), WAIT_SIGNAL_MS, 'A device has not noticed HQ is gone yet.');
    this.raise(beat);
    this.say(beat.label);
    const task = await this.until(run, () => this.handled(beat.spec!.id), this.actionMs(), 'No team has picked this up yet.');
    this.clearRequest(beat.team);
    this.say(`${this.nameOf(task.owner)} took it from ${this.seatOf(beat.team).name}, peer to peer.`);
  }

  private async storySplit(run: number) {
    const cast = this.cast!;
    const held = cast.held;
    if (held) {
      this.raise(held);
      this.say(held.label);
      await this.until(run, () => this.seats.every((s) => s.view?.tasks.some((t) => t.id === held.spec!.id && t.owner)), this.actionMs(), 'Waiting for a team to take the request.');
      this.clearRequest(held.team);
    }
    const left = this.seats.filter((s) => cast.left.includes(s.team));
    const right = this.seats.filter((s) => cast.right.includes(s.team));
    this.setBlocked(left.flatMap((l) => right.map((r) => [l.id, r.id] as const)), true);
    await this.until(run, () => this.groups().length > 1, WAIT_SIGNAL_MS, 'The links have not dropped yet.');
    this.say('Two groups. Neither can see the other.');
    for (const beat of cast.split) this.raise(beat);
    await this.until(run, () => cast.split.every((b) => this.handled(b.spec!.id)), this.actionMs(), 'A group is still working on its request.');
    for (const beat of cast.split) this.clearRequest(beat.team);
    this.say('Each group handled its own request.');
  }

  private async storyContest(run: number) {
    const cast = this.cast!;
    const refused = cast.refused.spec!.id;
    const granted = cast.granted.spec!.id;
    this.raise(cast.refused);
    this.raise(cast.granted);
    const { seat, decision } = await this.until(run, () => this.refusalOf(refused), this.actionMs(), 'Waiting for the refusal.');
    this.mark(seat.id, { tone: 'refused', text: 'Refused' });
    this.say(`${seat.name} refused: ${decision.reason.replace(/^Cannot start:\s*/, '')}`);
    const task = await this.until(run, () => this.committed(granted), this.actionMs(), 'Waiting for the allocation.');
    this.clearRequest(cast.granted.team);
    if (task.owner) this.mark(task.owner, { tone: 'granted', text: 'Allocated' });
  }

  private async storyCarry(run: number) {
    const cast = this.cast!;
    const sender = this.seatOf(cast.sender);
    const receiver = this.seatOf(cast.receiver);
    const held = cast.held?.spec;
    if (held) {
      this.say(`Both groups are finishing: ${lower(held.title)}.`);
      await this.settle(run, () => this.doneInEveryGroup(held.id), this.actionMs());
    }
    const obs = cast.ferry.observation!;
    const before = sender.view?.eventCount ?? 0;
    const heldBefore = new Set(receiver.view?.tasks.filter((t) => t.owner === receiver.id).map((t) => t.id));
    this.marks = {};
    this.say(cast.ferry.label);
    sender.handle.send({ kind: 'observe', key: obs.key, value: obs.value, options: { subject: obs.subject } });
    await this.until(run, () => (sender.view?.eventCount ?? 0) > before, WAIT_SIGNAL_MS, 'The sender did not record it.');
    if (this.host.humans) await this.humanCarry(run, sender, receiver);
    else if (!(await this.runCarry(run, sender, receiver))) return;
    this.say(`${receiver.name} now knows what only ${sender.name} saw. No network involved.`);
    const took = await this.until(run, () => receiver.view?.tasks.find((t) => t.owner === receiver.id && !heldBefore.has(t.id)), 5000, '').catch(() => null);
    if (run === this.run && took) this.say(`${receiver.name} now knows what only ${sender.name} saw. It took: ${took.title}.`);
  }

  private async storyRestore(run: number) {
    this.carryState = null;
    this.marks = {};
    this.healAll();
    this.say('HQ is back. Links are forming.');
    await this.until(run, () => allOpen(this.pairs()) && this.seats.every((s) => s.signalUp), WAIT_LINKS_MS, 'Links are still coming back.');
    this.say('Teams are exchanging what they missed.');
    await this.until(run, () => this.converged(), WAIT_SYNC_MS, 'Devices are still catching up.');
    await this.settle(run, () => this.hqCaughtUp(), 3000);
    if (!this.host.hq().state) await this.readBackfill(run);
    const late = [...this.hqEntries.values()].filter((e) => e.late).length;
    this.say(`Contact restored. HQ just learned ${late} ${late === 1 ? 'event' : 'events'} it never saw happen.`);
    void sleep(ENDING_AFTER_MS).then(() => {
      if (run !== this.run) return;
      this.finished = true;
      this.emit();
    });
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

  /** A remote HQ cannot be read directly, so ask the devices what they delivered to it and when. */
  private async readBackfill(run: number) {
    await sleep(1500);
    const all = await Promise.all(this.seats.map((s) => this.eventsOf(s)));
    if (run !== this.run) return;
    const walls = new Map(all.flatMap((r) => r.events.map((e) => [e.id, e] as const)));
    const add = (id: EventId, late: boolean) => {
      const e = walls.get(id);
      if (e && !this.hqEntries.has(id)) this.hqEntries.set(id, this.entry(e, late));
    };
    for (const r of all) {
      r.hqSeen.forEach((id) => add(id, false));
      r.hqBackfilled.forEach((id) => add(id, true));
    }
    this.emit();
  }

  private entry(e: AnyEvent, late: boolean): HqEntry {
    return { id: e.id, wall: e.wall, finished: e.type === 'task.completed' ? e.body.taskId : null, late };
  }

  private eventsOf(seat: Seat): Promise<Extract<DeviceReport, { kind: 'events' }>> {
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

  /** Each interval HQ could not see, tallied from the events that really happened inside it. */
  private episodes(events: Map<EventId, AnyEvent>): PartitionEpisode[] {
    const groups = this.cast ? [this.seats.filter((s) => this.cast!.left.includes(s.team)).map((s) => s.id), this.seats.filter((s) => this.cast!.right.includes(s.team)).map((s) => s.id)] : [];
    return this.blind.map(({ from, to }, i) => {
      const inside = [...events.values()].filter((e) => e.wall >= from && (to === null || e.wall <= to));
      const count = (...types: EventType[]) => inside.filter((e) => types.includes(e.type)).length;
      return {
        id: `hq-blind-${i + 1}`,
        from,
        to,
        groups,
        tasksDone: count('task.completed'),
        decisions: count('task.claimed', 'task.covered', 'task.refused', 'task.deferred'),
        refusals: count('task.refused'),
      };
    });
  }

  // ---------- Real actions ----------

  killHq = () => {
    if (!this.host.hq().alive) return;
    this.blind = [...this.blind, { from: Date.now(), to: null }];
    this.host.killHq();
    this.fire({ kind: 'hq', alive: false });
    this.emit();
  };

  restoreHq = () => {
    if (this.host.hq().alive) return;
    const to = Date.now();
    this.blind = this.blind.map((b) => (b.to === null ? { ...b, to } : b));
    this.host.restoreHq();
    this.fire({ kind: 'hq', alive: true });
    this.emit();
  };

  cut = (a: ActorId, b: ActorId) => this.setBlocked([[a, b]], true);

  heal = (a: ActorId, b: ActorId) => this.setBlocked([[a, b]], false);

  healAll = () => {
    this.faults = new Map();
    for (const s of this.seats) s.handle.send({ kind: 'setFaults', plan: { blocked: [] } });
    this.restoreHq();
    this.emit();
  };

  addTask = (by: ActorId, spec: TaskSpec, ref: string) => {
    const seat = this.seats.find((s) => s.id === by);
    if (!seat) return;
    seat.handle.send({ kind: 'addTask', spec, source: { kind: 'human', ref } });
    this.fire({ kind: 'request', actor: by, taskId: spec.id, point: spec.location, title: spec.title });
  };

  dropRequest = (point: Point, kind: RequestKind): TaskId | null => {
    const capsule = this.capsule;
    if (this.phase !== 'live' || !capsule) return null;
    const seat = this.nearest(point);
    if (!seat) return null;
    const place = [...capsule.tasks].sort((a, b) => away(a.location, point) - away(b.location, point))[0];
    const { objective, ...request } = REQUESTS[kind];
    const id = `drop-${kind}-${++this.drops}`;
    const spec: TaskSpec = {
      ...request,
      id,
      objective: capsule.objectives.some((o) => o.id === objective) ? objective : capsule.objectives[0]!.id,
      location: { x: Math.round(point.x), y: Math.round(point.y) },
      locationName: place ? `Near ${lower(place.locationName)}` : 'On site',
      dependsOn: [],
    };
    if (validateTaskSpec(spec).length) return null;
    this.addTask(seat.id, spec, id);
    return id;
  };

  carry = (from: ActorId, to: ActorId) => {
    const sender = this.seats.find((s) => s.id === from);
    const receiver = this.seats.find((s) => s.id === to);
    const running = this.carryState && this.carryState.phase !== 'done' && this.carryState.phase !== 'failed';
    if (this.phase !== 'live' || !sender || !receiver || from === to || running) return;
    void this.runCarry(this.run, sender, receiver).catch(() => this.setCarry({ phase: 'failed' }));
  };

  carried = () => {
    this.arrived?.();
  };

  openWhy = (id: ActorId) => {
    this.why = id;
    this.emit();
  };

  closeWhy = () => {
    this.why = null;
    this.emit();
  };

  private setBlocked(pairs: readonly (readonly [ActorId, ActorId])[], on: boolean) {
    const touched = new Set<ActorId>();
    for (const [a, b] of pairs) {
      if (a === b) continue;
      for (const [x, y] of [[a, b], [b, a]] as const) {
        const set = this.faults.get(x) ?? new Set<ActorId>();
        if (on) set.add(y);
        else set.delete(y);
        this.faults.set(x, set);
        touched.add(x);
      }
    }
    for (const s of this.seats) {
      if (touched.has(s.id)) s.handle.send({ kind: 'setFaults', plan: { blocked: [...(this.faults.get(s.id) ?? [])] } });
    }
    this.emit();
  }

  /** Signed packet, QR frames, the walk, then decoding at the receiver. True once it verified and applied. */
  private async runCarry(run: number, sender: Seat, receiver: Seat): Promise<boolean> {
    this.ferryId = `ferry-${run}-${Date.now().toString(36)}`;
    this.frames = new Map();
    this.frameTotal = 0;
    this.carryState = { phase: 'preparing', sender: sender.id, receiver: receiver.id, have: 0, total: 0, newEvents: 0, walkMs: WALK_MS };
    this.emit();
    const arrived = new Promise<void>((resolve) => (this.arrived = resolve));
    const ended = new Promise<boolean>((resolve) => (this.ferryEnded = resolve));
    sender.handle.send({ kind: 'ferryStart', ferryId: this.ferryId, remote: this.contact.get(receiver.id)?.get(sender.id), frameMs: SENDER_FRAME_MS });
    await this.until(run, () => this.frames.size > 0, WAIT_SIGNAL_MS, 'The sender did not produce a code.');
    await sleep(SHOW_CODE_MS);
    if (run !== this.run) return false;
    this.setCarry({ phase: 'walking' });
    await Promise.race([arrived, sleep(WALK_LIMIT_MS)]);
    if (run !== this.run) return false;
    await this.until(run, () => this.frameTotal > 0 && this.frames.size >= this.frameTotal, WAIT_ACTION_MS, 'The sender stopped showing frames.');
    this.setCarry({ phase: 'scanning' });
    await this.scan(run, receiver);
    const ok = await Promise.race([ended, sleep(3000).then(() => false)]);
    if (run !== this.run) return false;
    if (!ok) {
      this.setCarry({ phase: 'failed' });
      this.say('The update did not verify. Nothing was applied.');
      return false;
    }
    this.setCarry({ phase: 'done' });
    const events = this.carryState?.newEvents ?? 0;
    this.mark(receiver.id, { tone: 'carry', text: `${events} signed ${events === 1 ? 'event' : 'events'} verified` });
    this.fire({ kind: 'carried', to: receiver.id, newEvents: events });
    return true;
  }

  /** On real phones a person holds one screen up to the other's camera. Only the receiver's report ends this. */
  private async humanCarry(run: number, sender: Seat, receiver: Seat) {
    const target = sender.view?.summary.heads[sender.id]?.seq ?? 0;
    this.say(`Open Carry update on ${sender.name}, then Scan update on ${receiver.name}.`);
    await this.until(run, () => (receiver.view?.summary.heads[sender.id]?.seq ?? 0) >= target, WAIT_HUMAN_MS, 'Still waiting for the scan.');
  }

  /** Replays the sender's frames at the receiver's scanner until its assembler is complete. */
  private async scan(run: number, receiver: Seat) {
    for (let round = 0; round < FRAME_ROUNDS; round++) {
      for (let i = 0; i < this.frameTotal; i++) {
        const c = this.carryState;
        if (run !== this.run || !c || c.phase !== 'scanning') return;
        if (c.total > 0 && c.have >= c.total) return;
        const pixels = this.frames.get(i);
        if (!pixels) continue;
        this.show(i, this.frameTotal, pixels);
        const data = new Uint8ClampedArray(pixels.data);
        const started = performance.now();
        receiver.handle.send({ kind: 'ferryFrame', ferryId: this.ferryId, pixels: { width: pixels.width, height: pixels.height, data } }, [data.buffer]);
        await this.settle(run, () => (this.carryState?.have ?? 0) > c.have, FRAME_WAIT_MS);
        const left = FRAME_MIN_MS - (performance.now() - started);
        if (left > 0) await sleep(left);
      }
    }
  }

  private raise(beat: DemoBeat) {
    if (!beat.spec) return;
    const seat = this.seatOf(beat.team);
    seat.handle.send({ kind: 'addTask', spec: beat.spec, source: { kind: 'human', ref: beat.id } });
    this.mark(seat.id, { tone: 'request', text: 'New request' });
    this.fire({ kind: 'request', actor: seat.id, taskId: beat.spec.id, point: beat.spec.location, title: beat.spec.title });
  }

  private mark(id: ActorId, mark: StageMark) {
    this.marks = { ...this.marks, [id]: mark };
    this.emit();
  }

  private clearRequest(team: TeamId) {
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

  private fail(message: string) {
    this.phase = 'failed';
    this.failure = message;
    this.emit();
  }

  private show(index: number, total: number, pixels: FramePixels) {
    this.frameSink?.(pixels);
    this.fire({ kind: 'frame', index, total, pixels });
  }

  private fire(e: StageEvent) {
    this.watchers.forEach((fn) => fn(e));
  }

  private setCarry(patch: Partial<StageCarry>) {
    if (this.carryState) this.carryState = { ...this.carryState, ...patch };
    this.emit();
    this.wake();
  }

  // ---------- Reading what devices reported ----------

  private actionMs(): number {
    return this.host.humans ? WAIT_HUMAN_MS : WAIT_ACTION_MS;
  }

  private seatOf(team: TeamId): Seat {
    return this.seats.find((s) => s.team === team)!;
  }

  private nameOf(actor?: ActorId): string {
    return this.seats.find((s) => s.id === actor)?.name ?? 'A team';
  }

  private nearest(point: Point): Seat | null {
    return [...this.seats].sort((a, b) => away(this.goalOf(a), point) - away(this.goalOf(b), point))[0] ?? null;
  }

  private taskOf(seat: Seat): CompactTask | null {
    return seat.view?.tasks.find((t) => t.id === seat.view?.nextAction) ?? null;
  }

  private goalOf(seat: Seat): Point {
    return this.taskOf(seat)?.location ?? seat.home;
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

  private refusalOf(id: TaskId): { seat: Seat; decision: DecisionRecord } | null {
    for (const seat of this.seats) {
      const decision = seat.view?.refusals.find((d) => d.taskId === id);
      if (decision) return { seat, decision };
    }
    return null;
  }

  /** A task can be finished on both sides of a split. Each side must report it before the carry joins them. */
  private doneInEveryGroup(id: TaskId): boolean {
    return this.groups().every((g) =>
      g.some((a) => {
        const t = this.seats.find((s) => s.id === a)?.view?.tasks.find((x) => x.id === id);
        return t && isTaskDone({ status: t.status, evidence: t.status === 'completed' ? '' : undefined });
      }),
    );
  }

  private converged(): boolean {
    const heads = this.seats.map((s) => JSON.stringify(Object.entries(s.view?.summary.heads ?? {}).map(([a, h]) => [a, h.seq]).sort()));
    return heads.every((h) => h === heads[0]);
  }

  private hqCaughtUp(): boolean {
    return this.hqEntries.size >= Math.max(...this.seats.map((s) => s.view?.eventCount ?? 0)) - 1;
  }

  private pairs(): Pair[] {
    const book: LinkBook = {};
    for (const s of this.seats) book[s.id] = s.links;
    return readPairs(this.seats.map((s) => s.id), book).map((p) => {
      const key = pairKey(p.a, p.b);
      if (p.state === 'open') this.everOpen.add(key);
      return p.state === 'cut' && !this.everOpen.has(key) ? { ...p, state: 'forming' } : p;
    });
  }

  private groups(): ActorId[][] {
    return groupsOf(this.seats.map((s) => s.id), this.pairs());
  }

  private onReport(seat: Seat, report: DeviceReport) {
    switch (report.kind) {
      case 'booted': {
        const blocked = this.faults.get(seat.id);
        if (blocked?.size) seat.handle.send({ kind: 'setFaults', plan: { blocked: [...blocked] } });
        break;
      }
      case 'view':
        this.onView(seat, report.view);
        break;
      case 'links':
        seat.links = report.links;
        seat.signalUp = report.signalUp;
        break;
      case 'ferryFrame':
        this.frameTotal = report.total;
        this.frames.set(report.index, report.pixels);
        if (this.carryState && this.carryState.total !== report.total) this.carryState = { ...this.carryState, total: report.total };
        this.show(report.index, report.total, report.pixels);
        break;
      case 'ferrySent':
        this.frameTotal = report.frames;
        break;
      case 'ferryProgress':
        if (this.carryState) this.carryState = { ...this.carryState, have: report.have, total: report.total };
        break;
      case 'ferryResult':
        if (this.carryState) this.carryState = { ...this.carryState, newEvents: report.newEvents, have: this.carryState.total };
        this.ferryEnded?.(true);
        break;
      case 'ferryRejected':
        this.ferryEnded?.(false);
        break;
      case 'refusal':
        this.note(seat, report.decision);
        this.fire({ kind: 'refused', actor: seat.id, taskId: report.decision.taskId, reason: report.decision.reason, protective: PROTECTIVE.has(report.decision.refusal as RefusalCode) });
        break;
      case 'failed':
        this.fail(report.message);
        break;
      default:
        return;
    }
    this.watchLinks();
    this.emit();
    this.wake();
  }

  private onView(seat: Seat, view: CompactView) {
    this.flow(seat, view);
    seat.view = view;
    seat.links = view.links;
    seat.signalUp = view.signalUp;
    if (seat.signalUp && !this.host.hq().state && this.host.hq().alive) {
      this.hqLastAt = view.at;
      this.hqDone = this.snapshot().done;
    }
    if (view.lastDecision) this.note(seat, view.lastDecision);
    for (const d of view.refusals) this.note(seat, d);
    for (const l of view.links) {
      if (l.state !== 'open') continue;
      const known = this.contact.get(seat.id) ?? new Map<ActorId, SyncSummary>();
      known.set(l.peer, view.summary);
      this.contact.set(seat.id, known);
    }
    for (const t of view.tasks) this.watchTask(t);
    for (const k of view.tokens) this.watchToken(k);
  }

  /** A pulse marks a real delivery: this device's log grew and that peer sent it something. */
  private flow(seat: Seat, view: CompactView) {
    const grew = view.eventCount > seat.eventCount;
    seat.eventCount = view.eventCount;
    for (const l of view.links) {
      const before = seat.received.get(l.peer) ?? 0;
      seat.received.set(l.peer, l.received);
      if (grew && l.state === 'open' && l.received > before) this.fire({ kind: 'sync', from: l.peer, to: seat.id });
    }
  }

  private watchTask(t: CompactTask) {
    const was = this.taskStatus.get(t.id);
    if (was && RANK[t.status] <= RANK[was]) return;
    this.taskStatus.set(t.id, t.status);
    if (!t.owner) return;
    if (t.status === 'claimed') this.fire({ kind: 'claimed', actor: t.owner, taskId: t.id });
    if (t.status === 'completed') this.fire({ kind: 'done', actor: t.owner, taskId: t.id });
  }

  private watchToken(k: TokenRecord) {
    if (!k.committedTo || this.allocated.has(k.committedTo) || !k.holder) return;
    this.allocated.add(k.committedTo);
    this.fire({ kind: 'allocated', actor: k.holder, taskId: k.committedTo, resource: k.resource });
  }

  private watchLinks() {
    for (const p of this.pairs()) {
      const key = pairKey(p.a, p.b);
      const was = this.linkStates.get(key);
      if (was === p.state) continue;
      this.linkStates.set(key, p.state);
      if (was === 'open' && p.state === 'cut' && this.isBlocked(p.a, p.b)) this.linksCut++;
      if (was !== undefined) this.fire({ kind: 'link', a: p.a, b: p.b, state: p.state });
    }
  }

  private isBlocked(a: ActorId, b: ActorId): boolean {
    return (this.faults.get(a)?.has(b) ?? false) || (this.faults.get(b)?.has(a) ?? false);
  }

  private note(seat: Seat, d: DecisionRecord) {
    (this.decisions[seat.id] ??= new Map()).set(d.id, d);
  }

  private onHq() {
    const hq = this.host.hq();
    if (hq.alive && hq.state) {
      this.hqLastAt = hq.lastConfirmedAt;
      this.hqTeams = Object.values(hq.state.actors).filter((a) => a.connected).length;
      const lastBlind = this.blind.at(-1)?.to ?? null;
      const authors = new Set<ActorId>();
      for (const e of hq.state.recent) {
        if (this.hqEntries.has(e.id)) continue;
        this.hqEntries.set(e.id, this.entry(e, lastBlind !== null && e.wall < lastBlind));
        authors.add(e.actor);
      }
      for (const actor of authors) this.fire({ kind: 'report', actor });
    }
    this.emit();
    this.wake();
  }

  private teardown() {
    for (const s of this.seats) {
      s.off();
      s.handle.dispose();
    }
    this.seats = [];
    this.host.end();
    this.frames = new Map();
    this.arrived = null;
    this.ferryEnded = null;
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
      const timer = timeoutMs === Infinity ? undefined : setTimeout(() => {
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

  // ---------- Snapshot ----------

  private build(): StageState {
    const pairs = this.pairs();
    const step = STEPS[this.stepIndex]!;
    const alive = this.host.hq().alive;
    const best = new Map<TaskId, CompactTask & { knownBy: ActorId[] }>();
    const tokens = new Map<string, TokenRecord>();
    const refused = new Set<TaskId>();
    let violations = 0;
    for (const s of this.seats) {
      for (const t of s.view?.tasks ?? []) {
        const cur = best.get(t.id);
        const knownBy = [...(cur?.knownBy ?? []), s.id];
        best.set(t.id, !cur || RANK[t.status] > RANK[cur.status] ? { ...t, knownBy } : { ...cur, knownBy });
      }
      for (const k of s.view?.tokens ?? []) if (!tokens.has(k.id) || k.committedTo) tokens.set(k.id, k);
      for (const d of s.view?.refusals ?? []) if (d.refusal && PROTECTIVE.has(d.refusal)) refused.add(d.taskId);
      violations = Math.max(violations, s.view?.conflicts.filter((c) => c.severity === 'violation').length ?? 0);
    }
    const tasks = [...best.values()];
    const done = tasks.filter((t) => t.status === 'completed').length;
    return {
      run: this.run,
      phase: this.phase,
      ready: this.phase === 'live',
      error: this.failure,
      capsule: this.capsule,
      seats: this.seats.map((s) => this.device(s)),
      pairs: pairs.map((p) => this.link(p, alive)),
      groups: groupsOf(this.seats.map((s) => s.id), pairs),
      homes: Object.fromEntries((this.capsule?.teams ?? []).map((t) => [t.id, t.home])),
      hq: this.hqView(alive),
      story: { step, label: labelFor(step, this.cast?.resourceName ?? ''), busy: this.busy, line: this.line, finished: this.finished },
      score: { tasksFinished: done, unsafeRefused: refused.size, linksCut: this.linksCut, violations },
      done,
      refused: refused.size,
      carry: this.carryState,
      truth: { tasks, tokens: [...tokens.values()] },
      marks: this.marks,
      why: this.why,
    };
  }

  private device(s: Seat): StageDevice {
    const decisions = this.decisions[s.id];
    return {
      id: s.id,
      team: s.team,
      name: s.name,
      src: s.src,
      home: s.home,
      view: s.view,
      links: s.links,
      signalUp: s.signalUp,
      task: this.taskOf(s),
      goal: this.goalOf(s),
      decisions: decisions ? [...decisions.values()].reverse() : [],
    };
  }

  private link(p: Pair, hqAlive: boolean): StageLink {
    const ab = this.seats.find((s) => s.id === p.a)?.links.find((l) => l.peer === p.b);
    const ba = this.seats.find((s) => s.id === p.b)?.links.find((l) => l.peer === p.a);
    const blocked = this.isBlocked(p.a, p.b);
    return {
      a: p.a,
      b: p.b,
      state: p.state,
      blocked,
      waitingForHq: !blocked && p.state !== 'open' && !hqAlive,
      aState: ab?.state,
      bState: ba?.state,
      rttMs: ab?.rttMs ?? ba?.rttMs,
      sent: (ab?.sent ?? 0) + (ba?.sent ?? 0),
      received: (ab?.received ?? 0) + (ba?.received ?? 0),
      lastHeardAt: Math.max(ab?.lastHeardAt ?? 0, ba?.lastHeardAt ?? 0) || undefined,
    };
  }

  private hqView(alive: boolean): StageHq {
    const entries = [...this.hqEntries.values()];
    const observed = this.host.hq().state !== null;
    return {
      alive,
      state: alive ? 'live' : 'blind',
      teams: observed ? this.hqTeams : this.seats.filter((s) => s.signalUp).length,
      done: observed || entries.length ? new Set(entries.flatMap((e) => (e.finished ? [e.finished] : []))).size : this.hqDone,
      lastConfirmedAt: this.hqLastAt,
      blind: this.blind,
      firstAt: entries.length ? entries.reduce((m, e) => Math.min(m, e.wall), Infinity) : null,
      ticks: entries.map((e) => ({ id: e.id, at: e.wall, late: e.late })),
    };
  }
}
