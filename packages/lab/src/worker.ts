import type { TaskId } from '@afterlink/protocol';
import type { Sim } from './sim.ts';

interface Job {
  task: TaskId;
  priority: number;
  durationMs: number;
  order: number;
}

/**
 * The person holding the device: one job at a time, highest priority first.
 * Used unchanged by every system, so hands-on capacity is identical.
 */
export class FieldWorker {
  private queue: Job[] = [];
  private active: (Job & { timer: number; finishAt: number }) | null = null;
  private order = 0;
  private suspendedUntil = 0;
  private known = new Set<TaskId>();

  constructor(
    private sim: Sim,
    private onStart: (task: TaskId) => void,
    private onDone: (task: TaskId) => void,
  ) {}

  get busy(): boolean {
    return this.active !== null;
  }

  get currentTask(): TaskId | null {
    return this.active?.task ?? null;
  }

  get queued(): number {
    return this.queue.length + (this.active ? 1 : 0);
  }

  has(task: TaskId): boolean {
    return this.known.has(task);
  }

  give(task: TaskId, priority: number, durationMs: number): void {
    if (this.known.has(task)) return;
    this.known.add(task);
    this.queue.push({ task, priority, durationMs, order: ++this.order });
    this.pull();
  }

  /** Stops a job the record says belongs to someone else. Returns true when work had begun. */
  drop(task: TaskId): boolean {
    this.queue = this.queue.filter((j) => j.task !== task);
    this.known.delete(task);
    if (this.active?.task !== task) return false;
    this.sim.cancel(this.active.timer);
    this.active = null;
    this.pull();
    return true;
  }

  /** The device is off. Work in hand pauses and nothing new starts until it returns. */
  suspend(ms: number): void {
    this.suspendedUntil = this.sim.now + ms;
    if (this.active) {
      this.sim.cancel(this.active.timer);
      const finishAt = this.active.finishAt + ms;
      this.active.finishAt = finishAt;
      this.active.timer = this.sim.at(finishAt, () => this.finish());
    }
    this.sim.after(ms, () => this.pull());
  }

  private pull(): void {
    if (this.active || this.sim.now < this.suspendedUntil) return;
    this.queue.sort((a, b) => a.priority - b.priority || a.order - b.order);
    const next = this.queue.shift();
    if (!next) return;
    const finishAt = this.sim.now + next.durationMs;
    this.active = { ...next, finishAt, timer: this.sim.at(finishAt, () => this.finish()) };
    this.onStart(next.task);
  }

  private finish(): void {
    const job = this.active;
    if (!job) return;
    this.active = null;
    this.onDone(job.task);
    this.pull();
  }
}
