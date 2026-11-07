import type { ActorId } from '@afterlink/protocol';
import { hqPath, peerPath, type Box, type Frame } from './layout';
import { pairKey } from './graph';

const SETTLE_MS = 260;
const REDUCED = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

interface Pulse {
  el: SVGCircleElement;
  path: SVGPathElement;
  reverse: boolean;
  start: number;
  duration: number;
}

/**
 * Draws the theatre imperatively, once per frame, so device positions, link paths and pulses
 * stay locked together while a group drifts. It only ever renders what it is told by reports.
 */
export class Scene {
  private frame: Frame | null = null;
  private order: ActorId[] = [];
  private target = new Map<ActorId, number>();
  private offset = new Map<ActorId, number>();
  private devices = new Map<ActorId, HTMLElement>();
  private peers = new Map<string, SVGPathElement>();
  private hqs = new Map<ActorId, SVGPathElement>();
  private pulses: Pulse[] = [];
  private pulseLayer: SVGGElement | null = null;
  private raf = 0;
  private last = 0;
  private dirty = true;

  start() {
    const tick = (now: number) => {
      this.step(now);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    for (const p of this.pulses) p.el.remove();
    this.pulses = [];
  }

  setFrame(frame: Frame, order: ActorId[]) {
    this.frame = frame;
    this.order = order;
    this.dirty = true;
  }

  /** Moves whole groups apart. Driven by which links are reported cut. */
  setGroups(groups: ActorId[][]) {
    const f = this.frame;
    const n = groups.length;
    for (const a of this.order) this.target.set(a, 0);
    if (f && n > 1) {
      groups.forEach((g, i) => {
        const shift = n === 1 ? 0 : (i / (n - 1) - 0.5) * 2 * f.drift;
        for (const a of g) this.target.set(a, shift);
      });
    }
    if (REDUCED()) for (const [a, v] of this.target) this.offset.set(a, v);
    this.dirty = true;
  }

  bindDevice(a: ActorId, el: HTMLElement | null) {
    if (el) this.devices.set(a, el);
    else this.devices.delete(a);
    this.dirty = true;
  }

  bindPeer(a: ActorId, b: ActorId, el: SVGPathElement | null) {
    const k = pairKey(a, b);
    if (el) this.peers.set(k, el);
    else this.peers.delete(k);
    this.dirty = true;
  }

  bindHq(a: ActorId, el: SVGPathElement | null) {
    if (el) this.hqs.set(a, el);
    else this.hqs.delete(a);
    this.dirty = true;
  }

  bindPulseLayer(el: SVGGElement | null) {
    this.pulseLayer = el;
  }

  /** Current on-screen box of a device, in theatre coordinates. */
  box(a: ActorId): Box | null {
    const i = this.order.indexOf(a);
    const slot = this.frame?.slots[i];
    if (!slot) return null;
    return this.placed(slot, a);
  }

  private placed(slot: Box, a: ActorId): Box {
    const d = this.offset.get(a) ?? 0;
    return this.frame?.mode === 'row' ? { ...slot, x: slot.x + d } : { ...slot, y: slot.y + d + (this.frame?.drift ?? 0) };
  }

  /** A real message moved between these two devices. */
  pulsePeer(from: ActorId, to: ActorId, kind: 'sync' | 'ferry' = 'sync') {
    const path = this.peers.get(pairKey(from, to));
    if (path) this.spawn(path, from !== this.pathStart(from, to), kind);
  }

  /** A device report really reached HQ. */
  pulseHq(from: ActorId) {
    const path = this.hqs.get(from);
    if (path) this.spawn(path, true, 'hq');
  }

  private pathStart(a: ActorId, b: ActorId): ActorId {
    return this.order.indexOf(a) < this.order.indexOf(b) ? a : b;
  }

  private spawn(path: SVGPathElement, reverse: boolean, kind: string) {
    if (!this.pulseLayer || this.pulses.length > 40 || document.hidden) return;
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    el.setAttribute('class', `st-pulse ${kind}`);
    el.setAttribute('r', '4');
    this.pulseLayer.appendChild(el);
    const length = path.getTotalLength();
    this.pulses.push({ el, path, reverse, start: performance.now(), duration: Math.min(900, 300 + length * 0.9) });
  }

  private step(now: number) {
    const dt = Math.min(64, now - this.last);
    this.last = now;
    const k = 1 - Math.exp(-dt / SETTLE_MS);
    for (const a of this.order) {
      const cur = this.offset.get(a) ?? 0;
      const to = this.target.get(a) ?? 0;
      const next = Math.abs(to - cur) < 0.2 ? to : cur + (to - cur) * k;
      if (next !== cur) this.dirty = true;
      this.offset.set(a, next);
    }
    if (this.dirty) this.draw();
    this.pulses = this.pulses.filter((p) => {
      const t = (now - p.start) / p.duration;
      if (t >= 1) {
        p.el.remove();
        return false;
      }
      const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      const length = p.path.getTotalLength();
      const pt = p.path.getPointAtLength((p.reverse ? 1 - eased : eased) * length);
      p.el.setAttribute('cx', String(pt.x));
      p.el.setAttribute('cy', String(pt.y));
      p.el.style.opacity = String(Math.min(1, t * 8, (1 - t) * 8));
      return true;
    });
  }

  private draw() {
    const f = this.frame;
    if (!f) return;
    this.dirty = false;
    const boxes = this.order.map((a, i) => (f.slots[i] ? this.placed(f.slots[i]!, a) : null));
    this.order.forEach((a, i) => {
      const box = boxes[i];
      const el = this.devices.get(a);
      if (box && el) el.style.transform = `translate(${box.x}px, ${box.y}px)`;
      const hq = this.hqs.get(a);
      if (box && hq) hq.setAttribute('d', hqPath(f, box));
      this.order.forEach((b, j) => {
        if (j <= i) return;
        const other = boxes[j];
        const p = this.peers.get(pairKey(a, b));
        if (box && other && p) p.setAttribute('d', peerPath(f, box, other, i, j));
      });
    });
  }
}
