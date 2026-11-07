import type { Rng } from './rng.ts';

type Callback = () => void | Promise<void>;

interface Timer {
  id: number;
  at: number;
  seq: number;
  fn: Callback;
  every?: number;
  dead?: boolean;
}

function before(a: Timer, b: Timer): boolean {
  return a.at < b.at || (a.at === b.at && a.seq < b.seq);
}

/** Discrete-event scheduler. Nothing in a run waits on real time. */
export class Sim {
  now = 0;
  private heap: Timer[] = [];
  private seq = 0;
  private nextId = 0;
  private live = new Map<number, Timer>();

  at(t: number, fn: Callback): number {
    return this.add(Math.max(t, this.now), fn);
  }

  after(ms: number, fn: Callback): number {
    return this.at(this.now + Math.max(ms, 0), fn);
  }

  every(ms: number, fn: Callback, phaseMs?: number): number {
    const period = Math.max(ms, 1);
    return this.add(this.now + (phaseMs ?? period), fn, period);
  }

  cancel(id: number | undefined): void {
    if (id === undefined) return;
    const timer = this.live.get(id);
    if (timer) timer.dead = true;
    this.live.delete(id);
  }

  /** Runs every timer due up to and including `until`, then parks the clock there. */
  async run(until: number): Promise<void> {
    for (;;) {
      const top = this.heap[0];
      if (!top || top.at > until) break;
      this.pop();
      if (top.dead) continue;
      this.now = top.at;
      if (top.every === undefined) {
        this.live.delete(top.id);
      } else {
        top.at += top.every;
        top.seq = ++this.seq;
        this.push(top);
      }
      await top.fn();
      for (let i = 0; i < 6; i++) await Promise.resolve();
    }
    this.now = Math.max(this.now, until);
  }

  private add(at: number, fn: Callback, every?: number): number {
    const timer: Timer = { id: ++this.nextId, at, seq: ++this.seq, fn, every };
    this.live.set(timer.id, timer);
    this.push(timer);
    return timer.id;
  }

  private push(timer: Timer): void {
    const heap = this.heap;
    let i = heap.length;
    heap.push(timer);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (before(heap[parent] as Timer, timer)) break;
      heap[i] = heap[parent] as Timer;
      i = parent;
    }
    heap[i] = timer;
  }

  private pop(): void {
    const heap = this.heap;
    const last = heap.pop() as Timer;
    if (heap.length === 0) return;
    let i = 0;
    for (;;) {
      const left = 2 * i + 1;
      if (left >= heap.length) break;
      const right = left + 1;
      const child = right < heap.length && before(heap[right] as Timer, heap[left] as Timer) ? right : left;
      if (before(last, heap[child] as Timer)) break;
      heap[i] = heap[child] as Timer;
      i = child;
    }
    heap[i] = last;
  }
}

/** A fixed virtual epoch keeps event timestamps, and so event ids, reproducible. */
export const EPOCH = 1_793_000_000_000;

export interface VirtualWorld {
  sim: Sim;
  rng: Rng;
  /** Wall-clock value at virtual zero. */
  epoch: number;
}

/**
 * Runs `body` with timers, clocks and randomness all driven by the simulator, so unmodified
 * product code executes in virtual time and a seed reproduces a run exactly.
 */
export async function withVirtualRuntime<T>(world: VirtualWorld, body: () => Promise<T>): Promise<T> {
  const { sim, rng, epoch } = world;
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = {
    setTimeout: g.setTimeout,
    clearTimeout: g.clearTimeout,
    setInterval: g.setInterval,
    clearInterval: g.clearInterval,
    now: Date.now,
    perf: performance.now,
    random: Math.random,
    getRandomValues: crypto.getRandomValues,
  };
  const handle = (id: number) => ({
    id,
    ref() { return this; },
    unref() { return this; },
    hasRef: () => false,
    refresh() { return this; },
    [Symbol.toPrimitive]: () => id,
  });
  const idOf = (h: unknown): number | undefined =>
    typeof h === 'number' ? h : (h as { id?: number } | undefined)?.id;

  g.setTimeout = (fn: (...a: unknown[]) => void, ms = 0, ...args: unknown[]) =>
    handle(sim.after(ms, () => fn(...args)));
  g.clearTimeout = (h: unknown) => sim.cancel(idOf(h));
  g.setInterval = (fn: (...a: unknown[]) => void, ms = 0, ...args: unknown[]) =>
    handle(sim.every(ms, () => fn(...args)));
  g.clearInterval = (h: unknown) => sim.cancel(idOf(h));
  Date.now = () => epoch + Math.floor(sim.now);
  performance.now = () => sim.now;
  Math.random = () => rng.next();
  crypto.getRandomValues = (<V extends ArrayBufferView | null>(array: V): V => {
    if (array) rng.fill(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
    return array;
  }) as typeof crypto.getRandomValues;
  try {
    return await body();
  } finally {
    g.setTimeout = saved.setTimeout;
    g.clearTimeout = saved.clearTimeout;
    g.setInterval = saved.setInterval;
    g.clearInterval = saved.clearInterval;
    Date.now = saved.now;
    performance.now = saved.perf;
    Math.random = saved.random;
    crypto.getRandomValues = saved.getRandomValues;
  }
}
