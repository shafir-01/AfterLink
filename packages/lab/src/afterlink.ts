import { createActor, createMemoryStorage, type ActorNode, type ActorStorage } from '@afterlink/actor';
import { conservation } from '@afterlink/authority';
import { MemoryNetwork, type Clock, type LinkConnector, type NegotiatedLink } from '@afterlink/mesh';
import { provision, reduce } from '@afterlink/mission';
import { canonicalize, createEvent, eventId, generateKeys, signBytes, fromB64u } from '@afterlink/protocol';
import type {
  ActorId,
  AnyEvent,
  EventId,
  FerryPacket,
  MissionCapsule,
  MissionState,
  ProvisionBundle,
  SignalClient,
  SyncSummary,
  TaskId,
  TaskRecord,
  TokenId,
  WireMessage,
} from '@afterlink/protocol';
import { sizeOf } from './net.ts';
import { TIMING, type Attack, type FaultStep, type Incident, type Scenario, type World } from './scenario.ts';
import { EPOCH } from './sim.ts';
import { emptyReport, type AttackResult, type RunContext, type SystemReport, type SystemUnderTest } from './system.ts';
import { FieldWorker } from './worker.ts';

/** Pause before a volunteer tries again after the device refused a job. */
const RETRY_REFUSED_MS = 30_000;

export function labCapsule(world: World, issuer: string, issuedAt: number): MissionCapsule {
  return {
    v: 1,
    id: 'lab-mission',
    version: 1,
    name: 'Lab mission',
    objective: 'Keep people safe through the event.',
    objectives: [{ id: 'keep-people-safe', title: 'Keep people safe', rank: 1 }],
    teams: world.teams,
    resources: world.resources,
    tasks: [],
    contingencies: world.contingencies,
    fallback: world.fallback,
    issuer,
    issuedAt,
  };
}

interface Seat {
  index: number;
  id: ActorId;
  bundle: ProvisionBundle;
  storage: ActorStorage;
  node: ActorNode;
  worker: FieldWorker;
  signal: SignalClient | null;
  up: boolean;
  deferred: (() => void)[];
  /** Tasks whose accept was refused, with the time to try again. */
  refusedUntil: Map<TaskId, number>;
  finished: Set<TaskId>;
}

/**
 * The real product: ActorNode, Mesh, anti-entropy, planner, ledger and signed events over MemoryNetwork.
 * The only stand-in is the volunteer, who taps accept and done. Faults act on real links and signalling.
 */
export class AfterLinkSystem implements SystemUnderTest {
  readonly id = 'afterlink' as const;
  private scenario: Scenario;
  private clock: Clock;
  private network: MemoryNetwork;
  private seats: Seat[] = [];
  private roster: ProvisionBundle['roster'] = [];
  private sent = 0;
  private hubReach = new Set<number>([0, 1, 2, 3]);
  private oneWayCut = new Set<string>();
  private blocked: Set<number>[] = [new Set(), new Set(), new Set(), new Set()];
  /** Last summary each device shared before contact was lost: all a courier can know of it. */
  private lastShared: (SyncSummary | undefined)[] = [];
  private inbound = new Map<string, (msg: WireMessage) => void>();
  private attackChecks: (() => AttackResult)[] = [];
  private ferry: { first: number; second: number } | null = null;
  private restarted: { index: number; before: EventId[] }[] = [];
  private restartLost = 0;

  constructor(private ctx: RunContext) {
    const { sim, scenario, rng } = ctx;
    this.scenario = scenario;
    this.clock = {
      now: () => EPOCH + sim.now,
      setTimeout: (fn, ms) => sim.after(ms, fn),
      clearTimeout: (h) => sim.cancel(h as number | undefined),
    };
    this.network = new MemoryNetwork({
      seed: rng.fork('network').seed,
      clock: this.clock,
      latencyMs: TIMING.latencyMs,
      signalLatencyMs: TIMING.latencyMs,
    });
  }

  async start(): Promise<void> {
    const { world } = this.scenario;
    const issuer = generateKeys();
    const { bundles } = provision(labCapsule(world, issuer.publicKey, EPOCH), issuer, 'lab');
    this.roster = (bundles[world.teams[0]!.id] as ProvisionBundle).roster;
    const { sim } = this.ctx;

    this.seats = world.teams.map((team, index) => {
      const bundle = bundles[team.id] as ProvisionBundle;
      const seat = { index, id: bundle.actor.publicKey, bundle, storage: createMemoryStorage(), up: true, deferred: [], refusedUntil: new Map(), finished: new Set(), signal: null } as unknown as Seat;
      seat.worker = new FieldWorker(sim, (task) => this.onStart(seat, task), (task) => this.onDone(seat, task));
      return seat;
    });
    for (const seat of this.seats) {
      seat.signal = this.signalClient(seat);
      seat.node = this.makeNode(seat);
    }
    for (const seat of this.seats) await seat.node.start();
    for (const seat of this.seats) {
      sim.every(TIMING.tickMs, () => this.syncWorker(seat), this.ctx.rng.fork(`phase${seat.index}`).int(1, TIMING.tickMs));
    }
  }

  private makeNode(seat: Seat): ActorNode {
    return createActor({
      bundle: seat.bundle,
      connector: this.meteredConnector(seat),
      signal: seat.signal ?? undefined,
      storage: seat.storage,
      tickMs: TIMING.tickMs,
    });
  }

  private signalClient(seat: Seat): SignalClient {
    const client = this.network.signal(seat.id);
    const send = client.send.bind(client);
    client.send = (msg) => {
      this.sent += sizeOf(msg);
      send(msg);
    };
    return client;
  }

  /** Same real link, with bytes counted, one-way cuts honoured and a tap the attacks can write to. */
  private meteredConnector(seat: Seat): LinkConnector {
    const base = this.network.connector(seat.id);
    return {
      kind: base.kind,
      clock: base.clock,
      connect: (req) => {
        const link = base.connect(req);
        const peer = this.seats.findIndex((s) => s.id === req.peer);
        const key = `${peer}>${seat.index}`;
        const metered: NegotiatedLink = {
          peer: link.peer,
          kind: link.kind,
          get state() {
            return link.state;
          },
          send: (msg) => {
            this.sent += sizeOf(msg);
            if (!this.oneWayCut.has(`${seat.index}>${peer}`)) link.send(msg);
          },
          onMessage: (fn) => {
            this.inbound.set(key, fn);
            link.onMessage(fn);
          },
          onState: (fn) => link.onState(fn),
          close: (reason) => link.close(reason),
          signal: (data) => link.signal(data),
        };
        return metered;
      },
    };
  }

  inject(i: Incident): void {
    this.whenUp(i.reporter, (seat) => seat.node.submitTask(i.spec, { kind: 'human' }));
  }

  private whenUp(index: number, fn: (seat: Seat) => void): void {
    const seat = this.seats[index] as Seat;
    if (seat.up) fn(seat);
    else seat.deferred.push(() => fn(seat));
  }

  async apply(step: FaultStep): Promise<void> {
    switch (step.kind) {
      case 'hub':
        if (step.up) this.network.restoreHub();
        else this.network.killHub();
        break;
      case 'links':
        this.applyLinks(step.cut, step.hubReach);
        break;
      case 'quality': {
        const q = step.quality;
        this.network.setLoss(q.loss);
        this.network.setDuplicate(q.duplicate);
        this.network.setDelay(q.delayMs);
        this.network.setReorder(q.reorder);
        break;
      }
      case 'restart':
        this.restart(step.actor, step.downForMs);
        break;
      case 'observe':
        this.whenUp(step.actor, (seat) => seat.node.observe(step.key, step.value, { validForMs: step.validForMs }));
        break;
      case 'ferry':
        this.carry(step.from, step.to, step.copies);
        break;
      case 'transfer':
        this.whenUp(step.from, (seat) => seat.node.offerTokens([step.token], (this.seats[step.to] as Seat).id));
        break;
      case 'attack':
        this.attack(step.attack, step.target);
        break;
    }
  }

  private applyLinks(cut: [number, number][], hubReach: number[]): void {
    for (const seat of this.seats) if (seat.up) this.lastShared[seat.index] = seat.node.view().summary;
    const directed = new Set(cut.map(([a, b]) => `${a}>${b}`));
    this.oneWayCut = new Set([...directed].filter((k) => {
      const [a, b] = k.split('>');
      return !directed.has(`${b}>${a}`);
    }));
    this.blocked = this.seats.map((s) => new Set(this.seats.filter((o) => directed.has(`${s.index}>${o.index}`) && directed.has(`${o.index}>${s.index}`)).map((o) => o.index)));
    this.hubReach = new Set(hubReach);
    for (const seat of this.seats) {
      if (seat.up) this.placeFaults(seat);
      this.placeSignal(seat);
    }
  }

  private placeFaults(seat: Seat): void {
    seat.node.setFaults({ blocked: [...(this.blocked[seat.index] as Set<number>)].map((i) => (this.seats[i] as Seat).id) });
  }

  private placeSignal(seat: Seat): void {
    const want = this.hubReach.has(seat.index);
    if (want && !seat.signal) {
      seat.signal = this.signalClient(seat);
      if (seat.up) seat.node.setSignal(seat.signal);
    } else if (!want && seat.signal) {
      if (seat.up) seat.node.setSignal(null);
      seat.signal.close();
      seat.signal = null;
    }
  }

  private restart(index: number, downForMs: number): void {
    const seat = this.seats[index] as Seat;
    if (!seat.up) return;
    const before = seat.node.events().map((e) => e.id);
    this.restarted.push({ index, before });
    seat.up = false;
    seat.node.stop();
    seat.worker.suspend(downForMs);
    this.ctx.sim.after(downForMs, async () => {
      seat.node = this.makeNode(seat);
      await seat.node.start();
      seat.up = true;
      this.placeFaults(seat);
      const held = new Set(seat.node.events().map((e) => e.id));
      this.restartLost += before.filter((id) => !held.has(id)).length;
      for (const fn of seat.deferred.splice(0)) fn();
    });
  }

  private carry(fromIndex: number, toIndex: number, copies: number): void {
    const from = this.seats[fromIndex] as Seat;
    const to = this.seats[toIndex] as Seat;
    if (!from.up || !to.up) return;
    const packet = from.node.buildFerry(this.lastShared[toIndex]);
    const first = to.node.ingestFerry(packet);
    let second = 0;
    for (let i = 1; i < copies; i++) second += to.node.ingestFerry(packet).newEvents;
    this.ferry = { first: first.newEvents, second };
  }

  private syncWorker(seat: Seat): void {
    if (!seat.up) return;
    const view = seat.node.view();
    const now = this.ctx.sim.now;
    for (const t of view.pendingTransfers) seat.node.answerTransfer(t.transfer, true);
    const current = seat.worker.currentTask;
    if (current) {
      const record = view.state.tasks[current];
      const mine = record && (record.owner === seat.id || record.coveredBy?.includes(seat.id));
      if (!mine || isDone(record)) {
        seat.worker.drop(current);
        this.ctx.trace({ t: now, kind: 'abandon', actor: seat.index, task: current });
      }
    }
    for (const t of view.myTasks) {
      if (isDone(t)) continue;
      const id = t.spec.id;
      if ((seat.refusedUntil.get(id) ?? 0) > now) continue;
      seat.worker.give(id, t.spec.priority, this.ctx.durationOf(id));
    }
  }

  private onStart(seat: Seat, task: TaskId): void {
    if (seat.up && seat.node.acceptTask(task, 'auto')) {
      this.ctx.trace({ t: this.ctx.sim.now, kind: 'start', actor: seat.index, task });
      return;
    }
    seat.refusedUntil.set(task, this.ctx.sim.now + RETRY_REFUSED_MS);
    seat.worker.drop(task);
  }

  private onDone(seat: Seat, task: TaskId): void {
    this.ctx.trace({ t: this.ctx.sim.now, kind: 'complete', actor: seat.index, task });
    seat.finished.add(task);
    this.whenUp(seat.index, (s) => s.node.completeTask(task, 'done', 'auto'));
  }

  bytes(): number {
    return this.sent;
  }

  isConverged(): boolean {
    if (this.seats.some((s) => !s.up)) return false;
    const [first, ...rest] = this.seats.map((s) => canonicalize(s.node.view().summary.heads));
    return rest.every((h) => h === first);
  }

  /** The system's record after merge, rebuilt from the union of every replica's events. */
  private mergedEvents(): AnyEvent[] {
    const byId = new Map<EventId, AnyEvent>();
    for (const seat of this.seats) for (const e of seat.node.events()) byId.set(e.id, e);
    return [...byId.values()];
  }

  async report(): Promise<SystemReport> {
    const report = emptyReport();
    const union = this.mergedEvents();
    const merged = reduce(union, this.roster);
    this.traceFromLog(union);

    const states = this.seats.map((s) => s.node.view().state);
    const shape = (st: MissionState) => canonicalize(Object.values(st.tasks).map((t) => [t.spec.id, t.status, t.owner ?? null]).sort());
    const firstShape = shape(states[0] as MissionState);
    report.converged = this.isConverged() && states.every((st) => shape(st) === firstShape);

    report.conflictsSurfaced = merged.conflicts.length;
    report.conflictsUnresolved = merged.conflicts.filter((c) => !c.resolved).length;
    const finished = new Set(this.seats.flatMap((s) => [...s.finished]));
    report.lostCompletions = [...finished].filter((id) => !isDone(merged.tasks[id])).length;
    report.conservationBreaches = conservation(merged).filter((row) => !row.ok).length;
    report.attacks = this.attackChecks.map((check) => check());
    if (this.ferry) {
      report.ferryNewFirst = this.ferry.first;
      report.ferryNewSecond = this.ferry.second;
    }
    if (this.restarted.length) report.restartDefects = this.restartLost + this.ownForks(union);
    return report;
  }

  /** Two events from one device at one sequence number: a restart that reused its place in the chain. */
  private ownForks(union: AnyEvent[]): number {
    let forks = 0;
    for (const { index } of this.restarted) {
      const id = (this.seats[index] as Seat).id;
      const seqs = union.filter((e) => e.actor === id).map((e) => e.seq);
      forks += seqs.length - new Set(seqs).size;
    }
    return forks;
  }

  private traceFromLog(events: AnyEvent[]): void {
    const indexOf = new Map(this.seats.map((s) => [s.id, s.index]));
    for (const e of [...events].sort((a, b) => a.wall - b.wall)) {
      const actor = indexOf.get(e.actor);
      if (actor === undefined) continue;
      const t = e.wall - EPOCH;
      switch (e.type) {
        case 'task.claimed':
          this.ctx.trace({ t, kind: 'assign', actor, task: e.body.taskId, via: 'plan' });
          break;
        case 'task.covered':
          this.ctx.trace({ t, kind: 'assign', actor, task: e.body.taskId, via: 'cover' });
          break;
        case 'task.refused':
        case 'task.deferred':
          this.ctx.trace({ t, kind: 'refuse', actor, task: e.body.taskId, code: e.body.decision.refusal ?? 'DEFERRED' });
          break;
        case 'right.committed':
          for (const token of e.body.tokens) this.ctx.trace({ t, kind: 'commit', actor, task: e.body.taskId, token });
          break;
      }
    }
  }

  stop(): void {
    for (const seat of this.seats) if (seat.up) seat.node.stop();
  }

  // ---------- Attacks, all through the real receive paths ----------

  private wire(target: number, msg: WireMessage): boolean {
    const peers = this.seats.map((s) => s.index).filter((i) => i !== target);
    for (const peer of peers) {
      const receive = this.inbound.get(`${peer}>${target}`);
      if (receive && !(this.blocked[target] as Set<number>).has(peer)) {
        receive(msg);
        return true;
      }
    }
    return false;
  }

  private attack(attack: Attack, target: number): void {
    const victim = this.seats[target] as Seat;
    if (!victim.up) return;
    const before = victim.node.events().length;
    const stateBefore = fingerprint(victim.node.view().state);
    const openTask = Object.values(victim.node.view().state.tasks).find((t) => !isDone(t))?.spec.id ?? 'no-task';
    const peer = this.seats[(target + 1) % this.seats.length] as Seat;
    const head = victim.node.events().filter((e) => e.actor === peer.id).at(-1);
    const draft = (keys: { publicKey: string; secretKey: string }) =>
      createEvent({
        keys,
        mission: 'lab-mission',
        seq: (head?.seq ?? 0) + 1,
        prev: head?.id ?? null,
        parents: [],
        lamport: (head?.lamport ?? 0) + 1,
        wall: this.clock.now(),
        type: 'task.completed',
        body: { taskId: openTask, evidence: 'forged', via: 'auto' },
      }) as AnyEvent;
    const outcomeNow = (id: EventId | null, name: string): AttackResult => {
      const held = id ? victim.node.events().some((e) => e.id === id) : victim.node.events().length > before;
      if (!held) return { attack: name, outcome: 'rejected' };
      return { attack: name, outcome: fingerprint(victim.node.view().state) === stateBefore ? 'no-effect' : 'accepted' };
    };
    const outsider = generateKeys();

    switch (attack) {
      case 'forged-signature': {
        const e = draft(outsider);
        const { id: _id, sig: _sig, ...unsigned } = { ...e, actor: peer.id };
        const id = eventId(unsigned);
        const forged = { ...unsigned, id, sig: signBytes(outsider.secretKey, fromB64u(id)) } as AnyEvent;
        this.wire(target, { t: 'events', events: [forged], final: true });
        const result = outcomeNow(forged.id, attack);
        this.attackChecks.push(() => result);
        break;
      }
      case 'tampered-body': {
        const real = victim.node.events().find((e) => e.type === 'task.created' && e.actor !== victim.id);
        if (!real) break;
        const tampered = { ...real, body: { ...real.body, source: { kind: 'human', ref: 'tampered' } } } as AnyEvent;
        this.wire(target, { t: 'events', events: [tampered], final: true });
        const changed = fingerprint(victim.node.view().state) !== stateBefore;
        this.attackChecks.push(() => ({ attack, outcome: changed ? 'accepted' : 'rejected' }));
        break;
      }
      case 'outsider-key': {
        const e = draft(outsider);
        this.wire(target, { t: 'events', events: [e], final: true });
        const result = outcomeNow(e.id, attack);
        this.attackChecks.push(() => result);
        break;
      }
      case 'replayed-events': {
        const old = victim.node.events().slice(0, 40);
        this.wire(target, { t: 'events', events: old, final: true });
        const result = outcomeNow(null, attack);
        this.attackChecks.push(() => result);
        break;
      }
      case 'forged-packet': {
        const packet = peer.node.buildFerry();
        const event = packet.events[0];
        const forged: FerryPacket = event
          ? { ...packet, events: [{ ...event, wall: event.wall + 1 } as AnyEvent, ...packet.events.slice(1)] }
          : { ...packet, createdAt: packet.createdAt + 1 };
        const verdict = victim.node.ingestFerry(forged);
        this.attackChecks.push(() => ({ attack, outcome: verdict.reason || verdict.newEvents === 0 ? 'rejected' : 'accepted' }));
        break;
      }
      case 'replayed-packet': {
        const packet = peer.node.buildFerry(victim.node.view().summary);
        victim.node.ingestFerry(packet);
        const size = victim.node.events().length;
        const verdict = victim.node.ingestFerry(packet);
        const grew = victim.node.events().length > size + 1;
        this.attackChecks.push(() => ({ attack, outcome: verdict.newEvents > 0 || grew ? 'accepted' : 'no-effect' }));
        break;
      }
      case 'insider-fork':
        this.insiderFork(attack, target);
        break;
    }
  }

  /** A compromised custodian signs two commitments of one free token and shows each branch to a different peer. */
  private insiderFork(attack: string, target: number): void {
    const liar = this.seats.find((s) => s.up && s.node.view().tokens.length > 0 && s.index !== target);
    if (!liar) return;
    const token: TokenId = (liar.node.view().tokens[0] as { id: TokenId }).id;
    const events = liar.node.events();
    const own = events.filter((e) => e.actor === liar.id);
    const head = own.at(-1) as AnyEvent;
    const branch = (taskId: TaskId) =>
      createEvent({
        keys: liar.bundle.actor,
        mission: 'lab-mission',
        seq: head.seq + 1,
        prev: head.id,
        parents: [],
        lamport: head.lamport + 1,
        wall: this.clock.now(),
        type: 'right.committed',
        body: { tokens: [token], taskId },
      }) as AnyEvent;
    const left = branch('insider-1');
    const right = branch('insider-2');
    this.wire(target, { t: 'events', events: [left], final: true });
    const other = this.seats.find((s) => s.up && s.index !== target && s.index !== liar.index);
    if (other) this.wire(other.index, { t: 'events', events: [right], final: true });
    this.attackChecks.push(() => {
      const merged = reduce(this.mergedEvents(), this.roster);
      const seen = merged.conflicts.some((c) => c.severity === 'violation' && (c.events.includes(left.id) || c.events.includes(right.id)));
      return { attack, outcome: seen ? 'detected' : 'accepted' };
    });
  }
}

function isDone(t: TaskRecord | undefined): boolean {
  return t?.status === 'completed';
}

function fingerprint(state: MissionState): string {
  return canonicalize([
    Object.values(state.tasks).map((t) => [t.spec.id, t.status, t.owner ?? null]).sort(),
    Object.values(state.tokens).map((t) => [t.id, t.state, t.holder, t.committedTo ?? null]).sort(),
  ]);
}
