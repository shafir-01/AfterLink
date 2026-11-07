import { verifyEvent } from './envelope.ts';
import type { ActorId, AnyEvent, EventId, MissionId, SyncSummary } from './types.ts';

export type IngestStatus = 'added' | 'duplicate' | 'gap' | 'invalid' | 'fork';

export interface IngestResult {
  /** Every event newly placed in the log, including released gap events and fork branches, in causal order. */
  added: AnyEvent[];
  duplicates: number;
  /** Input events still waiting for a missing dependency. */
  gaps: number;
  invalid: AnyEvent[];
  /** Input events that proved a fork. A fork with missing dependencies appears here before it appears in `added`. */
  forks: AnyEvent[];
}

/** Two or more signed events from one actor at one sequence number. */
export interface ForkRecord {
  actor: ActorId;
  seq: number;
  events: AnyEvent[];
}

/** A SyncSummary that also names the extra branch tips of forked actors. Absent when there are no forks. */
export interface LogSummary extends SyncSummary {
  branches?: Record<ActorId, EventId[]>;
}

const dependencies = (e: AnyEvent): EventId[] => (e.prev ? [e.prev, ...e.parents] : e.parents);

const slotKey = (e: AnyEvent): string => `${e.seq}:${e.actor}`;

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * One replica of a mission history. An event is placed once its `prev` and `parents`
 * are present, so the placed set depends only on which events were received, never on
 * delivery order. Forked branches are kept side by side.
 */
export class EventLog {
  readonly mission: MissionId;
  private readonly events = new Map<EventId, AnyEvent>();
  private readonly ranks = new Map<EventId, number>();
  private readonly order: AnyEvent[] = [];
  private ordered = true;
  private readonly tips = new Set<EventId>();
  private readonly actorTips = new Map<ActorId, Set<EventId>>();
  private readonly waiting = new Map<EventId, AnyEvent>();
  private readonly waiters = new Map<EventId, Set<EventId>>();
  private readonly slots = new Map<string, AnyEvent[]>();
  private readonly forkedSlots = new Set<string>();
  private clock = 0;

  constructor(mission: MissionId) {
    this.mission = mission;
  }

  get size(): number {
    return this.events.size;
  }

  /** Events held back until a missing dependency arrives. */
  get pending(): number {
    return this.waiting.size;
  }

  has(id: EventId): boolean {
    return this.events.has(id);
  }

  get(id: EventId): AnyEvent | undefined {
    return this.events.get(id);
  }

  /** To learn which events a delivery released, use `ingestMany`. */
  ingest(e: AnyEvent): IngestStatus {
    return this.receive(e, [], []);
  }

  ingestMany(es: AnyEvent[]): IngestResult {
    const result: IngestResult = { added: [], duplicates: 0, gaps: 0, invalid: [], forks: [] };
    for (const e of es) {
      const status = this.receive(e, result.added, result.invalid);
      if (status === 'duplicate') result.duplicates++;
      else if (status === 'invalid') result.invalid.push(e);
      else if (status === 'fork') result.forks.push(e);
    }
    result.gaps = new Set(es.filter((e) => e && this.waiting.has(e.id)).map((e) => e.id)).size;
    return result;
  }

  /** Topological order. Ties break on (lamport, actor, seq), then id between fork branches. */
  all(): AnyEvent[] {
    if (!this.ordered) {
      this.order.sort(this.compare);
      this.ordered = true;
    }
    return this.order.slice();
  }

  byActor(actor: ActorId): AnyEvent[] {
    return this.all().filter((e) => e.actor === actor);
  }

  /** Events nothing else in the log depends on: the causal frontier. */
  heads(): EventId[] {
    return [...this.tips].sort();
  }

  /** The actor's highest event. Between fork branches the lowest id wins, on every replica. */
  head(actor: ActorId): { seq: number; id: EventId } | undefined {
    const [top] = this.branchTips(actor);
    return top && { seq: top.seq, id: top.id };
  }

  lamport(): number {
    return this.clock;
  }

  forks(): ForkRecord[] {
    return [...this.forkedSlots]
      .map((key) => {
        const events = [...this.slots.get(key)!].sort((a, b) => compareText(a.id, b.id));
        return { actor: events[0]!.actor, seq: events[0]!.seq, events };
      })
      .sort((a, b) => compareText(a.actor, b.actor) || a.seq - b.seq);
  }

  summary(): LogSummary {
    const heads: SyncSummary['heads'] = {};
    const branches: Record<ActorId, EventId[]> = {};
    for (const actor of [...this.actorTips.keys()].sort()) {
      const [top, ...rest] = this.branchTips(actor);
      heads[actor] = { seq: top!.seq, id: top!.id };
      if (rest.length) branches[actor] = rest.map((e) => e.id);
    }
    const summary: LogSummary = { mission: this.mission, heads };
    if (Object.keys(branches).length) summary.branches = branches;
    return summary;
  }

  /**
   * Events the remote cannot be shown to hold, in causal order. Any prefix of the result
   * is also causally safe. An unknown remote head means the remote is ahead when its seq
   * is higher than ours, and proves a fork otherwise, so the whole actor log is offered.
   * The summary comes off the wire, so a malformed one only costs extra events.
   */
  missingFor(remote: SyncSummary): AnyEvent[] {
    if (remote?.mission !== this.mission) return [];
    const held = new Set<EventId>();
    const ahead = new Set<ActorId>();
    const branches = (remote as LogSummary).branches ?? {};
    for (const [actor, head] of Object.entries(remote.heads ?? {})) {
      const extra = branches[actor];
      const tips = [head?.id, ...(Array.isArray(extra) ? extra : [])];
      const known = tips.filter((id) => this.events.has(id));
      if (known.length === 0 && head?.seq > (this.head(actor)?.seq ?? 0)) ahead.add(actor);
      for (const tip of known) {
        let id: EventId | null = tip;
        while (id && !held.has(id)) {
          held.add(id);
          id = this.events.get(id)!.prev;
        }
      }
    }
    return this.all().filter((e) => !held.has(e.id) && !ahead.has(e.actor));
  }

  private receive(e: AnyEvent, added: AnyEvent[], invalid: AnyEvent[]): IngestStatus {
    if (!verifyEvent(e).ok || e.mission !== this.mission) return 'invalid';
    if (this.events.has(e.id)) return 'duplicate';
    if (this.waiting.has(e.id)) return 'gap';
    if (!this.chains(e)) return 'invalid';
    const forked = this.takeSlot(e);
    const missing = dependencies(e).filter((id) => !this.events.has(id));
    if (missing.length > 0) {
      this.waiting.set(e.id, e);
      for (const id of missing) {
        const blocked = this.waiters.get(id) ?? new Set<EventId>();
        this.waiters.set(id, blocked.add(e.id));
      }
      return forked ? 'fork' : 'gap';
    }
    this.place(e, added, invalid);
    return forked ? 'fork' : 'added';
  }

  /** A known `prev` must be this actor's previous sequence number. */
  private chains(e: AnyEvent): boolean {
    const prev = e.prev ? this.events.get(e.prev) : undefined;
    return !prev || (prev.actor === e.actor && prev.seq === e.seq - 1);
  }

  private takeSlot(e: AnyEvent): boolean {
    const key = slotKey(e);
    const slot = this.slots.get(key);
    if (!slot) {
      this.slots.set(key, [e]);
      return false;
    }
    slot.push(e);
    this.forkedSlots.add(key);
    return true;
  }

  private leaveSlot(e: AnyEvent): void {
    const key = slotKey(e);
    const slot = this.slots.get(key)!.filter((other) => other.id !== e.id);
    if (slot.length) this.slots.set(key, slot);
    else this.slots.delete(key);
    if (slot.length < 2) this.forkedSlots.delete(key);
  }

  private place(first: AnyEvent, added: AnyEvent[], invalid: AnyEvent[]): void {
    const ready = [first];
    while (ready.length) {
      const e = ready.pop()!;
      this.commit(e);
      added.push(e);
      const blocked = this.waiters.get(e.id);
      if (!blocked) continue;
      this.waiters.delete(e.id);
      for (const id of blocked) {
        const next = this.waiting.get(id);
        if (!next || !dependencies(next).every((dep) => this.events.has(dep))) continue;
        this.waiting.delete(id);
        if (this.chains(next)) {
          ready.push(next);
        } else {
          this.leaveSlot(next);
          invalid.push(next);
        }
      }
    }
  }

  private commit(e: AnyEvent): void {
    let rank = e.lamport;
    for (const dep of dependencies(e)) {
      rank = Math.max(rank, this.ranks.get(dep)! + 1);
      this.tips.delete(dep);
    }
    this.ranks.set(e.id, rank);
    this.clock = Math.max(this.clock, rank);
    this.events.set(e.id, e);
    this.order.push(e);
    this.ordered = false;
    this.tips.add(e.id);
    const own = this.actorTips.get(e.actor) ?? new Set<EventId>();
    if (e.prev) own.delete(e.prev);
    this.actorTips.set(e.actor, own.add(e.id));
  }

  private branchTips(actor: ActorId): AnyEvent[] {
    return [...(this.actorTips.get(actor) ?? [])]
      .map((id) => this.events.get(id)!)
      .sort((a, b) => b.seq - a.seq || compareText(a.id, b.id));
  }

  private readonly compare = (a: AnyEvent, b: AnyEvent): number =>
    this.ranks.get(a.id)! - this.ranks.get(b.id)! ||
    compareText(a.actor, b.actor) ||
    a.seq - b.seq ||
    compareText(a.id, b.id);
}
