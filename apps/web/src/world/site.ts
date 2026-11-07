import type { Point } from '@afterlink/protocol';

/** Fixed features of the site, in the same 0..100 coordinates tasks use. */
export const PLACES = {
  northGate: { x: 50, y: 6 },
  westGate: { x: 6, y: 50 },
  upperStand: { x: 30, y: 16 },
  mainStage: { x: 50, y: 28 },
  firstAid: { x: 30, y: 34 },
  accessHub: { x: 70, y: 36 },
  sportsHall: { x: 88, y: 22 },
  sportsField: { x: 14, y: 24 },
  foodCourt: { x: 50, y: 56 },
  quietTent: { x: 68, y: 56 },
  supplyDepot: { x: 24, y: 72 },
  workshop: { x: 78, y: 72 },
  ticketQueue: { x: 50, y: 88 },
} as const;

export const TOWER: Point = { x: 96.5, y: 56 };

const P = PLACES;
const pt = (x: number, y: number): Point => ({ x, y });
const crossing = pt(50, 44);
const westFork = pt(17, 50);
const westRoad = pt(29, 45);
const eastRoad = pt(82, 43);
const eastJunction = pt(70, 43);
const northFork = pt(50, 14);
const leftArm = pt(39, 21);
const rightArm = pt(61, 21);
const leftBend = pt(37, 30);

/** Walkways. Each runs between junctions, and teams follow them. */
export const WALKWAYS: Point[][] = [
  [P.northGate, northFork],
  [northFork, pt(44, 16), leftArm],
  [northFork, pt(56, 16), rightArm],
  [leftArm, leftBend],
  [leftBend, pt(42, 40), crossing],
  [rightArm, pt(63, 30), pt(58, 40), crossing],
  [crossing, pt(50, 37), P.mainStage],
  [leftArm, pt(34, 18), P.upperStand],
  [P.westGate, westFork],
  [westFork, pt(23, 48), westRoad],
  [westRoad, pt(38, 45), crossing],
  [westRoad, pt(29, 39), P.firstAid],
  [P.firstAid, pt(34, 32), leftBend],
  [P.firstAid, pt(22, 34), pt(16, 30), P.sportsField],
  [P.upperStand, pt(22, 20), P.sportsField],
  [crossing, pt(50, 50), P.foodCourt],
  [P.foodCourt, pt(50, 72), P.ticketQueue],
  [crossing, pt(62, 45), eastJunction],
  [eastJunction, P.accessHub],
  [eastJunction, pt(76, 43), eastRoad],
  [eastRoad, pt(88, 34), P.sportsHall],
  [rightArm, pt(72, 19), P.sportsHall],
  [P.foodCourt, pt(59, 57), P.quietTent],
  [P.quietTent, pt(72, 49), eastJunction],
  [westFork, pt(18, 62), P.supplyDepot],
  [P.supplyDepot, pt(33, 83), P.ticketQueue],
  [P.ticketQueue, pt(66, 84), P.workshop],
  [P.workshop, pt(84, 58), eastRoad],
  [P.supplyDepot, pt(37, 63), P.foodCourt],
  [P.quietTent, pt(74, 64), P.workshop],
];

/** Catmull-Rom through the waypoints, as a dense polyline. */
export function smooth(points: Point[], step = 8): Point[] {
  if (points.length < 3) {
    const a = points[0]!;
    const b = points[1]!;
    return Array.from({ length: step + 1 }, (_, i) => ({ x: a.x + ((b.x - a.x) * i) / step, y: a.y + ((b.y - a.y) * i) / step }));
  }
  const out: Point[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[i + 2] ?? p2;
    for (let s = 0; s < step; s++) {
      const t = s / step;
      const t2 = t * t;
      const t3 = t2 * t;
      const at = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (3 * b - a - 3 * c + d) * t3);
      out.push({ x: at(p0.x, p1.x, p2.x, p3.x), y: at(p0.y, p1.y, p2.y, p3.y) });
    }
  }
  out.push(points[points.length - 1]!);
  return out;
}

export interface Frame {
  width: number;
  height: number;
  /** The rectangle the 0..100 site occupies, in pixels. */
  ox: number;
  oy: number;
  mw: number;
  mh: number;
  /** One drawing unit: landmarks and figures keep their proportions at any window shape. */
  u: number;
  compact: boolean;
}

export function frameFor(width: number, height: number, top: number, bottom: number, compact: boolean): Frame {
  const side = compact ? 24 : Math.max(48, width * 0.05);
  const mw = width - side * 2;
  const mh = Math.max(120, height - top - bottom);
  const u = Math.min(1.25, Math.max(0.46, Math.min(mw / 1120, mh / 600)));
  return { width, height, ox: side, oy: top, mw, mh, u, compact };
}

export const toPx = (f: Frame, p: Point): Point => ({ x: f.ox + (p.x / 100) * f.mw, y: f.oy + (p.y / 100) * f.mh });
export const toSite = (f: Frame, x: number, y: number): Point => ({ x: ((x - f.ox) / f.mw) * 100, y: ((y - f.oy) / f.mh) * 100 });

/** Where the tower's lamp sits, in pixels. */
export const towerLamp = (f: Frame): Point => {
  const p = toPx(f, TOWER);
  return { x: p.x, y: p.y - 148 * f.u };
};

const inSite = (v: number) => Math.min(100, Math.max(0, v));

/** The point on site under a click, kept inside the site. */
export const siteAt = (f: Frame, x: number, y: number): Point => {
  const p = toSite(f, x, y);
  return { x: inSite(p.x), y: inSite(p.y) };
};

interface Node {
  at: Point;
  next: { to: number; cost: number }[];
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Shortest walk over the walkways between any two points on site. */
export class Router {
  private nodes: Node[] = [];

  constructor(walkways: Point[][] = WALKWAYS) {
    const index = new Map<string, number>();
    const nodeAt = (p: Point) => {
      const key = `${p.x.toFixed(2)},${p.y.toFixed(2)}`;
      let i = index.get(key);
      if (i === undefined) {
        i = this.nodes.push({ at: p, next: [] }) - 1;
        index.set(key, i);
      }
      return i;
    };
    for (const way of walkways) {
      const line = smooth(way, 5);
      for (let i = 1; i < line.length; i++) {
        const a = nodeAt(line[i - 1]!);
        const b = nodeAt(line[i]!);
        if (a === b) continue;
        const cost = dist(line[i - 1]!, line[i]!);
        this.nodes[a]!.next.push({ to: b, cost });
        this.nodes[b]!.next.push({ to: a, cost });
      }
    }
  }

  private nearest(p: Point): number {
    let best = 0;
    let bestD = Infinity;
    this.nodes.forEach((n, i) => {
      const d = dist(n.at, p);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }

  /** Stepping onto a walkway, along it, and off it at the far end. */
  route(from: Point, to: Point): Point[] {
    const start = this.nearest(from);
    const goal = this.nearest(to);
    const best = new Float64Array(this.nodes.length).fill(Infinity);
    const prev = new Int32Array(this.nodes.length).fill(-1);
    const done = new Uint8Array(this.nodes.length);
    best[start] = 0;
    for (;;) {
      let at = -1;
      let low = Infinity;
      for (let i = 0; i < best.length; i++) {
        if (!done[i] && best[i]! < low) {
          low = best[i]!;
          at = i;
        }
      }
      if (at < 0 || at === goal) break;
      done[at] = 1;
      for (const e of this.nodes[at]!.next) {
        const cost = low + e.cost;
        if (cost < best[e.to]!) {
          best[e.to] = cost;
          prev[e.to] = at;
        }
      }
    }
    const walk: Point[] = [to];
    for (let at = goal; at >= 0; at = prev[at]!) walk.push(this.nodes[at]!.at);
    walk.push(from);
    return walk.reverse();
  }
}
