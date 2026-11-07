import type { Capability, TaskId, TaskSpec, TokenId } from '@afterlink/protocol';
import { SimNet } from './net.ts';
import { TIMING, type FaultStep, type Incident, type Scenario } from './scenario.ts';
import { emptyReport, type AttackResult, type RunContext, type SystemReport, type SystemUnderTest } from './system.ts';
import { FieldWorker } from './worker.ts';

interface Entry {
  k: string;
  v: BoardValue;
  ts: number;
  by: number;
}

type BoardValue =
  | { card: TaskSpec; status: 'open' | 'claimed' | 'done'; owner: number | null }
  | { holder: number; task: TaskId }
  | { observed: unknown };

type Msg =
  /** "Send me what I have not seen": `have` is the last version of yours I hold. */
  | { t: 'digest'; have: number }
  | { t: 'delta'; upTo: number; entries: Entry[] };

function newer(a: Entry, b: Entry): boolean {
  return a.ts > b.ts || (a.ts === b.ts && a.by > b.by);
}

const stateOf = (e: Entry | undefined) => e?.v as { card: TaskSpec; status: 'open' | 'claimed' | 'done'; owner: number | null } | undefined;

/**
 * Baseline B at full strength: a replicated board that works with no server. Every device edits
 * locally and pushes each write at once, gossips deltas between any reachable pair, and shares the
 * same links and the same cover rule as AfterLink. Clocks are perfect. What it lacks is exactly what
 * makes it a last-write-wins board: no rights model, no validity on facts, no record of losing writes.
 */
export class BoardSystem implements SystemUnderTest {
  readonly id = 'board' as const;
  private net: SimNet;
  private clients: BoardClient[];
  private scenario: Scenario;
  private attacks: AttackResult[] = [];
  private ferry: { first: number; second: number } | null = null;

  constructor(private ctx: RunContext) {
    this.scenario = ctx.scenario;
    this.net = new SimNet(ctx.sim, ctx.rng.fork('net'));
    this.clients = this.scenario.world.teams.map((t, i) => new BoardClient(i, t.capabilities, ctx, this.net));
  }

  async start(): Promise<void> {
    for (const c of this.clients) c.start();
  }

  inject(i: Incident): void {
    this.clients[i.reporter]?.report(i.spec);
  }

  apply(step: FaultStep): void {
    switch (step.kind) {
      case 'hub':
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
        this.clients[step.actor]?.observe(step.key, step.value);
        break;
      case 'ferry': {
        const snapshot = (this.clients[step.from] as BoardClient).snapshot();
        const to = this.clients[step.to] as BoardClient;
        const first = to.importSnapshot(snapshot);
        let second = 0;
        for (let i = 1; i < step.copies; i++) second += to.importSnapshot(snapshot);
        this.ferry = { first, second };
        break;
      }
      case 'transfer': {
        this.clients[step.from]?.handOver(step.token, step.to);
        break;
      }
      case 'attack':
        this.attacks.push(this.attack(step.attack, step.target));
        break;
    }
  }

  /**
   * Devices talk over authenticated channels, so outsiders are stopped on the wire. A carried board
   * export is a plain file with nothing to verify, and a teammate's edit is simply a valid write.
   */
  private attack(attack: string, target: number): AttackResult {
    const victim = this.clients[target] as BoardClient;
    const forged = (): Entry[] => {
      const spec = this.scenario.incidents[0]?.spec;
      return spec ? [{ k: `task/${spec.id}`, v: { card: spec, status: 'done', owner: target }, ts: this.ctx.sim.now, by: 9 }] : [];
    };
    switch (attack) {
      case 'forged-packet': {
        const applied = victim.importSnapshot(forged());
        return { attack, outcome: applied > 0 ? 'accepted' : 'no-effect' };
      }
      case 'replayed-packet': {
        const applied = victim.importSnapshot(victim.oldestExport());
        return { attack, outcome: applied > 0 ? 'accepted' : 'no-effect' };
      }
      case 'insider-fork': {
        const token = this.scenario.world.resources[0]?.tokens[0]?.id as TokenId;
        const first = victim.bookDirect(token, 'insider-1');
        const second = victim.bookDirect(token, 'insider-2');
        return { attack, outcome: first && second ? 'accepted' : 'rejected' };
      }
      default:
        return { attack, outcome: 'rejected' };
    }
  }

  bytes(): number {
    return this.net.sentBytes;
  }

  isConverged(): boolean {
    const [first, ...rest] = this.clients.map((c) => c.digest());
    return rest.every((d) => d === first);
  }

  report(): SystemReport {
    const report = emptyReport();
    report.converged = this.isConverged();
    report.silentOverwrites = this.clients.reduce((n, c) => n + c.overwrites, 0);
    const merged = this.clients[0] as BoardClient;
    const finished = new Set(this.clients.flatMap((c) => c.finished));
    report.lostCompletions = [...finished].filter((id) => stateOf(merged.entry(`task/${id}`))?.status !== 'done').length;
    report.attacks = this.attacks;
    if (this.ferry) {
      report.ferryNewFirst = this.ferry.first;
      report.ferryNewSecond = this.ferry.second;
    }
    report.restartDefects = this.scenario.faults.some((f) => f.kind === 'restart') ? 0 : null;
    return report;
  }

  stop(): void {}
}

class BoardClient {
  overwrites = 0;
  finished: TaskId[] = [];
  private entries = new Map<string, Entry>();
  private versions = new Map<string, number>();
  private version = 0;
  private peerHave = new Map<number, number>();
  private lastHeard = new Map<number, number>();
  private worker: FieldWorker;
  private off = false;
  private refused = new Set<string>();
  private exports: Entry[][] = [];

  constructor(
    readonly index: number,
    readonly capabilities: Capability[],
    private ctx: RunContext,
    private net: SimNet,
  ) {
    this.worker = new FieldWorker(
      ctx.sim,
      (task) => ctx.trace({ t: ctx.sim.now, kind: 'start', actor: index, task }),
      (task) => this.finish(task),
    );
  }

  private get peers(): number[] {
    return this.ctx.scenario.world.teams.map((_, i) => i).filter((i) => i !== this.index);
  }

  start(): void {
    this.net.on(this.index, (from, msg) => this.onMessage(from, msg as Msg));
    const phase = this.ctx.rng.fork(`phase${this.index}`).int(1, TIMING.tickMs);
    this.ctx.sim.every(TIMING.tickMs, () => this.tick(), phase);
  }

  entry(k: string): Entry | undefined {
    return this.entries.get(k);
  }

  report(spec: TaskSpec): void {
    if (this.entries.has(`task/${spec.id}`)) return;
    this.write(`task/${spec.id}`, { card: spec, status: 'open', owner: null });
  }

  observe(key: string, value: unknown): void {
    this.write(`obs/${key}`, { observed: value });
  }

  handOver(token: TokenId, to: number): void {
    this.write(`hold/${token}`, { holder: to, task: '' });
  }

  bookDirect(token: TokenId, task: TaskId): boolean {
    this.write(`res/${token}`, { holder: this.index, task });
    this.ctx.trace({ t: this.ctx.sim.now, kind: 'commit', actor: this.index, task, token });
    return true;
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

  snapshot(): Entry[] {
    const all = [...this.entries.values()];
    this.exports.push(all);
    return all;
  }

  oldestExport(): Entry[] {
    return this.exports[0] ?? [...this.entries.values()].slice(0, 5);
  }

  /** Merges a carried export. Returns how many records it changed. */
  importSnapshot(entries: Entry[]): number {
    let changed = 0;
    for (const e of entries) if (this.merge(e)) changed++;
    if (changed > 0) this.afterMerge();
    return changed;
  }

  digest(): string {
    return [...this.entries.values()]
      .map((e) => `${e.k}@${e.ts}:${e.by}`)
      .sort()
      .join(',');
  }

  private write(k: string, v: BoardValue): void {
    const now = this.ctx.sim.now;
    const prior = this.entries.get(k);
    const entry: Entry = { k, v, ts: Math.max(now, (prior?.ts ?? 0) + 1), by: this.index };
    this.entries.set(k, entry);
    this.versions.set(k, ++this.version);
    for (const peer of this.peers) this.push(peer);
  }

  /** Last write wins. The losing write is gone, with nothing kept to show it existed. */
  private merge(e: Entry): boolean {
    const current = this.entries.get(e.k);
    if (current && !newer(e, current)) return false;
    if (current && current.by !== e.by && isContest(current, e)) this.overwrites++;
    this.entries.set(e.k, e);
    this.versions.set(e.k, ++this.version);
    return true;
  }

  private push(peer: number): void {
    if (this.off) return;
    const have = this.peerHave.get(peer) ?? 0;
    const entries = [...this.entries.values()].filter((e) => (this.versions.get(e.k) ?? 0) > have);
    if (entries.length === 0) return;
    this.net.send(this.index, peer, { t: 'delta', upTo: this.version, entries } satisfies Msg);
  }

  private onMessage(from: number, msg: Msg): void {
    this.lastHeard.set(from, this.ctx.sim.now);
    if (msg.t === 'digest') {
      this.peerHave.set(from, msg.have);
      this.push(from);
      return;
    }
    let changed = false;
    for (const e of msg.entries) if (this.merge(e)) changed = true;
    this.seenUpTo.set(from, Math.max(this.seenUpTo.get(from) ?? 0, msg.upTo));
    if (changed) {
      this.afterMerge();
      for (const peer of this.peers) if (peer !== from) this.push(peer);
    }
  }

  private seenUpTo = new Map<number, number>();

  private afterMerge(): void {
    const task = this.worker.currentTask;
    if (task) {
      const state = stateOf(this.entries.get(`task/${task}`));
      if (state && state.owner !== this.index) {
        this.worker.drop(task);
        this.ctx.trace({ t: this.ctx.sim.now, kind: 'abandon', actor: this.index, task });
      }
    }
  }

  private tick(): void {
    if (this.off) return;
    for (const peer of this.peers) {
      this.net.send(this.index, peer, { t: 'digest', have: this.seenUpTo.get(peer) ?? 0 } satisfies Msg);
    }
    if (!this.worker.busy) this.takeWork();
  }

  private takeWork(): void {
    const now = this.ctx.sim.now;
    const { coverAfterMs, coverMaxPriority } = this.ctx.scenario.world.fallback;
    const cards = [...this.entries.values()]
      .filter((e) => e.k.startsWith('task/'))
      .sort((a, b) => (stateOf(a) as { card: TaskSpec }).card.priority - (stateOf(b) as { card: TaskSpec }).card.priority || a.ts - b.ts);
    for (const entry of cards) {
      const state = stateOf(entry) as { card: TaskSpec; status: string; owner: number | null };
      const { card } = state;
      if (!card.requires.every((r) => this.capabilities.includes(r))) continue;
      const open = state.status === 'open';
      const coverable =
        state.status === 'claimed' &&
        state.owner !== this.index &&
        state.owner !== null &&
        card.priority <= coverMaxPriority &&
        now - entry.ts >= coverAfterMs &&
        now - (this.lastHeard.get(state.owner) ?? 0) >= coverAfterMs;
      if (!open && !coverable) continue;
      if (card.dependsOn.some((d) => stateOf(this.entries.get(`task/${d}`))?.status !== 'done')) {
        this.refuse(card.id, 'DEPENDENCY_UNMET');
        continue;
      }
      if ((card.reliesOn ?? []).some((key) => (this.entries.get(`obs/${key}`)?.v as { observed?: unknown } | undefined)?.observed === false)) {
        this.refuse(card.id, 'BLOCKED_BY_CONTINGENCY');
        continue;
      }
      const tokens = this.freeTokens(card);
      if (!tokens) {
        this.refuse(card.id, 'NO_RIGHT');
        continue;
      }
      this.claim(card, tokens, coverable);
      return;
    }
  }

  private freeTokens(card: TaskSpec): TokenId[] | null {
    const out: TokenId[] = [];
    for (const need of card.needs) {
      const spec = this.ctx.scenario.world.resources.find((r) => r.id === need.resource);
      const free = (spec?.tokens ?? []).map((t) => t.id).filter((id) => !this.entries.has(`res/${id}`));
      if (free.length < need.count) return null;
      out.push(...free.slice(0, need.count));
    }
    return out;
  }

  private claim(card: TaskSpec, tokens: TokenId[], cover: boolean): void {
    const now = this.ctx.sim.now;
    this.write(`task/${card.id}`, { card, status: 'claimed', owner: this.index });
    for (const token of tokens) {
      this.write(`res/${token}`, { holder: this.index, task: card.id });
      this.ctx.trace({ t: now, kind: 'commit', actor: this.index, task: card.id, token });
    }
    this.ctx.trace({ t: now, kind: 'assign', actor: this.index, task: card.id, via: cover ? 'cover' : 'plan' });
    this.worker.drop(card.id);
    this.worker.give(card.id, card.priority, this.ctx.durationOf(card.id));
  }

  private finish(task: TaskId): void {
    this.ctx.trace({ t: this.ctx.sim.now, kind: 'complete', actor: this.index, task });
    this.finished.push(task);
    const state = stateOf(this.entries.get(`task/${task}`));
    if (state) this.write(`task/${task}`, { ...state, status: 'done', owner: this.index });
  }

  private refuse(task: TaskId, code: string): void {
    const key = `${task}:${code}`;
    if (this.refused.has(key)) return;
    this.refused.add(key);
    this.ctx.trace({ t: this.ctx.sim.now, kind: 'refuse', actor: this.index, task, code });
  }
}

/** Two different claims on the same card or token, as opposed to one write following another. */
function isContest(a: Entry, b: Entry): boolean {
  const owner = (e: Entry) => (e.v as { owner?: number | null; holder?: number }).owner ?? (e.v as { holder?: number }).holder;
  return owner(a) !== owner(b) && (a.k.startsWith('res/') || a.k.startsWith('task/'));
}
