export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface Timer {
  at: number;
  order: number;
  fn: () => void;
}

/** Manually advanced time. Timers due at the same instant run in the order they were set. */
export class VirtualClock implements Clock {
  private time: number;
  private order = 0;
  private timers = new Set<Timer>();

  constructor(start = 0) {
    this.time = start;
  }

  now(): number {
    return this.time;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const timer: Timer = { at: this.time + Math.max(0, ms), order: this.order++, fn };
    this.timers.add(timer);
    return timer;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as Timer);
  }

  /** Moves time forward, running everything that falls due, including timers set along the way. */
  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      const next = this.next();
      if (!next || next.at > end) break;
      this.timers.delete(next);
      this.time = next.at;
      next.fn();
    }
    this.time = end;
  }

  private next(): Timer | undefined {
    let best: Timer | undefined;
    for (const t of this.timers) {
      if (!best || t.at < best.at || (t.at === best.at && t.order < best.order)) best = t;
    }
    return best;
  }
}

/** Repeats fn until the returned stop function is called. */
export function every(clock: Clock, ms: number, fn: () => void): () => void {
  let handle: unknown;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    handle = clock.setTimeout(tick, ms);
    fn();
  };
  handle = clock.setTimeout(tick, ms);
  return () => {
    stopped = true;
    clock.clearTimeout(handle);
  };
}
