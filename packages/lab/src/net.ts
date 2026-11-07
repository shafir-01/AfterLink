import type { Rng } from './rng.ts';
import type { Quality } from './scenario.ts';
import { TIMING } from './scenario.ts';
import type { Sim } from './sim.ts';

export const HUB = -1;

export type Handler = (from: number, msg: unknown) => void;

const CLEAN: Quality = { loss: 0, duplicate: 0, delayMs: 0, reorder: false };

/** Same scatter the real link gate uses when reordering with no delay set. */
const REORDER_WINDOW_MS = 40;

const pairKey = (a: number, b: number) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export function sizeOf(msg: unknown): number {
  return Buffer.byteLength(JSON.stringify(msg));
}

/**
 * The network the two baselines run on, with the same physics as the real mesh: a link that is cut
 * in both directions, or whose device restarts, stays down until it can be renegotiated through the
 * hub, and both ends must be able to reach the hub. Established links need no hub at all.
 */
export class SimNet {
  sentBytes = 0;
  sentMessages = 0;
  private cut = new Set<string>();
  private broken = new Set<string>();
  private hubUp = true;
  private hubReach = new Set<number>([0, 1, 2, 3]);
  private quality: Quality = CLEAN;
  private handlers = new Map<number, Handler>();
  private down = new Set<number>();

  constructor(private sim: Sim, private rng: Rng) {}

  on(node: number, handler: Handler): void {
    this.handlers.set(node, handler);
  }

  setCut(pairs: [number, number][], hubReach: number[]): void {
    this.cut = new Set(pairs.map(([a, b]) => `${a}>${b}`));
    for (const [a, b] of pairs) if (this.cut.has(`${b}>${a}`)) this.broken.add(pairKey(a, b));
    this.hubReach = new Set(hubReach);
    this.renegotiate();
  }

  setHub(up: boolean): void {
    this.hubUp = up;
    this.renegotiate();
  }

  setQuality(quality: Quality): void {
    this.quality = quality;
  }

  setDown(node: number, down: boolean): void {
    if (down) {
      this.down.add(node);
      for (const peer of this.handlers.keys()) if (peer !== node && peer !== HUB) this.broken.add(pairKey(node, peer));
    } else {
      this.down.delete(node);
      this.renegotiate();
    }
  }

  private renegotiate(): void {
    if (!this.hubUp) return;
    for (const key of [...this.broken]) {
      const [a, b] = key.split('|').map(Number) as [number, number];
      if (this.cut.has(`${a}>${b}`) && this.cut.has(`${b}>${a}`)) continue;
      if (!this.hubReach.has(a) || !this.hubReach.has(b) || this.down.has(a) || this.down.has(b)) continue;
      this.broken.delete(key);
    }
  }

  reachable(from: number, to: number): boolean {
    if (this.down.has(from) || this.down.has(to)) return false;
    if (from === HUB || to === HUB) {
      const client = from === HUB ? to : from;
      return this.hubUp && this.hubReach.has(client);
    }
    return !this.cut.has(`${from}>${to}`) && !this.broken.has(pairKey(from, to));
  }

  send(from: number, to: number, msg: unknown): void {
    this.sentBytes += sizeOf(msg);
    this.sentMessages++;
    if (!this.reachable(from, to)) return;
    const q = this.quality;
    if (q.loss > 0 && this.rng.chance(q.loss)) return;
    this.deliver(from, to, msg);
    if (q.duplicate > 0 && this.rng.chance(q.duplicate)) this.deliver(from, to, msg);
  }

  private deliver(from: number, to: number, msg: unknown): void {
    const q = this.quality;
    const scatter = q.reorder ? this.rng.next() * Math.max(q.delayMs, REORDER_WINDOW_MS) : 0;
    this.sim.after(TIMING.latencyMs + q.delayMs + scatter, () => {
      if (this.reachable(from, to)) this.handlers.get(to)?.(from, msg);
    });
  }
}
