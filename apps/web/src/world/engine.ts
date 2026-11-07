import type { ActorId, Point, TaskId } from '@afterlink/protocol';
import type { StageCarry, StageDevice, StageEvent, StageLink, StageState } from '../stage/contract';
import { teamColor } from '../ui/team';
import { ago, pairKey, read, restPoints, type PinView, type Reading } from './knowledge';
import { flag, label, mistTile, person, readInk, resolve, scissors, type Ink } from './paint';
import { Router, TOWER, toPx, toSite, towerLamp, type Frame } from './site';

const WALK = 6.4;
const STROLL = 1.1;
const CHEST = 11;
const TRAIL_MS = 420;
const COMET_MS = 760;
const RECOIL_MS = 520;
const GROW_MS = 620;
const SNIP_WAIT_MS = 3000;
const LABEL_MS = 6500;
const MATE_SPOTS: Point[] = [
  { x: -2.1, y: 1.4 },
  { x: 2.0, y: 1.9 },
];

export type Hit = { kind: 'courier'; id: ActorId } | { kind: 'team'; id: ActorId } | { kind: 'tower' } | { kind: 'pin'; id: TaskId } | null;

export interface Note {
  id: string;
  at: Point;
  text: string;
  tone: 'stop' | 'ok';
}

interface Mate {
  x: number;
  y: number;
  step: number;
  moving: boolean;
  facing: number;
}

interface Figure {
  id: ActorId;
  name: string;
  colour: string;
  pos: Point;
  route: Point[];
  leg: number;
  goalKey: string;
  moving: boolean;
  hurried: boolean;
  facing: number;
  step: number;
  crumbs: Point[];
  mates: Mate[];
  strollAt: number;
  shown: number;
  ghostShown: number;
  ghostAt: Point | null;
  heardAt: number | null;
  px: Point;
}

interface PinSprite {
  id: TaskId;
  view: PinView;
  colour: string;
  born: number;
  known: number;
  pop: number;
  dx: number;
}

interface Thread {
  link: StageLink;
  key: string;
  shown: number;
  sign: number;
  phase: number;
  a: Point;
  c: Point;
  b: Point;
  pts: Point[];
  snipAt: number | null;
  snipT: number;
  recoilAt: number | null;
  growAt: number | null;
}

interface Comet {
  key: string;
  forward: boolean;
  start: number;
}

interface Beam {
  id: ActorId;
  reach: number;
}

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  born: number;
  colour: string;
}

interface Ripple {
  at: Point;
  born: number;
  colour: string;
}

interface Courier {
  from: ActorId;
  to: ActorId;
  pos: Point;
  route: Point[];
  leg: number;
  speed: number;
  step: number;
  facing: number;
  arrived: boolean;
}

interface Hole {
  x: number;
  y: number;
  r: number;
  s: number;
  want: number;
}

const stepAlong = (v: number, target: number, rate: number, dt: number) => v + (target - v) * (1 - Math.exp(-dt * rate));
const ease = (t: number) => 1 - (1 - t) ** 3;
const back = (t: number) => {
  const k = 1.70158;
  return 1 + (k + 1) * (t - 1) ** 3 + k * (t - 1) ** 2;
};

const hash = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
};

function crossing(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
  if (d === 0) return false;
  const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
  const u = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

const curveAt = (a: Point, c: Point, b: Point, t: number): Point => {
  const m = 1 - t;
  return { x: m * m * a.x + 2 * m * t * c.x + t * t * b.x, y: m * m * a.y + 2 * m * t * c.y + t * t * b.y };
};

/** The moving layer of the map. It animates toward reported state and never invents any. */
export class Engine {
  private c: CanvasRenderingContext2D;
  private frame: Frame | null = null;
  private dpr = 1;
  private ink: Ink;
  private raf = 0;
  private last = 0;
  private reduced = false;
  private router = new Router();
  private state: StageState | null = null;
  private reading: Reading | null = null;
  private rest = new Map<ActorId, Point>();
  private figures = new Map<ActorId, Figure>();
  private pins = new Map<TaskId, PinSprite>();
  private threads = new Map<string, Thread>();
  private beams = new Map<ActorId, Beam>();
  private comets: Comet[] = [];
  private hqBlips: { id: ActorId; start: number }[] = [];
  private sparks: Spark[] = [];
  private ripples: Ripple[] = [];
  private blade: { x: number; y: number; t: number }[] = [];
  private bladeDown = false;
  private courier: Courier | null = null;
  private qr: HTMLCanvasElement = document.createElement('canvas');
  private qrReady = false;
  private carried: { to: ActorId; text: string; until: number } | null = null;
  private lens: ActorId | null = null;
  private lensAmt = 0;
  private splitAmt = 0;
  private lamp = 0;
  private blink = 0;
  private fog: HTMLCanvasElement = document.createElement('canvas');
  private fogC: CanvasRenderingContext2D;
  private mist: CanvasPattern | null = null;
  private holes = new Map<string, Hole>();
  private anchors = new Map<string, HTMLElement>();
  private hover: Hit = null;
  private drag: { from: Point; to: Point; colour: string; target: ActorId | null; courier: boolean } | null = null;
  private walkTick = 0;

  /** Set by the map. */
  arrived: () => void = () => undefined;
  step: () => void = () => undefined;

  constructor(
    private canvas: HTMLCanvasElement,
    private root: HTMLElement,
  ) {
    this.c = canvas.getContext('2d')!;
    this.fogC = this.fog.getContext('2d')!;
    this.ink = readInk(root);
    this.qr.width = this.qr.height = 1;
  }

  start() {
    const loop = (now: number) => {
      this.tick(now);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this.raf);
  }

  retheme() {
    this.ink = readInk(this.root);
    for (const f of this.figures.values()) f.colour = this.teamInk(f.id);
    this.mist = null;
  }

  setReduced(on: boolean) {
    this.reduced = on;
  }

  setFrame(frame: Frame, dpr: number) {
    this.frame = frame;
    this.dpr = dpr;
    this.canvas.width = Math.round(frame.width * dpr);
    this.canvas.height = Math.round(frame.height * dpr);
    this.canvas.style.width = `${frame.width}px`;
    this.canvas.style.height = `${frame.height}px`;
    this.fog.width = Math.ceil(frame.width / 5);
    this.fog.height = Math.ceil(frame.height / 5);
    this.mist = null;
  }

  bindAnchor(key: string, el: HTMLElement | null) {
    if (el) this.anchors.set(key, el);
    else this.anchors.delete(key);
  }

  setLens(id: ActorId | null) {
    if (this.lens === id) return;
    this.lens = id;
    this.reread();
  }

  private teamInk(id: ActorId): string {
    const d = this.state?.seats.find((x) => x.id === id);
    return d ? resolve(this.root, teamColor(d.team)) : this.ink.muted;
  }

  private reread() {
    if (!this.state) return;
    this.reading = read(this.state, this.lens);
    const known = new Map(this.reading.pins.map((p) => [p.id, p]));
    for (const p of this.reading.pins) {
      const sprite = this.pins.get(p.id);
      if (sprite) sprite.view = p;
      else this.pins.set(p.id, { id: p.id, view: p, colour: '', born: performance.now(), known: 0, pop: 0, dx: 0 });
    }
    for (const sprite of this.pins.values()) {
      const p = known.get(sprite.id);
      sprite.colour = sprite.view.owner ? this.teamInk(sprite.view.owner) : this.ink.ink;
      if (p) sprite.colour = p.owner ? this.teamInk(p.owner) : this.ink.ink;
    }
    this.slotPins();
  }

  private slotPins() {
    const here = new Map<string, PinSprite[]>();
    for (const s of this.pins.values()) {
      const k = `${Math.round(s.view.at.x / 2)},${Math.round(s.view.at.y / 2)}`;
      here.set(k, [...(here.get(k) ?? []), s]);
    }
    for (const group of here.values()) group.forEach((s, i) => (s.dx = (i - (group.length - 1) / 2) * 19));
  }

  /** Teams walk to what their own device says they are doing. */
  setState(state: StageState) {
    const fresh = this.state?.run !== state.run;
    if (fresh) this.reset();
    this.state = state;
    this.rest = restPoints(state);

    for (const d of state.seats) {
      if (!this.figures.has(d.id)) this.figures.set(d.id, this.spawn(d));
      if (!this.beams.has(d.id)) this.beams.set(d.id, { id: d.id, reach: 0 });
      this.aim(this.figures.get(d.id)!, d);
    }

    for (const l of state.pairs) {
      const key = pairKey(l.a, l.b);
      const t = this.threads.get(key);
      if (t) {
        const was = t.link.state;
        t.link = l;
        if (was !== 'cut' && l.state === 'cut') this.snap(t);
        if (was === 'cut' && l.state === 'open') {
          t.growAt = performance.now();
          t.recoilAt = null;
        }
      } else {
        const h = hash(key);
        const origin = { x: 0, y: 0 };
        this.threads.set(key, { link: l, key, shown: 0, sign: h % 2 ? 1 : -1, phase: h % 360, a: origin, b: origin, c: origin, pts: [], snipAt: null, snipT: 0.5, recoilAt: null, growAt: null });
      }
    }

    this.syncCourier(state.carry);
    this.reread();
  }

  private reset() {
    this.figures.clear();
    this.pins.clear();
    this.threads.clear();
    this.beams.clear();
    this.comets = [];
    this.hqBlips = [];
    this.sparks = [];
    this.ripples = [];
    this.courier = null;
    this.carried = null;
    this.holes.clear();
    this.qrReady = false;
  }

  private spawn(d: StageDevice): Figure {
    const pos = { ...d.home };
    return {
      id: d.id,
      name: d.name,
      colour: resolve(this.root, teamColor(d.team)),
      pos,
      route: [],
      leg: 0,
      goalKey: '',
      moving: false,
      hurried: false,
      facing: 1,
      step: Math.random() * 6,
      crumbs: [],
      mates: MATE_SPOTS.map((m) => ({ x: pos.x + m.x, y: pos.y + m.y, step: Math.random() * 6, moving: false, facing: 1 })),
      strollAt: 0,
      shown: 1,
      ghostShown: 0,
      ghostAt: null,
      heardAt: null,
      px: { x: 0, y: 0 },
    };
  }

  private aim(f: Figure, d: StageDevice) {
    const working = !!d.task;
    const goal = working ? { x: d.goal.x - 1.6, y: d.goal.y + 1.2 } : (this.rest.get(d.id) ?? d.home);
    const key = working ? `t:${d.task!.id}` : `r:${goal.x.toFixed(1)},${goal.y.toFixed(1)}`;
    f.hurried = working && d.task!.status === 'accepted';
    if (key === f.goalKey) return;
    f.goalKey = key;
    if (this.reduced) {
      f.pos = { ...goal };
      f.route = [];
      for (const [i, m] of f.mates.entries()) {
        m.x = goal.x + MATE_SPOTS[i]!.x;
        m.y = goal.y + MATE_SPOTS[i]!.y;
      }
      return;
    }
    f.route = this.router.route(f.pos, goal);
    f.leg = 0;
    f.strollAt = 0;
  }

  private syncCourier(carry: StageCarry | null) {
    if (!carry || carry.phase === 'done' || carry.phase === 'failed') {
      if (carry?.phase === 'failed' && this.courier) this.carried = { to: carry.receiver, text: 'Did not verify', until: performance.now() + 4000 };
      this.courier = null;
      return;
    }
    const from = this.figures.get(carry.sender);
    const to = this.figures.get(carry.receiver);
    if (!from || !to) return;
    if (!this.courier || this.courier.from !== carry.sender) {
      this.courier = { from: carry.sender, to: carry.receiver, pos: { x: from.pos.x + 2.4, y: from.pos.y + 1 }, route: [], leg: 0, speed: 0, step: 0, facing: 1, arrived: false };
      this.qrReady = false;
    }
    const c = this.courier;
    if (carry.phase === 'walking' && !c.route.length && !c.arrived) {
      if (this.reduced) {
        c.pos = { x: to.pos.x + 2.4, y: to.pos.y + 1 };
        c.arrived = true;
        this.arrived();
        return;
      }
      c.route = this.router.route(c.pos, { x: to.pos.x + 2.4, y: to.pos.y + 1 });
      c.leg = 0;
      c.speed = this.length(c.route) / (carry.walkMs / 1000);
    }
    if (carry.phase === 'scanning' && !c.arrived) {
      c.arrived = true;
      c.route = [];
      c.pos = { x: to.pos.x + 2.4, y: to.pos.y + 1 };
    }
  }

  /** On-screen length of a route, in units of 1 percent of the map's width. */
  private length(route: Point[]): number {
    let total = 0;
    for (let i = 1; i < route.length; i++) total += this.span(route[i - 1]!, route[i]!);
    return total;
  }

  private span(a: Point, b: Point): number {
    const k = this.frame ? this.frame.mh / this.frame.mw : 0.6;
    return Math.hypot(a.x - b.x, (a.y - b.y) * k);
  }

  event(e: StageEvent) {
    const now = performance.now();
    switch (e.kind) {
      case 'sync': {
        const t = this.threads.get(pairKey(e.from, e.to));
        if (t && t.link.state === 'open' && this.comets.length < 48) this.comets.push({ key: t.key, forward: e.from === t.link.a, start: now });
        break;
      }
      case 'report':
        if (this.hqBlips.length < 12) this.hqBlips.push({ id: e.actor, start: now });
        this.blink = 1;
        break;
      case 'link': {
        const t = this.threads.get(pairKey(e.a, e.b));
        if (t && e.state === 'cut') this.snap(t);
        break;
      }
      case 'request':
        this.ripples.push({ at: e.point, born: now, colour: this.ink.ink });
        break;
      case 'frame':
        this.paintFrame(e.pixels);
        break;
      case 'carried':
        this.carried = { to: e.to, text: `${e.newEvents} signed ${e.newEvents === 1 ? 'event' : 'events'} verified`, until: now + 5000 };
        break;
      default:
        break;
    }
  }

  private paintFrame(p: { width: number; height: number; data: Uint8ClampedArray }) {
    if (this.qr.width !== p.width) {
      this.qr.width = p.width;
      this.qr.height = p.height;
    }
    this.qr.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(p.data), p.width, p.height), 0, 0);
    this.qrReady = true;
  }

  private snap(t: Thread) {
    const now = performance.now();
    if (t.recoilAt && now - t.recoilAt < RECOIL_MS) return;
    t.recoilAt = now;
    t.snipAt = null;
    const at = t.pts.length ? curveAt(t.a, t.c, t.b, t.snipT) : null;
    if (!at || this.reduced) return;
    for (let i = 0; i < 9; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = 40 + Math.random() * 90;
      this.sparks.push({ x: at.x, y: at.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 20, born: now, colour: i % 2 ? this.ink.fg : this.ink.stop });
    }
  }

  // ---------- Gestures ----------

  hit(x: number, y: number): Hit {
    const f = this.frame;
    if (!f) return null;
    const near = 20 * Math.max(f.u, 0.8) + (f.compact ? 8 : 0);
    if (this.canCarry()) {
      for (const stand of this.stands()) if (Math.hypot(stand.at.x - x, stand.at.y - y) < near * 0.9) return { kind: 'courier', id: stand.id };
    }
    let best: ActorId | null = null;
    let low = near * 1.25;
    for (const g of this.figures.values()) {
      const d = Math.hypot(g.px.x - x, g.px.y - 9 * f.u - y);
      if (d < low) {
        low = d;
        best = g.id;
      }
    }
    if (best) return { kind: 'team', id: best };
    const base = toPx(f, TOWER);
    if (Math.abs(x - base.x) < 26 * f.u + 6 && y < base.y + 8 && y > base.y - 156 * f.u) return { kind: 'tower' };
    for (const p of this.pins.values()) {
      if (p.known < 0.5) continue;
      const at = this.pinPx(p);
      if (Math.hypot(at.x + 3 * f.u - x, at.y - 10 * f.u - y) < 15 * f.u + 2) return { kind: 'pin', id: p.id };
    }
    return null;
  }

  setHover(h: Hit) {
    this.hover = h;
  }

  /** A link under the pointer, for the cursor and for the first touch of a cut. */
  linkNear(x: number, y: number, reach = 12): string | null {
    for (const t of this.threads.values()) {
      if (t.link.state !== 'open') continue;
      for (const p of t.pts) if (Math.hypot(p.x - x, p.y - y) < reach) return t.key;
    }
    return null;
  }

  bladeStart(x: number, y: number) {
    this.bladeDown = true;
    this.blade = [{ x, y, t: performance.now() }];
  }

  /** Extends the cut. Returns links the stroke has just crossed. */
  bladeMove(x: number, y: number): StageLink[] {
    const prev = this.blade[this.blade.length - 1];
    this.blade.push({ x, y, t: performance.now() });
    if (!prev) return [];
    const crossed: StageLink[] = [];
    const now = performance.now();
    for (const t of this.threads.values()) {
      if (t.link.state !== 'open' || t.snipAt !== null || t.shown < 0.5) continue;
      for (let i = 1; i < t.pts.length; i++) {
        if (crossing(prev, { x, y }, t.pts[i - 1]!, t.pts[i]!)) {
          t.snipAt = now;
          t.snipT = i / (t.pts.length - 1);
          crossed.push(t.link);
          break;
        }
      }
    }
    return crossed;
  }

  bladeEnd() {
    this.bladeDown = false;
  }

  beginDrag(from: Point, colour: string, courier: boolean) {
    this.drag = { from, to: from, colour, target: null, courier };
  }

  moveDrag(to: Point, target: ActorId | null) {
    if (this.drag) this.drag = { ...this.drag, to, target };
  }

  endDrag() {
    this.drag = null;
  }

  figureAt(id: ActorId): Point | null {
    return this.figures.get(id)?.px ?? null;
  }

  colourOf(id: ActorId): string {
    return this.figures.get(id)?.colour ?? this.ink.ink;
  }

  /** Where a courier waits: one per group, on the side facing the gap. */
  stands(): { id: ActorId; at: Point }[] {
    const f = this.frame;
    const s = this.state;
    if (!f || !s || s.groups.length < 2) return [];
    const centre = (ids: ActorId[]) => {
      const list = ids.map((id) => this.figures.get(id)?.px).filter((p): p is Point => !!p);
      return { x: list.reduce((a, p) => a + p.x, 0) / (list.length || 1), y: list.reduce((a, p) => a + p.y, 0) / (list.length || 1) };
    };
    const out: { id: ActorId; at: Point }[] = [];
    for (const group of s.groups) {
      const others = centre(s.groups.filter((g) => g !== group).flat());
      let id: ActorId | null = null;
      let low = Infinity;
      for (const a of group) {
        const p = this.figures.get(a)?.px;
        if (!p) continue;
        const d = Math.hypot(p.x - others.x, p.y - others.y);
        if (d < low) {
          low = d;
          id = a;
        }
      }
      if (!id) continue;
      const p = this.figures.get(id)!.px;
      const norm = Math.hypot(others.x - p.x, others.y - p.y) || 1;
      out.push({ id, at: { x: p.x + ((others.x - p.x) / norm) * 30 * f.u, y: p.y + ((others.y - p.y) / norm) * 14 * f.u + 4 * f.u } });
    }
    return out;
  }

  canCarry(): boolean {
    const s = this.state;
    if (!s || s.phase !== 'live' || s.groups.length < 2) return false;
    return !s.carry || s.carry.phase === 'done' || s.carry.phase === 'failed';
  }

  // ---------- The frame ----------

  private tick(now: number) {
    const f = this.frame;
    if (!f) return;
    const dt = Math.min(0.05, (now - this.last) / 1000 || 0);
    this.last = now;
    this.advance(now, dt);
    const c = this.c;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, f.width, f.height);
    this.paintHull(now);
    this.paintFog(now);
    this.paintBeams(now);
    this.paintThreads(now);
    this.paintRipples(now);
    this.paintPins(now);
    this.paintFigures(now);
    this.paintCouriers(now);
    this.paintDrag();
    this.paintComets(now);
    this.paintSparks(now, dt);
    this.paintBlade(now);
    this.place();
  }

  private advance(now: number, dt: number) {
    const f = this.frame!;
    const r = this.reading;
    const liveHq = !!this.state?.hq.alive;
    this.lensAmt = this.reduced ? (this.lens ? 1 : 0) : stepAlong(this.lensAmt, this.lens ? 1 : 0, 7, dt);
    this.splitAmt = stepAlong(this.splitAmt, (this.state?.groups.length ?? 1) > 1 ? 1 : 0, 3, dt);
    this.lamp = stepAlong(this.lamp, liveHq ? 1 : 0, liveHq ? 4 : 9, dt);
    this.blink = stepAlong(this.blink, 0, 7, dt);

    for (const g of this.figures.values()) {
      this.walk(g, dt, now);
      const seen = r?.figures.find((x) => x.id === g.id);
      const live = !seen || seen.live;
      g.shown = stepAlong(g.shown, live ? 1 : 0, 8, dt);
      g.ghostShown = stepAlong(g.ghostShown, live ? 0 : 1, 8, dt);
      if (seen && !seen.live) {
        g.ghostAt = seen.at;
        g.heardAt = seen.heardAt;
      }
      g.px = toPx(f, g.pos);
    }

    for (const p of this.pins.values()) {
      const known = !r || r.pins.some((x) => x.id === p.id);
      p.known = stepAlong(p.known, known ? 1 : 0, 8, dt);
      p.pop = stepAlong(p.pop, 1, 10, dt);
    }

    for (const t of this.threads.values()) this.shape(t, now, dt);

    for (const b of this.beams.values()) {
      const d = this.state?.seats.find((x) => x.id === b.id);
      const want = d?.signalUp ? 1 : 0;
      b.reach = this.reduced ? want : stepAlong(b.reach, want, want ? 2.6 : 5, dt);
    }

    const c = this.courier;
    if (c && c.route.length && !c.arrived) {
      let budget = c.speed * dt;
      c.step += budget * 2.1;
      while (budget > 0 && c.leg < c.route.length - 1) {
        const next = c.route[c.leg + 1]!;
        const gap = this.span(c.pos, next);
        if (gap <= budget) {
          c.pos = { ...next };
          c.leg++;
          budget -= gap;
        } else {
          const k = budget / gap;
          c.facing = next.x >= c.pos.x ? 1 : -1;
          c.pos = { x: c.pos.x + (next.x - c.pos.x) * k, y: c.pos.y + (next.y - c.pos.y) * k };
          budget = 0;
        }
      }
      if (now > this.walkTick) {
        this.walkTick = now + 380;
        this.step();
      }
      if (c.leg >= c.route.length - 1) {
        c.arrived = true;
        c.route = [];
        this.arrived();
      }
    }
  }

  private walk(g: Figure, dt: number, now: number) {
    const before = { ...g.pos };
    const walking = g.leg < g.route.length - 1;
    if (!walking && !this.reduced && now > g.strollAt && g.goalKey.startsWith('r:')) {
      g.strollAt = now + 3200 + Math.random() * 5200;
      const r = this.rest.get(g.id);
      if (r) {
        g.route = [g.pos, { x: r.x + (Math.random() - 0.5) * 4.6, y: r.y + (Math.random() - 0.5) * 5.2 }];
        g.leg = 0;
      }
    }
    const strolling = g.goalKey.startsWith('r:') && g.route.length === 2;
    let budget = (strolling ? STROLL : g.hurried ? WALK * 1.25 : WALK) * dt;
    while (budget > 0 && g.leg < g.route.length - 1) {
      const next = g.route[g.leg + 1]!;
      const gap = this.span(g.pos, next);
      if (gap <= budget) {
        g.pos = { ...next };
        g.leg++;
        budget -= gap;
      } else {
        const k = budget / gap;
        g.pos = { x: g.pos.x + (next.x - g.pos.x) * k, y: g.pos.y + (next.y - g.pos.y) * k };
        budget = 0;
      }
    }
    const moved = this.span(before, g.pos);
    g.moving = moved > 0.001;
    if (g.moving) {
      g.step += moved * (strolling ? 3.2 : 2.3);
      if (Math.abs(g.pos.x - before.x) > 0.002) g.facing = g.pos.x > before.x ? 1 : -1;
      const head = g.crumbs[0];
      if (!head || this.span(head, g.pos) > 0.4) {
        g.crumbs.unshift({ ...g.pos });
        if (g.crumbs.length > 16) g.crumbs.pop();
      }
    }
    g.mates.forEach((m, i) => {
      const spot = MATE_SPOTS[i]!;
      const crumb = g.moving ? g.crumbs[(i + 1) * 4] : null;
      const tx = crumb ? crumb.x : g.pos.x + spot.x;
      const ty = crumb ? crumb.y : g.pos.y + spot.y;
      const dx = tx - m.x;
      const dy = ty - m.y;
      const gap = Math.hypot(dx, dy);
      m.moving = gap > 0.22;
      if (this.reduced) {
        m.x = tx;
        m.y = ty;
        return;
      }
      if (m.moving) {
        const k = 1 - Math.exp(-dt * 5);
        m.x += dx * k;
        m.y += dy * k;
        m.step += gap * k * 2.4;
        if (Math.abs(dx) > 0.03) m.facing = dx > 0 ? 1 : -1;
      }
    });
  }

  private shape(t: Thread, now: number, dt: number) {
    const f = this.frame!;
    const a = this.figures.get(t.link.a);
    const b = this.figures.get(t.link.b);
    if (!a || !b) return;
    t.a = { x: a.px.x, y: a.px.y - CHEST * f.u };
    t.b = { x: b.px.x, y: b.px.y - CHEST * f.u };
    const dx = t.b.x - t.a.x;
    const dy = t.b.y - t.a.y;
    const length = Math.hypot(dx, dy) || 1;
    const breath = this.reduced ? 1 : 1 + 0.07 * Math.sin(now / 1900 + t.phase);
    const sag = length * 0.085 * t.sign * breath;
    t.c = { x: (t.a.x + t.b.x) / 2 + (-dy / length) * sag, y: (t.a.y + t.b.y) / 2 + (dx / length) * sag };
    const pts: Point[] = [];
    for (let i = 0; i <= 18; i++) pts.push(curveAt(t.a, t.c, t.b, i / 18));
    t.pts = pts;
    const r = this.reading;
    const visible = !r?.links || r.links.has(t.key);
    t.shown = stepAlong(t.shown, visible ? 1 : 0, 8, dt);
    if (t.snipAt !== null && now - t.snipAt > SNIP_WAIT_MS) t.snipAt = null;
  }

  private partial(t: Thread, from: number, to: number) {
    const c = this.c;
    const steps = 14;
    c.beginPath();
    for (let i = 0; i <= steps; i++) {
      const p = curveAt(t.a, t.c, t.b, from + ((to - from) * i) / steps);
      if (i) c.lineTo(p.x, p.y);
      else c.moveTo(p.x, p.y);
    }
  }

  private paintThreads(now: number) {
    const c = this.c;
    const f = this.frame!;
    const ink = this.ink;
    c.lineCap = 'round';
    for (const t of this.threads.values()) {
      if (!t.pts.length || t.shown < 0.02) continue;
      const fa = this.figures.get(t.link.a)!;
      const fb = this.figures.get(t.link.b)!;
      const gradient = c.createLinearGradient(t.a.x, t.a.y, t.b.x, t.b.y);
      gradient.addColorStop(0, fa.colour);
      gradient.addColorStop(1, fb.colour);
      const fade = t.shown * Math.min(fa.shown, fb.shown) ** 0.5;
      const recoil = t.recoilAt === null ? 1 : Math.min(1, (now - t.recoilAt) / RECOIL_MS);

      if (t.link.state === 'open') {
        const grow = t.growAt === null ? 1 : Math.min(1, (now - t.growAt) / GROW_MS);
        const reach = ease(grow) / 2;
        const trembling = t.snipAt !== null;
        const wide = trembling ? 0.1 : 0.14;
        const parts: [number, number][] = grow < 1 ? [[0, reach], [1 - reach, 1]] : [[0, 1]];
        for (const [from, to] of parts) {
          this.partial(t, from, to);
          c.strokeStyle = gradient;
          c.globalAlpha = wide * fade;
          c.lineWidth = 6.5 * f.u;
          c.stroke();
          c.globalAlpha = (ink.dark ? 0.85 : 0.72) * fade * (trembling ? 0.45 + 0.4 * Math.sin(now / 24) ** 2 : 1);
          c.lineWidth = Math.max(1.1, 1.5 * f.u);
          c.stroke();
        }
        if (grow < 1) {
          c.globalAlpha = (1 - grow) * fade;
          const mid = curveAt(t.a, t.c, t.b, 0.5);
          c.fillStyle = ink.pulse;
          c.beginPath();
          c.arc(mid.x, mid.y, (2 + 7 * grow) * f.u, 0, Math.PI * 2);
          c.fill();
        }
        c.globalAlpha = 1;
        continue;
      }

      if (t.link.state === 'forming') {
        c.setLineDash([3 * f.u, 7 * f.u]);
        c.lineDashOffset = this.reduced ? 0 : -now / 60;
        this.partial(t, 0, 1);
        c.strokeStyle = gradient;
        c.lineWidth = 1.2;
        c.globalAlpha = 0.6 * fade;
        c.stroke();
        c.setLineDash([]);
        c.lineDashOffset = 0;
        c.globalAlpha = 1;
        continue;
      }

      if (recoil < 1 && !this.reduced) {
        const k = back(recoil);
        const gap = t.snipT;
        c.strokeStyle = gradient;
        c.globalAlpha = 0.8 * (1 - recoil * 0.6) * fade;
        c.lineWidth = Math.max(1.1, 1.5 * f.u);
        this.partial(t, 0, Math.max(0, gap * (1 - k)));
        c.stroke();
        this.partial(t, Math.min(1, gap + (1 - gap) * k), 1);
        c.stroke();
        c.globalAlpha = 1;
        continue;
      }

      c.setLineDash([1, 7 * f.u]);
      this.partial(t, 0.12, 0.88);
      c.strokeStyle = ink.ink;
      c.lineWidth = 1.2;
      c.globalAlpha = (t.link.waitingForHq ? 0.75 : 0.34) * fade;
      c.stroke();
      c.setLineDash([]);
      c.globalAlpha = 1;
      if (t.link.waitingForHq && fade > 0.5) {
        const mid = curveAt(t.a, t.c, t.b, 0.5);
        label(c, 'Waiting for HQ', mid.x, mid.y, 11 * Math.max(f.u, 0.9), ink.muted, ink, 500);
      }
    }
  }

  private paintBeams(now: number) {
    const c = this.c;
    const f = this.frame!;
    const lamp = towerLamp(f);
    const r = this.reading;
    const alive = !!this.state?.hq.alive;
    c.lineCap = 'round';
    for (const b of this.beams.values()) {
      if (b.reach < 0.01) continue;
      if (r?.lens && r.lens !== b.id) continue;
      const g = this.figures.get(b.id);
      if (!g) continue;
      const end = { x: lamp.x + (g.px.x - lamp.x) * b.reach, y: lamp.y + (g.px.y - CHEST * f.u - lamp.y) * b.reach };
      const gradient = c.createLinearGradient(lamp.x, lamp.y, end.x, end.y);
      const tone = this.ink.pulse;
      gradient.addColorStop(0, tone);
      gradient.addColorStop(1, g.colour);
      c.strokeStyle = gradient;
      if (!alive) c.setLineDash([2, 6]);
      c.globalAlpha = (alive ? 0.075 : 0.05) * (1 + this.blink);
      c.lineWidth = 7 * f.u;
      c.beginPath();
      c.moveTo(lamp.x, lamp.y);
      c.lineTo(end.x, end.y);
      c.stroke();
      c.globalAlpha = alive ? 0.32 : 0.24;
      c.lineWidth = 1;
      c.stroke();
      c.setLineDash([]);
    }
    c.globalAlpha = 1;

    this.hqBlips = this.hqBlips.filter((p) => {
      const t = (now - p.start) / 900;
      if (t >= 1) return false;
      if (this.reduced || (r?.lens && r.lens !== p.id)) return true;
      const g = this.figures.get(p.id);
      if (!g) return false;
      const k = ease(t);
      const x = g.px.x + (lamp.x - g.px.x) * k;
      const y = g.px.y - CHEST * f.u + (lamp.y - (g.px.y - CHEST * f.u)) * k;
      c.globalAlpha = Math.min(1, (1 - t) * 3) * 0.8;
      c.fillStyle = this.ink.pulse;
      c.beginPath();
      c.arc(x, y, 1.8 * f.u, 0, Math.PI * 2);
      c.fill();
      c.globalAlpha = 1;
      return true;
    });

    const glow = this.lamp * (0.7 + this.blink * 0.3);
    const halo = c.createRadialGradient(lamp.x, lamp.y, 0, lamp.x, lamp.y, 26 * f.u);
    halo.addColorStop(0, this.ink.pulse);
    halo.addColorStop(1, 'transparent');
    c.globalAlpha = 0.5 * glow;
    c.fillStyle = halo;
    c.beginPath();
    c.arc(lamp.x, lamp.y, 26 * f.u, 0, Math.PI * 2);
    c.fill();
    c.globalAlpha = 1;
    c.fillStyle = glow > 0.08 ? this.ink.pulse : this.ink.ink;
    c.strokeStyle = this.ink.ink;
    c.lineWidth = 1;
    c.beginPath();
    c.arc(lamp.x, lamp.y, 2.8 * f.u, 0, Math.PI * 2);
    c.fill();
    c.stroke();
    if (this.hover?.kind === 'tower') {
      const base = toPx(f, TOWER);
      c.strokeStyle = this.ink.fg;
      c.globalAlpha = 0.5;
      c.setLineDash([2, 4]);
      c.beginPath();
      c.ellipse(base.x, base.y + 2, 34 * f.u, 9 * f.u, 0, 0, Math.PI * 2);
      c.stroke();
      c.setLineDash([]);
      c.globalAlpha = 1;
    }
  }

  private pinPx(p: PinSprite): Point {
    const f = this.frame!;
    const at = toPx(f, p.view.at);
    return { x: at.x + p.dx * f.u, y: at.y };
  }

  private paintPins(now: number) {
    const c = this.c;
    const f = this.frame!;
    const ink = this.ink;
    const list = [...this.pins.values()].sort((a, b) => a.view.at.y - b.view.at.y);
    for (const p of list) {
      if (p.known < 0.02) continue;
      const at = this.pinPx(p);
      const s = f.u * (0.72 + 0.28 * back(Math.min(1, p.pop))) * (f.compact ? 1.25 : 1);
      const v = p.view;
      const done = v.status === 'completed';
      c.globalAlpha = p.known * (done ? 0.68 : v.ghost ? 0.5 : 1);
      if ((v.status === 'open' || v.status === 'deferred') && !this.reduced) {
        const t = (now % 2200) / 2200;
        c.strokeStyle = ink.ink;
        c.lineWidth = 1;
        c.globalAlpha = p.known * (1 - t) * 0.5;
        c.beginPath();
        c.ellipse(at.x, at.y, (5 + 15 * t) * s, (1.8 + 5.4 * t) * s, 0, 0, Math.PI * 2);
        c.stroke();
        c.globalAlpha = p.known;
      }
      if (v.status === 'accepted' && !this.reduced) {
        const a = now / 700;
        c.strokeStyle = p.colour;
        c.lineWidth = 1.4 * s;
        c.beginPath();
        c.ellipse(at.x, at.y, 9 * s, 3.2 * s, 0, a, a + 2.2);
        c.stroke();
      }
      flag(c, at.x, at.y, s, v.status, p.colour, ink, now, this.reduced);
      const fresh = now - p.born < LABEL_MS && !done;
      const hovered = this.hover?.kind === 'pin' && this.hover.id === p.id;
      if (fresh || hovered || (v.ghost && p.known > 0.5)) {
        const size = Math.max(11, 11.5 * f.u);
        const text = v.ghost && v.heardAt ? `${v.title}, ${ago(Date.now() - v.heardAt)}` : v.title;
        c.globalAlpha = p.known * (hovered || v.ghost ? 1 : Math.min(1, (LABEL_MS - (now - p.born)) / 700));
        label(c, text, at.x, at.y + 11 * s, size, v.ghost ? ink.muted : ink.fg, ink, 500);
      }
      c.globalAlpha = 1;
    }
  }

  private paintFigures(now: number) {
    const c = this.c;
    const f = this.frame!;
    const ink = this.ink;
    const s = f.u * (f.compact ? 1.2 : 1.02);
    const order = [...this.figures.values()].sort((a, b) => a.pos.y - b.pos.y);
    for (const g of order) {
      const hovered = (this.hover?.kind === 'team' && this.hover.id === g.id) || this.lens === g.id || this.drag?.target === g.id;
      if (g.ghostShown > 0.02 && g.ghostAt) {
        const at = toPx(f, g.ghostAt);
        c.globalAlpha = 0.42 * g.ghostShown;
        person(c, at.x, at.y, s, g.colour, ink, 0, false, 1);
        person(c, at.x - 11 * f.u, at.y + 4 * f.u, s * 0.94, g.colour, ink, 0, false, 1);
        c.globalAlpha = 0.9 * g.ghostShown;
        const size = Math.max(11, 11.5 * f.u);
        label(c, g.name, at.x, at.y + 11 * s, size, g.colour, ink);
        label(c, g.heardAt ? ago(Date.now() - g.heardAt) : 'Not heard from', at.x, at.y + 11 * s + size * 1.2, size * 0.92, ink.muted, ink, 500);
        c.globalAlpha = 1;
      }
      if (g.shown < 0.02) continue;
      c.globalAlpha = g.shown;
      if (hovered) {
        c.strokeStyle = g.colour;
        c.lineWidth = 1.2;
        c.globalAlpha = g.shown * 0.65;
        c.beginPath();
        c.ellipse(g.px.x, g.px.y + 1, 22 * f.u, 8 * f.u, 0, 0, Math.PI * 2);
        c.stroke();
        c.globalAlpha = g.shown;
      }
      const mates = g.mates.map((m) => ({ ...toPx(f, m), m }));
      for (const m of mates) if (m.y < g.px.y) person(c, m.x, m.y, s * 0.93, g.colour, ink, m.m.step, m.m.moving, m.m.facing);
      person(c, g.px.x, g.px.y, s, g.colour, ink, g.step, g.moving, g.facing);
      for (const m of mates) if (m.y >= g.px.y) person(c, m.x, m.y, s * 0.93, g.colour, ink, m.m.step, m.m.moving, m.m.facing);
      const size = Math.max(11.5, 12.5 * f.u);
      label(c, g.name, g.px.x, g.px.y + 11 * s + 4 * f.u, size, g.colour, ink);
      c.globalAlpha = 1;
      if (this.carried?.to === g.id) {
        if (now > this.carried.until) this.carried = null;
        else label(c, this.carried.text, g.px.x, g.px.y - 28 * f.u, size, ink.ok, ink);
      }
    }
  }

  private paintCouriers(now: number) {
    const c = this.c;
    const f = this.frame!;
    const ink = this.ink;
    const s = f.u * (f.compact ? 1.2 : 1);
    if (this.canCarry() && !this.lens && !this.drag?.courier) {
      c.globalAlpha = this.splitAmt;
      for (const stand of this.stands()) {
        const hovered = this.hover?.kind === 'courier' && this.hover.id === stand.id;
        const hop = this.reduced ? 0 : Math.max(0, Math.sin(now / 420)) ** 8 * 2.5 * f.u;
        person(c, stand.at.x, stand.at.y - hop, s * 0.98, ink.fg, ink, 0, false, 1, true);
        if (hovered) label(c, 'Courier', stand.at.x, stand.at.y + 11 * f.u, 11.5 * Math.max(f.u, 0.9), ink.fg, ink, 500);
      }
      c.globalAlpha = 1;
    }
    const k = this.courier;
    if (!k) return;
    const carry = this.state?.carry;
    const at = toPx(f, k.pos);
    const moving = k.route.length > 0 && !k.arrived;
    person(c, at.x, at.y, s, ink.fg, ink, k.step, moving, k.facing, true);
    const size = 46 * f.u * (f.compact ? 1.3 : 1);
    const bob = moving ? Math.abs(Math.sin(k.step)) * 1.4 : 0;
    const x = at.x - size / 2;
    const y = at.y - 24 * f.u - size - bob;
    c.fillStyle = '#ffffff';
    c.strokeStyle = ink.ink;
    c.lineWidth = 1;
    c.beginPath();
    c.roundRect(x - 3, y - 3, size + 6, size + 6, 4);
    c.fill();
    c.stroke();
    if (this.qrReady) {
      c.imageSmoothingEnabled = false;
      c.drawImage(this.qr, x, y, size, size);
      c.imageSmoothingEnabled = true;
    }
    if (carry && carry.total > 0 && carry.phase === 'scanning') {
      const tSize = Math.max(11, 11.5 * f.u);
      label(c, `${carry.have} of ${carry.total}`, at.x, y - 11, tSize, ink.fg, ink, 600);
    }
  }

  private paintDrag() {
    const d = this.drag;
    if (!d) return;
    const c = this.c;
    const f = this.frame!;
    const to = d.target ? (this.figures.get(d.target)?.px ?? d.to) : d.to;
    c.strokeStyle = d.colour;
    c.lineWidth = 1.6;
    c.lineCap = 'round';
    c.setLineDash([2, 6]);
    c.beginPath();
    c.moveTo(d.from.x, d.from.y);
    c.lineTo(to.x, to.y - (d.target ? CHEST * f.u : 0));
    c.stroke();
    c.setLineDash([]);
    if (d.courier) person(c, d.to.x, d.to.y + 8 * f.u, f.u, this.ink.fg, this.ink, 0, false, 1, true);
  }

  private paintComets(now: number) {
    const c = this.c;
    const f = this.frame!;
    this.comets = this.comets.filter((m) => {
      const t = this.threads.get(m.key);
      const age = (now - m.start) / COMET_MS;
      if (!t || age >= 1 || t.link.state !== 'open') return false;
      if (t.shown < 0.1) return true;
      if (this.reduced) {
        c.globalAlpha = 1 - age;
        c.strokeStyle = this.ink.pulse;
        c.lineWidth = 3 * f.u;
        this.partial(t, 0, 1);
        c.stroke();
        c.globalAlpha = 1;
        return true;
      }
      const head = ease(age);
      for (let i = 0; i < 6; i++) {
        const k = head - i * 0.022;
        if (k < 0) break;
        const p = curveAt(t.a, t.c, t.b, m.forward ? k : 1 - k);
        c.globalAlpha = (1 - i / 6) * Math.min(1, (1 - age) * 4) * t.shown;
        c.fillStyle = i ? this.colourAlong(t, m.forward ? k : 1 - k) : this.ink.pulse;
        c.beginPath();
        c.arc(p.x, p.y, (i ? 2.5 - i * 0.28 : 2.9) * f.u, 0, Math.PI * 2);
        c.fill();
      }
      c.globalAlpha = 1;
      return true;
    });
  }

  private colourAlong(t: Thread, k: number): string {
    return this.figures.get(k < 0.5 ? t.link.a : t.link.b)?.colour ?? this.ink.ink;
  }

  private paintSparks(now: number, dt: number) {
    const c = this.c;
    this.sparks = this.sparks.filter((p) => {
      const age = (now - p.born) / 480;
      if (age >= 1) return false;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 180 * dt;
      c.globalAlpha = 1 - age;
      c.fillStyle = p.colour;
      c.fillRect(p.x - 1, p.y - 1, 2, 2);
      c.globalAlpha = 1;
      return true;
    });
  }

  private paintRipples(now: number) {
    const c = this.c;
    const f = this.frame!;
    this.ripples = this.ripples.filter((r) => {
      const t = (now - r.born) / 900;
      if (t >= 1) return false;
      if (this.reduced) return true;
      const at = toPx(f, r.at);
      c.strokeStyle = r.colour;
      c.lineWidth = 1;
      c.globalAlpha = 1 - t;
      c.beginPath();
      c.ellipse(at.x, at.y, 34 * ease(t) * f.u, 12 * ease(t) * f.u, 0, 0, Math.PI * 2);
      c.stroke();
      c.globalAlpha = 1;
      return true;
    });
  }

  private paintBlade(now: number) {
    const c = this.c;
    const f = this.frame!;
    this.blade = this.blade.filter((p) => now - p.t < TRAIL_MS);
    if (this.blade.length > 1) {
      c.lineCap = 'round';
      c.strokeStyle = this.ink.fg;
      for (let i = 1; i < this.blade.length; i++) {
        const a = this.blade[i - 1]!;
        const b = this.blade[i]!;
        const life = 1 - (now - b.t) / TRAIL_MS;
        c.globalAlpha = life * 0.75;
        c.lineWidth = 0.6 + life * 1.8;
        c.beginPath();
        c.moveTo(a.x, a.y);
        c.lineTo(b.x, b.y);
        c.stroke();
      }
      c.globalAlpha = 1;
    }
    const head = this.blade[this.blade.length - 1];
    const prev = this.blade[Math.max(0, this.blade.length - 4)];
    if (this.bladeDown && head && prev && this.blade.length > 2) {
      const angle = Math.atan2(head.y - prev.y, head.x - prev.x);
      scissors(c, head.x, head.y, f.u * 1.05, angle, 0.5 + 0.5 * Math.sin(now / 45), this.ink);
    }
  }

  private paintHull(now: number) {
    const s = this.state;
    const a = this.splitAmt * (1 - this.lensAmt);
    if (!s || a < 0.02) return;
    const fc = this.fogC;
    const f = this.frame!;
    const k = this.fog.width / f.width;
    fc.setTransform(1, 0, 0, 1, 0, 0);
    fc.clearRect(0, 0, this.fog.width, this.fog.height);
    fc.globalCompositeOperation = 'source-over';
    fc.globalAlpha = 1;
    const radius = 112 * f.u * k;
    for (const group of s.groups) {
      const list = group.map((id) => this.figures.get(id)?.px).filter((p): p is Point => !!p);
      for (const p of list) this.softDisc(fc, p.x * k, (p.y - 8 * f.u) * k, radius, this.ink.hull);
      for (let i = 1; i < list.length; i++) {
        const p = list[i - 1]!;
        const q = list[i]!;
        const n = Math.ceil(Math.hypot(p.x - q.x, p.y - q.y) / 46);
        for (let j = 1; j < n; j++) this.softDisc(fc, (p.x + ((q.x - p.x) * j) / n) * k, (p.y + ((q.y - p.y) * j) / n) * k, radius * 0.8, this.ink.hull);
      }
    }
    const c = this.c;
    c.globalAlpha = a * (0.86 + (this.reduced ? 0 : 0.04 * Math.sin(now / 2400)));
    c.imageSmoothingEnabled = true;
    c.drawImage(this.fog, 0, 0, f.width, f.height);
    c.globalAlpha = 1;
  }

  private softDisc(c: CanvasRenderingContext2D, x: number, y: number, r: number, colour: string) {
    const g = c.createRadialGradient(x, y, r * 0.15, x, y, r);
    g.addColorStop(0, colour);
    g.addColorStop(1, 'transparent');
    c.fillStyle = g;
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.fill();
  }

  private paintFog(now: number) {
    if (this.lensAmt < 0.01) {
      if (!this.lens) this.holes.clear();
      return;
    }
    const f = this.frame!;
    const fc = this.fogC;
    const k = this.fog.width / f.width;
    const want = new Map<string, { x: number; y: number; r: number; w: number }>();
    const r = this.reading;
    const base = Math.min(f.mw, f.mh * 1.5);
    if (r?.lens) {
      for (const seen of r.figures) {
        const g = this.figures.get(seen.id);
        if (!g) continue;
        if (seen.live) want.set(`f${g.id}`, { x: g.px.x, y: g.px.y - 8 * f.u, r: base * (g.id === r.lens ? 0.2 : 0.13), w: 1 });
        else if (seen.at) {
          const at = toPx(f, seen.at);
          want.set(`f${g.id}`, { x: at.x, y: at.y - 8 * f.u, r: base * 0.075, w: 0.45 });
        }
      }
      for (const p of r.pins) {
        const at = toPx(f, p.at);
        want.set(`p${p.id}`, { x: at.x, y: at.y - 8 * f.u, r: base * (p.status === 'completed' ? 0.05 : 0.075), w: p.ghost ? 0.45 : 0.85 });
      }
      if (r.signalUp) {
        const lamp = towerLamp(f);
        want.set('tower', { x: lamp.x, y: lamp.y + 70 * f.u, r: base * 0.13, w: 1 });
      }
    }
    for (const [key, w] of want) {
      const h = this.holes.get(key);
      if (h) {
        h.x = w.x;
        h.y = w.y;
        h.r = w.r;
        h.want = w.w;
      } else this.holes.set(key, { x: w.x, y: w.y, r: w.r, s: this.reduced ? w.w : 0, want: w.w });
    }
    for (const [key, h] of this.holes) {
      if (!want.has(key)) h.want = 0;
      h.s += (h.want - h.s) * (this.reduced ? 1 : 0.12);
      if (h.s < 0.01 && h.want === 0) this.holes.delete(key);
    }

    this.mist ??= fc.createPattern(mistTile(), 'repeat');
    fc.setTransform(1, 0, 0, 1, 0, 0);
    fc.globalCompositeOperation = 'source-over';
    fc.globalAlpha = 1;
    fc.clearRect(0, 0, this.fog.width, this.fog.height);
    fc.fillStyle = this.ink.fog;
    fc.fillRect(0, 0, this.fog.width, this.fog.height);
    fc.globalCompositeOperation = 'destination-out';
    if (this.mist) {
      const drift = this.reduced ? 0 : now / 260;
      this.mist.setTransform(new DOMMatrix([1.6, 0, 0, 1.6, drift, drift * 0.4]));
      fc.fillStyle = this.mist;
      fc.globalAlpha = 0.34;
      fc.fillRect(0, 0, this.fog.width, this.fog.height);
    }
    for (const h of this.holes.values()) {
      const g = fc.createRadialGradient(h.x * k, h.y * k, h.r * k * 0.3, h.x * k, h.y * k, h.r * k);
      g.addColorStop(0, '#000');
      g.addColorStop(1, 'transparent');
      fc.fillStyle = g;
      fc.globalAlpha = h.s;
      fc.beginPath();
      fc.arc(h.x * k, h.y * k, h.r * k, 0, Math.PI * 2);
      fc.fill();
    }
    const c = this.c;
    c.globalAlpha = this.lensAmt;
    c.imageSmoothingEnabled = true;
    c.drawImage(this.fog, 0, 0, f.width, f.height);
    c.globalAlpha = 1;
  }

  /** Keeps the focusable controls over the things they act on. */
  private place() {
    const f = this.frame!;
    for (const g of this.figures.values()) this.anchors.get(`team:${g.id}`)?.style.setProperty('transform', `translate(${g.px.x}px, ${g.px.y - 9 * f.u}px)`);
    for (const t of this.threads.values()) {
      if (!t.pts.length) continue;
      const mid = t.pts[9]!;
      this.anchors.get(`link:${t.key}`)?.style.setProperty('transform', `translate(${mid.x}px, ${mid.y}px)`);
    }
  }

  siteOf(x: number, y: number): Point {
    return toSite(this.frame!, x, y);
  }
}
