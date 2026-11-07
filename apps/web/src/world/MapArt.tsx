import { memo, useMemo, type ReactNode } from 'react';
import type { Point } from '@afterlink/protocol';
import { PLACES as P, TOWER, WALKWAYS, smooth, toPx, type Frame } from './site';

function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const f1 = (n: number) => Math.round(n * 10) / 10;

function linePath(points: Point[]): string {
  return points.map((p, i) => `${i ? 'L' : 'M'}${f1(p.x)} ${f1(p.y)}`).join('');
}

function blob(cx: number, cy: number, rx: number, ry: number, seed: number, bumps = 11, rough = 0.1): Point[] {
  const rnd = seeded(seed);
  const ring = Array.from({ length: bumps }, (_, i) => {
    const a = (i / bumps) * Math.PI * 2;
    const r = 1 + (rnd() - 0.5) * 2 * rough;
    return { x: cx + Math.cos(a) * rx * r, y: cy + Math.sin(a) * ry * r };
  });
  return smooth([...ring, ring[0]!, ring[1]!], 5).slice(5, -5);
}

interface Tree {
  at: Point;
  size: number;
  shape: 0 | 1 | 2;
  seed: number;
}

const near = (a: Point, b: Point, rx: number, ry = rx) => ((a.x - b.x) / rx) ** 2 + ((a.y - b.y) / ry) ** 2 < 1;

const KEEP_CLEAR: [Point, number, number][] = [
  [P.mainStage, 13, 12],
  [{ x: 50, y: 37 }, 13, 7],
  [P.firstAid, 5, 7],
  [P.accessHub, 7, 7],
  [P.sportsHall, 10, 12],
  [P.sportsField, 13, 14],
  [P.upperStand, 9, 8],
  [P.foodCourt, 13, 10],
  [P.quietTent, 5, 7],
  [P.supplyDepot, 9, 9],
  [P.workshop, 7, 8],
  [P.ticketQueue, 11, 9],
  [P.northGate, 7, 5],
  [P.westGate, 3, 6],
  [TOWER, 4, 16],
  [{ x: 89, y: 87 }, 11, 10],
];

const GROVES: [number, number, number, number, number][] = [
  [41, 69, 5, 6, 7],
  [62, 70, 6, 6, 8],
  [15, 42, 7, 3, 5],
  [64, 8, 8, 4, 7],
  [36, 8, 7, 3, 5],
  [76, 28, 3, 4, 4],
  [11, 84, 7, 7, 8],
  [33, 57, 4, 3, 3],
  [86, 66, 3, 5, 3],
  [44, 92, 3, 3, 2],
  [74, 90, 4, 4, 4],
];

function plantTrees(): Tree[] {
  const rnd = seeded(20261107);
  const paths = WALKWAYS.flatMap((w) => smooth(w, 6));
  const free = (p: Point) => paths.every((q) => !near(p, q, 2.1, 3.2)) && KEEP_CLEAR.every(([c, rx, ry]) => !near(p, c, rx, ry));
  const trees: Tree[] = [];
  const place = (at: Point, size: number) => {
    if (free(at) && trees.every((t) => !near(at, t.at, 1.7, 2.6))) trees.push({ at, size, shape: rnd() < 0.72 ? 0 : rnd() < 0.6 ? 1 : 2, seed: Math.floor(rnd() * 1e6) });
  };
  for (const [cx, cy, rx, ry, n] of GROVES) {
    for (let i = 0; i < n * 3 && i < 40; i++) {
      const a = rnd() * Math.PI * 2;
      const r = Math.sqrt(rnd());
      place({ x: cx + Math.cos(a) * rx * r, y: cy + Math.sin(a) * ry * r }, 0.72 + rnd() * 0.5);
    }
  }
  for (let i = 0; i < 620; i++) {
    const at = { x: -12 + rnd() * 124, y: -40 + rnd() * 180 };
    const outside = at.x < 1 || at.x > 99 || at.y < 0 || at.y > 99;
    if (outside) place(at, 0.8 + rnd() * 0.65);
  }
  return trees.sort((a, b) => a.at.y - b.at.y);
}

const TREES = plantTrees();

function TreeGlyph({ tree }: { tree: Tree }) {
  const { size, shape, seed } = tree;
  if (shape === 2) {
    return (
      <>
        <ellipse className="a-shadow" cx={2} cy={0} rx={6 * size} ry={2 * size} />
        <path className="a-trunk" d={`M0 0V${-5 * size}`} />
        <path className="a-tree2" d={`M0 ${-3 * size}C${6 * size} ${-9 * size},${5 * size} ${-22 * size},0 ${-30 * size}C${-5 * size} ${-22 * size},${-6 * size} ${-9 * size},0 ${-3 * size}Z`} />
      </>
    );
  }
  const r = (shape === 0 ? 10.5 : 8.5) * size;
  const crown = blob(0, -r * 1.25, r, r * 0.94, seed, 8, 0.1);
  const leaf = seeded(seed + 1);
  const a = leaf() * 2;
  return (
    <>
      <ellipse className="a-shadow" cx={2} cy={0} rx={r * 0.8} ry={r * 0.24} />
      <path className="a-trunk" d={`M0 0V${-r * 0.7}`} />
      <path className={shape === 0 ? 'a-tree' : 'a-tree2'} d={`${linePath(crown)}Z`} />
      <path className="a-leaf" d={`M${f1(-r * 0.45)} ${f1(-r * 1.0 - a)}q${f1(r * 0.25)} ${f1(-r * 0.3)} ${f1(r * 0.55)} ${f1(-r * 0.2)}`} />
    </>
  );
}

const bunting = (x1: number, y1: number, x2: number, y2: number, sag: number, n: number): ReactNode => {
  const flags = Array.from({ length: n }, (_, i) => {
    const t = (i + 0.5) / n;
    const x = x1 + (x2 - x1) * t;
    const y = y1 + (y2 - y1) * t + sag * 4 * t * (1 - t);
    return <path key={i} className={`a-flag a-flag-${i % 3}`} d={`M${f1(x - 2.2)} ${f1(y)}h4.4l-2.2 5z`} />;
  });
  return (
    <>
      <path className="a-thin" d={`M${x1} ${y1}Q${(x1 + x2) / 2} ${(y1 + y2) / 2 + sag * 2} ${x2} ${y2}`} />
      {flags}
    </>
  );
};

function MainStage() {
  return (
    <>
      <ellipse className="a-shadow" cx={4} cy={1} rx={76} ry={8} />
      <path className="a-tint" d="M-52 -9V-54H52V-9Z" />
      <path className="a-body" d="M-62 0V-9H62V0Z" />
      <path className="a-line" d="M-62 -4.5H62" />
      <path className="a-line" d="M-57 -9V-58M57 -9V-58M-52 -9V-58M52 -9V-58" />
      <path className="a-body" d="M-66 -56Q0 -86 66 -56L66 -49Q0 -78 -66 -49Z" />
      <path className="a-thin" d="M-52 -53L-42 -62L-30 -58L-20 -67L-8 -63L0 -70L8 -63L20 -67L30 -58L42 -62L52 -53" />
      <path className="a-body" d="M-76 -9V-40H-65V-9ZM65 -9V-40H76V-9Z" />
      <path className="a-thin" d="M-73 -33h5M-73 -26h5M-73 -19h5M68 -33h5M68 -26h5M68 -19h5" />
      <path className="a-line" d="M0 -74V-92" />
      <path className="a-flag a-flag-0" d="M0 -92l11 3.5l-11 3.5z" />
      <circle className="a-lamp" cx={-30} cy={-50} r={1.6} />
      <circle className="a-lamp" cx={-10} cy={-52} r={1.6} />
      <circle className="a-lamp" cx={10} cy={-52} r={1.6} />
      <circle className="a-lamp" cx={30} cy={-50} r={1.6} />
      <path className="a-line" d="M-108 2V-30M108 2V-30" />
      {bunting(-108, -29, -65, -38, 5, 7)}
      {bunting(65, -38, 108, -29, 5, 7)}
    </>
  );
}

function Tent() {
  return (
    <>
      <ellipse className="a-shadow" cx={3} cy={1} rx={29} ry={4.5} />
      <path className="a-body" d="M-22 0V-14H22V0Z" />
      <path className="a-roof" d="M-25 -13L-10 -28H10L25 -13Z" />
      <path className="a-tint-line" d="M-5 0V-11Q0 -14 5 -11V0Z" />
      <path className="a-line" d="M0 -28V-43" />
      <path className="a-mark" d="M0 -43h12v8H0z" />
      <path className="a-mark-in" d="M6 -41.5v5M3.5 -39h5" />
    </>
  );
}

function Pavilion() {
  return (
    <>
      <ellipse className="a-shadow" cx={3} cy={1} rx={36} ry={5} />
      <path className="a-tint-line" d="M-21 0V-20H21V0Z" />
      <path className="a-line" d="M-8 0V-20M8 0V-20" />
      <path className="a-roof" d="M-29 -19L-23 -28H23L29 -19Z" />
      <path className="a-line" d="M21 0L44 5H36L21 2" />
      <path className="a-line" d="M-34 2V-26" />
      <path className="a-mark2" d="M-44 -33h20v10h-20z" />
    </>
  );
}

function Hall() {
  return (
    <>
      <ellipse className="a-shadow" cx={12} cy={1} rx={72} ry={7} />
      <path className="a-tint-line" d="M56 0L74 -12V-34L56 -22Z" />
      <path className="a-body" d="M-56 0V-22Q0 -44 56 -22V0Z" />
      <path className="a-roof" d="M-56 -22Q0 -44 56 -22L74 -34Q18 -56 -38 -34Z" />
      <path className="a-thin" d="M-44 -28L-27 -39M-26 -33L-9 -44M-6 -36L11 -47M14 -36L31 -47M34 -32L51 -43" />
      <path className="a-tint-line" d="M-7 0V-15H7V0Z" />
      <path className="a-line" d="M0 0V-15" />
      <path className="a-thin" d="M-46 -8v-9h10v9zM-30 -8v-11h10v11zM20 -8v-11h10v11zM36 -8v-9h10v9z" />
      <path className="a-line" d="M-56 0L-82 5H-74L-56 2" />
    </>
  );
}

function Shed() {
  return (
    <>
      <ellipse className="a-shadow" cx={10} cy={1} rx={42} ry={6} />
      <path className="a-roof" d="M0 -32L40 -32L54 -19L18 -19Z" />
      <path className="a-tint-line" d="M18 0V-19H54V0Z" />
      <path className="a-body" d="M-18 0V-19L0 -32L18 -19V0Z" />
      <path className="a-line" d="M-10 0V-14H10V0" />
      <path className="a-thin" d="M0 0V-14M-10 -7H10" />
      <path className="a-thin" d="M26 -7h8v-6h-8zM40 -7h8v-6h-8z" />
      <circle className="a-tint-line" cx={-30} cy={-4} r={4} />
      <circle className="a-tint-line" cx={-38} cy={-4} r={4} />
      <circle className="a-tint-line" cx={-34} cy={-11} r={4} />
    </>
  );
}

function Depot() {
  const crate = (x: number, y: number, s: number) => (
    <path key={`${x},${y}`} className="a-body" d={`M${x} ${y}v${-s}h${s}v${s}zM${x} ${y - s}l${s} ${s}`} />
  );
  return (
    <>
      <ellipse className="a-shadow" cx={6} cy={1} rx={56} ry={6} />
      <path className="a-tint-line" d="M-42 0V-16Q-42 -30 -16 -30H22Q44 -30 44 -14V0Z" />
      <path className="a-thin" d="M-30 -27V0M-14 -30V0M4 -30V0M22 -30V0" />
      <path className="a-body" d="M-14 0V-16H14V0Z" />
      <path className="a-line" d="M0 0V-16" />
      {crate(46, 0, 13)}
      {crate(59, 0, 13)}
      {crate(52, -13, 13)}
      <path className="a-line" d="M-62 -7H-47V-14" />
      <path className="a-body" d="M-64 -2V-9H-48V-2Z" />
      <circle className="a-body" cx={-60} cy={0} r={2.6} />
      <circle className="a-body" cx={-52} cy={0} r={2.6} />
    </>
  );
}

function Stall({ x, y, tone }: { x: number; y: number; tone: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <ellipse className="a-shadow" cx={2} cy={0.5} rx={15} ry={2.6} />
      <path className="a-body" d="M-11 0V-11H11V0Z" />
      <path className="a-line" d="M-11 -5H11" />
      <path className={`a-awn a-awn-${tone}`} d="M-14 -11L-10 -19H10L14 -11Q12 -8 9.3 -11Q7 -8 4.6 -11Q2.3 -8 0 -11Q-2.3 -8 -4.6 -11Q-7 -8 -9.3 -11Q-12 -8 -14 -11Z" />
      <path className="a-thin" d="M-4.6 -11L-3.4 -19M4.6 -11L3.4 -19M-9.3 -11L-6.8 -19M9.3 -11L6.8 -19" />
    </g>
  );
}

function Parasol({ x, y, tone }: { x: number; y: number; tone: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <ellipse className="a-shadow" cx={1} cy={0.3} rx={8} ry={2} />
      <path className="a-line" d="M0 0V-12M-5 -3H5" />
      <path className={`a-awn a-awn-${tone}`} d="M-10 -11Q0 -21 10 -11Q5 -13 0 -11Q-5 -13 -10 -11Z" />
    </g>
  );
}

function FoodCourt() {
  return (
    <>
      <Stall x={-58} y={-6} tone={0} />
      <Stall x={-28} y={-22} tone={1} />
      <Stall x={28} y={-22} tone={2} />
      <Stall x={58} y={-6} tone={0} />
      <Parasol x={-34} y={12} tone={2} />
      <Parasol x={34} y={12} tone={1} />
      <Parasol x={-16} y={26} tone={0} />
      <Parasol x={16} y={26} tone={2} />
    </>
  );
}

function BellTent() {
  return (
    <>
      <ellipse className="a-shadow" cx={3} cy={1} rx={24} ry={4} />
      <path className="a-body" d="M-20 0Q-14 -12 -2 -30H2Q14 -12 20 0Z" />
      <path className="a-thin" d="M-1 -30Q-7 -12 -10 0M1 -30Q7 -12 10 0" />
      <path className="a-tint-line" d="M-5 0Q-3 -10 0 -16Q3 -10 5 0Z" />
      <path className="a-line" d="M0 -30V-37" />
      <path className="a-flag a-flag-1" d="M0 -37l7 2l-7 2z" />
    </>
  );
}

function Grandstand() {
  return (
    <>
      <ellipse className="a-shadow" cx={3} cy={1} rx={56} ry={6} />
      <path className="a-tint-line" d="M-50 0L-40 -16H48L52 0Z" />
      <path className="a-thin" d="M-47 -4H51M-44 -8H50M-42 -12H49" />
      <path className="a-line" d="M-34 -16V-40M0 -16V-44M34 -16V-44" />
      <path className="a-roof" d="M-46 -38L-38 -44L52 -48L50 -41Z" />
      <path className="a-thin" d="M-22 -16V-42M12 -16V-44" />
    </>
  );
}

function Gate({ width = 22 }: { width?: number }) {
  const w = width;
  return (
    <>
      <ellipse className="a-shadow" cx={2} cy={0.5} rx={w + 6} ry={3.2} />
      <path className="a-body" d={`M${-w - 3} 0V-30H${-w + 3}V0ZM${w - 3} 0V-30H${w + 3}V0Z`} />
      <path className="a-roof" d={`M${-w - 5} -34Q0 ${-46} ${w + 5} -34V-26Q0 ${-38} ${-w - 5} -26Z`} />
      <path className="a-line" d={`M${-w} -36V-46M${w} -36V-46`} />
      <path className="a-flag a-flag-2" d={`M${-w} -46l8 2.5l-8 2.5z`} />
      <path className="a-flag a-flag-0" d={`M${w} -46l8 2.5l-8 2.5z`} />
    </>
  );
}

function TicketQueue() {
  const kiosk = (x: number) => (
    <g key={x} transform={`translate(${x} -16)`}>
      <ellipse className="a-shadow" cx={2} cy={0.5} rx={13} ry={2.6} />
      <path className="a-body" d="M-10 0V-14H10V0Z" />
      <path className="a-tint-line" d="M-6 -6V-11H6V-6Z" />
      <path className="a-roof" d="M-13 -14L0 -24L13 -14Z" />
    </g>
  );
  return (
    <>
      {kiosk(-30)}
      {kiosk(30)}
      <path className="a-rope" d="M-64 -2H52M52 -2V8M-52 8H52M-52 8V18M-64 18H52" />
      <path className="a-post" d="M-64 -2v-5M-20 -2v-5M20 -2v-5M52 -2v-5M-52 8v-5M0 8v-5M52 8v-5M-52 18v-5M-20 18v-5M20 18v-5M52 18v-5M-64 18v-5" />
    </>
  );
}

function Tower() {
  const rungs = [24, 46, 66, 84, 100, 114];
  const at = (y: number) => 12 - (y / 128) * 9;
  return (
    <>
      <ellipse className="a-shadow" cx={6} cy={2} rx={36} ry={6} />
      <path className="a-thin" d="M-46 12Q0 -2 46 12M-30 20Q4 10 38 20" />
      <path className="a-tint-line" d="M-30 0V-14H-12V0Z" />
      <path className="a-thin" d="M-26 -5h4M-20 -5h4" />
      <path className="a-line" d="M-12 0L-3 -128M12 0L3 -128" />
      {rungs.map((y, i) => {
        const prev = i ? rungs[i - 1]! : 0;
        return <path key={y} className="a-thin" d={`M${f1(-at(y))} ${-y}H${f1(at(y))}M${f1(-at(prev))} ${-prev}L${f1(at(y))} ${-y}M${f1(at(prev))} ${-prev}L${f1(-at(y))} ${-y}`} />;
      })}
      <path className="a-line" d="M-3 -128H3M0 -128V-146" />
      <path className="a-body" d="M-16 -104Q-20 -94 -14 -86L-6 -96Z" />
      <path className="a-body" d="M16 -74Q20 -64 14 -56L6 -66Z" />
    </>
  );
}

function Pitch() {
  return (
    <>
      <rect className="a-pitch" x={-86} y={-54} width={172} height={108} rx={54} />
      <rect className="a-lane" x={-78} y={-46} width={156} height={92} rx={46} />
      <rect className="a-lane" x={-56} y={-30} width={112} height={60} />
      <path className="a-lane" d="M0 -30V30" />
      <circle className="a-lane" r={11} />
      <path className="a-lane" d="M-56 -13h13v26h-13M56 -13h-13v26h13" />
    </>
  );
}

interface Spot {
  key: string;
  at: Point;
  dx?: number;
  dy?: number;
  label?: string;
  labelDy?: number;
  node: ReactNode;
  size?: number;
}

const SPOTS: Spot[] = [
  { key: 'stage', at: P.mainStage, node: <MainStage />, label: 'Main stage', labelDy: 15 },
  { key: 'north', at: P.northGate, node: <Gate />, label: 'North gate', labelDy: 13 },
  { key: 'west', at: P.westGate, node: <Gate width={13} />, label: 'West gate', labelDy: 13 },
  { key: 'first', at: P.firstAid, dx: 0, dy: -3, node: <Tent />, label: 'First aid post', labelDy: 15 },
  { key: 'access', at: P.accessHub, dy: -3, node: <Pavilion />, label: 'Access hub', labelDy: 18 },
  { key: 'hall', at: P.sportsHall, dy: -4, node: <Hall />, label: 'Sports hall', labelDy: 18 },
  { key: 'upper', at: P.upperStand, dy: -4, node: <Grandstand />, label: 'Upper stand', labelDy: 17 },
  { key: 'food', at: P.foodCourt, node: <FoodCourt />, label: 'Food court', labelDy: 46 },
  { key: 'quiet', at: P.quietTent, dy: -3, node: <BellTent />, label: 'Quiet tent', labelDy: 15 },
  { key: 'depot', at: P.supplyDepot, dy: -3, node: <Depot />, label: 'Supply depot', labelDy: 16 },
  { key: 'shop', at: P.workshop, dx: -6, dy: -3, node: <Shed />, label: 'Workshop', labelDy: 16 },
  { key: 'queue', at: P.ticketQueue, node: <TicketQueue />, label: 'Ticket queue', labelDy: 34 },
  { key: 'tower', at: TOWER, node: <Tower /> },
];

const FENCE: Point[] = [
  { x: 43, y: 2.5 },
  { x: 24, y: 1.5 },
  { x: 4, y: 4 },
  { x: 1.5, y: 24 },
  { x: 2.5, y: 44 },
];
const FENCE_2: Point[] = [
  { x: 2.5, y: 56 },
  { x: 1, y: 76 },
  { x: 5, y: 95 },
  { x: 30, y: 98.5 },
  { x: 60, y: 98 },
  { x: 78, y: 97 },
];
const FENCE_3: Point[] = [
  { x: 57, y: 2.5 },
  { x: 76, y: 2 },
  { x: 92, y: 4 },
  { x: 94.5, y: 26 },
  { x: 92.5, y: 48 },
  { x: 92, y: 70 },
];

const POND = { x: 89, y: 87 };

export const MapArt = memo(function MapArt({ frame }: { frame: Frame }) {
  const { width, height, u, compact } = frame;
  const art = useMemo(() => {
    const px = (p: Point) => toPx(frame, p);
    const road = WALKWAYS.map((w) => linePath(smooth(w, 8).map(px))).join('');
    const lawn = blob(50, 50, 52, 54, 7, 15, 0.05).map(px);
    const lawnInner = blob(50, 36, 26, 18, 11, 12, 0.08).map(px);
    const lawnSouth = blob(36, 76, 24, 14, 12, 12, 0.09).map(px);
    const pond = blob(POND.x, POND.y, 6.4, 7.2, 19, 9, 0.12).map(px);
    const fence = [FENCE, FENCE_2, FENCE_3].map((line) => linePath(smooth(line, 8).map(px))).join('');
    const pitch = px(P.sportsField);
    const pondAt = px(POND);
    return { road, lawn, lawnInner, lawnSouth, pond, fence, pitch, pondAt };
  }, [frame]);

  const scene = useMemo(() => {
    const items: { y: number; node: ReactNode }[] = TREES.map((t, i) => {
      const p = toPx(frame, t.at);
      return {
        y: p.y,
        node: (
          <g key={`t${i}`} transform={`translate(${f1(p.x)} ${f1(p.y)}) scale(${u})`}>
            <TreeGlyph tree={t} />
          </g>
        ),
      };
    });
    for (const s of SPOTS) {
      const p = toPx(frame, { x: s.at.x + (s.dx ?? 0), y: s.at.y + (s.dy ?? 0) });
      items.push({
        y: p.y,
        node: (
          <g key={s.key} transform={`translate(${f1(p.x)} ${f1(p.y)}) scale(${u})`}>
            {s.node}
          </g>
        ),
      });
    }
    return items.sort((a, b) => a.y - b.y).map((i) => i.node);
  }, [frame, u]);

  const labels = SPOTS.filter((s) => s.label && (!compact || ['stage', 'food', 'first', 'depot', 'shop', 'hall'].includes(s.key)));

  return (
    <svg className="w-art" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <defs>
        <filter id="w-hand" x="-2%" y="-2%" width="104%" height="104%">
          <feTurbulence type="fractalNoise" baseFrequency="0.018" numOctaves="2" seed="4" result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale={2.4 * u} />
        </filter>
        <filter id="w-wash" x="-5%" y="-5%" width="110%" height="110%">
          <feGaussianBlur stdDeviation={10 * u} />
        </filter>
      </defs>
      <rect className="a-paper" width={width} height={height} />
      <g filter="url(#w-wash)">
        <path className="a-lawn" d={`${linePath(art.lawn)}Z`} />
        <path className="a-lawn2" d={`${linePath(art.lawnInner)}Z`} />
        <path className="a-lawn2" d={`${linePath(art.lawnSouth)}Z`} />
      </g>
      <g filter="url(#w-hand)">
        <path className="a-water" d={`${linePath(art.pond)}Z`} />
        <path className="a-ripple" d={`M${art.pondAt.x - 24 * u} ${art.pondAt.y - 10 * u}h${18 * u}M${art.pondAt.x + 2 * u} ${art.pondAt.y + 6 * u}h${22 * u}M${art.pondAt.x - 16 * u} ${art.pondAt.y + 18 * u}h${12 * u}`} />
        <g transform={`translate(${art.pitch.x} ${art.pitch.y}) scale(${u})`}>
          <Pitch />
        </g>
        <path className="a-road-edge" d={art.road} strokeWidth={8.6 * u} />
        <path className="a-road" d={art.road} strokeWidth={6.8 * u} />
        <path className="a-fence" d={art.fence} />
        {scene}
      </g>
      <g className="a-labels" style={{ fontSize: Math.max(10.5, 11.5 * Math.min(u, 1.1)) }}>
        {labels.map((s) => {
          const p = toPx(frame, { x: s.at.x + (s.dx ?? 0), y: s.at.y + (s.dy ?? 0) });
          return (
            <text key={s.key} x={f1(p.x)} y={f1(p.y + (s.labelDy ?? 14) * u)} textAnchor="middle">
              {s.label}
            </text>
          );
        })}
      </g>
    </svg>
  );
});
