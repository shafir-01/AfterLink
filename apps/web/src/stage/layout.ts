export const DEVICE_W = 300;
const DEVICE_MIN_H = 400;
const DEVICE_MAX_H = 640;
const STACK_BELOW = 760;
const BUS_H = 26;
const STACK_GUTTER = 34;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Frame {
  mode: 'row' | 'stack';
  width: number;
  height: number;
  /** CSS scale applied to each device iframe. */
  scale: number;
  /** Logical iframe height before scaling. */
  deviceH: number;
  slots: Box[];
  /** How far a group moves away from the others when the network splits. */
  drift: number;
  /** Depth of the peer link band under the devices. */
  band: number;
  /** Anchor of the HQ lines, in theatre coordinates. */
  hq: { x: number; y: number };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export const isStacked = (viewportWidth: number) => viewportWidth < STACK_BELOW;

export function frameFor(width: number, height: number, n: number, stacked: boolean): Frame {
  return stacked ? stackFrame(width, n) : rowFrame(width, height, n);
}

function rowFrame(width: number, height: number, n: number): Frame {
  const pad = clamp(width * 0.02, 12, 48);
  const gap = clamp(width * 0.022, 18, 52);
  const drift = clamp(width * 0.055, 56, 130);
  const band = clamp(height * 0.13, 44, 110);
  const colW = (width - pad * 2 - gap * (n - 1) - drift * 2) / n;
  const availH = height - BUS_H - band;
  const scale = Math.max(0.5, Math.min(colW / DEVICE_W, availH / DEVICE_MIN_H));
  const w = DEVICE_W * scale;
  const deviceH = clamp(availH / scale, DEVICE_MIN_H, DEVICE_MAX_H);
  const h = deviceH * scale;
  const rowW = w * n + gap * (n - 1);
  const left = (width - rowW) / 2;
  const slots = Array.from({ length: n }, (_, i) => ({ x: left + i * (w + gap), y: BUS_H, w, h }));
  return { mode: 'row', width, height: BUS_H + h + band, scale, deviceH, slots, drift, band, hq: { x: width / 2, y: 0 } };
}

function stackFrame(width: number, n: number): Frame {
  const w = Math.min(width - STACK_GUTTER * 2, 420);
  const scale = w / DEVICE_W;
  const deviceH = DEVICE_MIN_H;
  const h = deviceH * scale;
  const gap = 18;
  const drift = 22;
  const x = (width - w) / 2;
  const slots = Array.from({ length: n }, (_, i) => ({ x, y: BUS_H + i * (h + gap), w, h }));
  const last = slots[n - 1]!;
  return { mode: 'stack', width, height: last.y + h + drift * 2 + 8, scale, deviceH, slots, drift, band: STACK_GUTTER - 6, hq: { x: width / 2, y: 0 } };
}

/** Peer links arc beneath the row, or along the gutter when stacked. */
export function peerPath(f: Frame, a: Box, b: Box, ai: number, bi: number): string {
  const hops = Math.abs(ai - bi);
  const spread = Math.min(a.w, b.w) * 0.09;
  if (f.mode === 'row') {
    const dir = bi > ai ? 1 : -1;
    const y = a.y + a.h;
    const x1 = a.x + a.w / 2 + dir * spread * hops;
    const x2 = b.x + b.w / 2 - dir * spread * hops;
    const depth = ((f.band - 6) * (0.4 + 0.2 * hops)) / 0.75;
    return `M${x1} ${y}C${x1} ${y + depth},${x2} ${y + depth},${x2} ${y}`;
  }
  const dir = bi > ai ? 1 : -1;
  const x = a.x;
  const y1 = a.y + a.h / 2 + dir * spread * hops * 0.6;
  const y2 = b.y + b.h / 2 - dir * spread * hops * 0.6;
  const depth = f.band * (0.4 + 0.2 * hops) / 0.75;
  return `M${x} ${y1}C${x - depth} ${y1},${x - depth} ${y2},${x} ${y2}`;
}

/** HQ lines run down from the HQ element into each device. */
export function hqPath(f: Frame, slot: Box): string {
  const r = 10;
  if (f.mode === 'row') {
    const x = slot.x + slot.w / 2;
    const mid = slot.y * 0.5;
    const dir = Math.sign(x - f.hq.x);
    if (Math.abs(x - f.hq.x) < r * 2) return `M${f.hq.x} ${f.hq.y}L${x} ${slot.y}`;
    return `M${f.hq.x} ${f.hq.y}V${mid - r}Q${f.hq.x} ${mid},${f.hq.x + dir * r} ${mid}H${x - dir * r}Q${x} ${mid},${x} ${mid + r}V${slot.y}`;
  }
  const edge = slot.x + slot.w;
  const rail = f.width - 8;
  const y = slot.y + slot.h / 2;
  return `M${f.hq.x} ${f.hq.y}V${10 - r}Q${f.hq.x} 10,${f.hq.x + r} 10H${rail - r}Q${rail} 10,${rail} ${10 + r}V${y - r}Q${rail} ${y},${rail - r} ${y}H${edge}`;
}
