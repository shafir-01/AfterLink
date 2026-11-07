import type { Capability, TaskId, TaskSpec, TokenId } from '@afterlink/protocol';
import { HUB, SimNet } from './net.ts';
import { TIMING, type FaultStep, type Incident, type Scenario } from './scenario.ts';
import { emptyReport, type AttackResult, type RunContext, type SystemReport, type SystemUnderTest } from './system.ts';
import { FieldWorker } from './worker.ts';

type Msg =
  | { t: 'report'; id: string; spec: TaskSpec }
  | { t: 'done'; id: string; task: TaskId }
  | { t: 'obs'; id: string; key: string; value: unknown; observedAt: number; validForMs: number }
  | { t: 'hb' }
  | { t: 'assign'; id: string; task: TaskId; spec: TaskSpec; tokens: TokenId[] }
  | { t: 'ack'; id: string };

interface HubTask {
  spec: TaskSpec;
  status: 'open' | 'assigned' | 'done';
  owner: number | null;
  tokens: TokenId[];
  assignedAt: number;
}

interface HubObservation {
  value: unknown;
  observedAt: number;
  validForMs: number;
}

/**
 * Baseline A at full strength. The hub has a durable ledger, assigns the moment work arrives, queues
 * work on each device so people keep going through an outage, reassigns silent owners under the same
 * policy AfterLink uses, and clients retry over loss. It stops assigning only when it cannot be reached.
 */
export class CentralSystem implements SystemUnderTest {
  readonly id = 'central' as const;
  private net: SimNet;
  private scenario: Scenario;
  private clients: Client[];

  private tasks = new Map<TaskId, HubTask>();
  private order: TaskId[] = [];
  private freeTokens = new Map<string, TokenId[]>();
  private observations = new Map<string, HubObservation>();
  private lastHeard = new Map<number, number>();
  private processed = new Set<string>();
  private refusedOnce = new Set<string>();
  private pendingAssign = new Map<string, { to: number; msg: Msg }>();
  private attacks: AttackResult[] = [];
  private hubDown = false;

  constructor(private ctx: RunContext) {
    this.scenario = ctx.scenario;
    this.net = new SimNet(ctx.sim, ctx.rng.fork('net'));
    this.clients = this.scenario.world.teams.map((t, i) => new Client(i, t.capabilities, ctx, this.net));
    for (const r of this.scenario.world.resources) this.freeTokens.set(r.id, r.tokens.map((t) => t.id));
  }

  async start(): Promise<void> {
    this.net.on(HUB, (from, msg) => this.onHub(from, msg as Msg));
    const { sim } = this.ctx;
    sim.every(TIMING.tickMs, () => this.hubTick());
    for (const c of this.clients) {
      c.start();
      this.lastHeard.set(c.index, 0);
    }
  }

  inject(i: Incident): void {
    this.clients[i.reporter]?.report(i.spec);
  }

  apply(step: FaultStep): void {
    switch (step.kind) {
      case 'hub':
        this.net.setHub(step.up);
        this.hubDown = !step.up;
        break;
      case 'links':
        this.net.setCut(step.cut, step.hubReach);
        break;
      case 'quality':
        this.net.setQuality(step.quality);
        break;
      case 'restart':
        this.clients[step.actor]?.restart(step.downForMs);
        break;
      case 'observe':
        this.clients[step.actor]?.observe(step.key, step.value, step.validForMs);
        break;
      case 'ferry':
        this.clients[step.from]?.carryTo(this.clients[step.to] as Client);
        break;
      case 'transfer':
        break;
      case 'attack':
        this.attacks.push({
          attack: step.attack,
          outcome: step.attack === 'forged-packet' || step.attack === 'replayed-packet' || step.attack === 'insider-fork' ? 'not-applicable' : 'rejected',
        });
        break;
    }
  }

  bytes(): number {
    return this.net.sentBytes;
  }

  isConverged(): boolean {
    if (this.hubDown) return false;
    if (this.clients.some((c) => c.outboxSize > 0)) return false;
    if (this.pendingAssign.size > 0) return false;
    return this.clients.every((c) => c.finished.every((id) => this.tasks.get(id)?.status === 'done'));
  }

  report(): SystemReport {
    const report = emptyReport();
    report.converged = this.isConverged();
    const finished = new Set(this.clients.flatMap((c) => c.finished));
    report.lostCompletions = [...finished].filter((id) => this.tasks.get(id)?.status !== 'done').length;
    report.attacks = this.attacks;
    const carried = this.clients.reduce<number | null>((sum, c) => (c.carried === null ? sum : (sum ?? 0) + c.carried), null);
    report.ferryNewFirst = carried;
    report.ferryNewSecond = carried === null ? null : 0;
    report.restartDefects = this.scenario.faults.some((f) => f.kind === 'restart') ? 0 : null;
    return report;
  }

  stop(): void {}

  private onHub(from: number, msg: Msg): void {
    this.lastHeard.set(from, this.ctx.sim.now);
    if (msg.t === 'hb') return;
    if (msg.t === 'ack') {
      this.pendingAssign.delete(msg.id);
      return;
    }
    if (msg.t === 'assign') return;
    this.net.send(HUB, from, { t: 'ack', id: msg.id } satisfies Msg);
    if (this.processed.has(msg.id)) return;
    this.processed.add(msg.id);
    if (msg.t === 'report') {
      if (this.tasks.has(msg.spec.id)) return;
      this.tasks.set(msg.spec.id, { spec: msg.spec, status: 'open', owner: null, tokens: [], assignedAt: 0 });
      this.order.push(msg.spec.id);
    } else if (msg.t === 'done') {
      const task = this.tasks.get(msg.task);
      if (task) task.status = 'done';
    } else {
      const current = this.observations.get(msg.key);
      if (!current || current.observedAt <= msg.observedAt) {
        this.observations.set(msg.key, { value: msg.value, observedAt: msg.observedAt, validForMs: msg.validForMs });
      }
    }
    this.dispatch();
  }

  private hubTick(): void {
    if (this.hubDown) return;
    for (const { to, msg } of this.pendingAssign.values()) this.net.send(HUB, to, msg);
    this.reassignSilentOwners();
    this.dispatch();
  }

  private reachableClient(i: number): boolean {
    return this.ctx.sim.now - (this.lastHeard.get(i) ?? 0) <= TIMING.tickMs * 3;
  }

  /** A task holding a token stays where it is: reassigning it could put one chair in two places. */
  private reassignSilentOwners(): void {
    const { coverAfterMs, coverMaxPriority } = this.scenario.world.fallback;
    const now = this.ctx.sim.now;
    for (const id of this.order) {
      const task = this.tasks.get(id) as HubTask;
      if (task.status !== 'assigned' || task.owner === null || task.tokens.length > 0) continue;
      if (task.spec.priority > coverMaxPriority) continue;
      const silentFor = now - (this.lastHeard.get(task.owner) ?? 0);
      if (silentFor < coverAfterMs || now - task.assignedAt < coverAfterMs) continue;
      if (!this.assignable(task.spec).length) continue;
      task.status = 'open';
      task.owner = null;
    }
  }

  private assignable(spec: TaskSpec): Client[] {
    return this.clients.filter((c) => this.reachableClient(c.index) && spec.requires.every((r: Capability) => c.capabilities.includes(r)));
  }

  private dispatch(): void {
    const now = this.ctx.sim.now;
    const open = this.order
      .map((id) => this.tasks.get(id) as HubTask)
      .filter((t) => t.status === 'open')
      .sort((a, b) => a.spec.priority - b.spec.priority);
    for (const task of open) {
      const { spec } = task;
      if (spec.dependsOn.some((d) => this.tasks.get(d)?.status !== 'done')) {
        this.refuse(spec, 'DEPENDENCY_UNMET');
        continue;
      }
      const blocked = (spec.reliesOn ?? []).some((key) => {
        const o = this.observations.get(key);
        if (o?.value === false) {
          this.refuse(spec, 'BLOCKED_BY_CONTINGENCY');
          return true;
        }
        const expired = !o || (o.validForMs > 0 && now - o.observedAt > o.validForMs);
        if (expired && !spec.reversible) {
          this.refuse(spec, 'STALE_KNOWLEDGE');
          return true;
        }
        return false;
      });
      if (blocked) continue;
      const candidates = this.assignable(spec).sort((a, b) => a.load - b.load || a.index - b.index);
      const worker = candidates[0];
      if (!worker) continue;
      const tokens: TokenId[] = [];
      let enough = true;
      for (const need of spec.needs) {
        const free = this.freeTokens.get(need.resource) ?? [];
        if (free.length < need.count) enough = false;
      }
      if (!enough) {
        this.refuse(spec, 'NO_RIGHT');
        continue;
      }
      for (const need of spec.needs) {
        const free = this.freeTokens.get(need.resource) as TokenId[];
        tokens.push(...free.splice(0, need.count));
      }
      task.status = 'assigned';
      task.owner = worker.index;
      task.tokens = tokens;
      task.assignedAt = now;
      this.ctx.trace({ t: now, kind: 'assign', actor: worker.index, task: spec.id, via: 'plan' });
      for (const token of tokens) this.ctx.trace({ t: now, kind: 'commit', actor: worker.index, task: spec.id, token });
      worker.load++;
      const id = `assign:${spec.id}:${worker.index}:${now}`;
      const msg: Msg = { t: 'assign', id, task: spec.id, spec, tokens };
      this.pendingAssign.set(id, { to: worker.index, msg });
      this.net.send(HUB, worker.index, msg);
    }
  }

  private refuse(spec: TaskSpec, code: string): void {
    const key = `${spec.id}:${code}`;
    if (this.refusedOnce.has(key)) return;
    this.refusedOnce.add(key);
    this.ctx.trace({ t: this.ctx.sim.now, kind: 'refuse', actor: -1, task: spec.id, code });
  }
}

class Client {
  load = 0;
  finished: TaskId[] = [];
  carried: number | null = null;
  private outbox = new Map<string, Msg>();
  private seen = new Set<string>();
  private worker: FieldWorker;
  private off = false;
  private nextId = 0;

  constructor(
    readonly index: number,
    readonly capabilities: Capability[],
    private ctx: RunContext,
    private net: SimNet,
  ) {
    this.worker = new FieldWorker(
      ctx.sim,
      (task) => ctx.trace({ t: ctx.sim.now, kind: 'start', actor: index, task }),
      (task) => {
        ctx.trace({ t: ctx.sim.now, kind: 'complete', actor: index, task });
        this.finished.push(task);
        this.load = Math.max(0, this.load - 1);
        this.enqueue({ t: 'done', id: this.mint(), task });
      },
    );
  }

  get outboxSize(): number {
    return this.outbox.size;
  }

  start(): void {
    this.net.on(this.index, (_from, msg) => this.onMessage(msg as Msg));
    this.ctx.sim.every(TIMING.tickMs, () => this.tick(), this.ctx.rng.fork(`phase${this.index}`).int(1, TIMING.tickMs));
  }

  report(spec: TaskSpec): void {
    this.enqueue({ t: 'report', id: `report:${spec.id}`, spec });
  }

  observe(key: string, value: unknown, validForMs: number): void {
    this.enqueue({ t: 'obs', id: this.mint(), key, value, observedAt: this.ctx.sim.now, validForMs });
  }

  /** A volunteer walks this device's unsent reports to another device, which forwards them if it can reach the hub. */
  carryTo(other: Client): void {
    let added = 0;
    for (const [id, msg] of this.outbox) {
      if (other.outbox.has(id)) continue;
      other.outbox.set(id, msg);
      added++;
    }
    other.carried = (other.carried ?? 0) + added;
  }

  restart(downForMs: number): void {
    this.off = true;
    this.net.setDown(this.index, true);
    this.worker.suspend(downForMs);
    this.ctx.sim.after(downForMs, () => {
      this.off = false;
      this.net.setDown(this.index, false);
    });
  }

  private mint(): string {
    return `c${this.index}:${++this.nextId}`;
  }

  private enqueue(msg: Msg & { id: string }): void {
    this.outbox.set(msg.id, msg);
    this.net.send(this.index, HUB, msg);
  }

  private tick(): void {
    if (this.off) return;
    this.net.send(this.index, HUB, { t: 'hb' } satisfies Msg);
    for (const msg of this.outbox.values()) this.net.send(this.index, HUB, msg);
  }

  private onMessage(msg: Msg): void {
    if (msg.t === 'ack') {
      this.outbox.delete(msg.id);
      return;
    }
    if (msg.t !== 'assign') return;
    this.net.send(this.index, HUB, { t: 'ack', id: msg.id } satisfies Msg);
    if (this.seen.has(msg.id)) return;
    this.seen.add(msg.id);
    this.worker.give(msg.task, msg.spec.priority, this.ctx.durationOf(msg.task));
  }
}
