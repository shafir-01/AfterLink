import type { Clock } from './clock.ts';
import type { Random } from './random.ts';

export interface GatePlan {
  lossRate?: number;
  duplicateRate?: number;
  delayMs?: number;
  reorder?: boolean;
}

/** Window used to scatter messages when reordering is on and no delay is set. */
const REORDER_WINDOW_MS = 40;

/**
 * The send path of one direction of a link. Everything a fault plan does to traffic happens here,
 * so a dropped message is one that never reached the transport.
 */
export class SendGate<M> {
  plan: GatePlan = {};
  dropped = 0;
  duplicated = 0;
  private pending = new Set<unknown>();

  constructor(
    private readonly out: (msg: M) => void,
    private readonly clock: Clock,
    private readonly random: Random,
    private readonly baseDelayMs = 0,
  ) {}

  get held(): number {
    return this.pending.size;
  }

  push(msg: M): void {
    const { lossRate = 0, duplicateRate = 0 } = this.plan;
    if (lossRate > 0 && this.random() < lossRate) {
      this.dropped++;
      return;
    }
    this.dispatch(msg);
    if (duplicateRate > 0 && this.random() < duplicateRate) {
      this.duplicated++;
      this.dispatch(msg);
    }
  }

  /** Discards everything still held, so a closed link delivers nothing more. */
  clear(): void {
    for (const handle of this.pending) this.clock.clearTimeout(handle);
    this.pending.clear();
  }

  private dispatch(msg: M): void {
    const { delayMs = 0, reorder = false } = this.plan;
    const scatter = reorder ? this.random() * Math.max(delayMs, REORDER_WINDOW_MS) : 0;
    const wait = this.baseDelayMs + delayMs + scatter;
    if (wait <= 0) {
      this.out(msg);
      return;
    }
    const handle = this.clock.setTimeout(() => {
      this.pending.delete(handle);
      this.out(msg);
    }, wait);
    this.pending.add(handle);
  }
}
