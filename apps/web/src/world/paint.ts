import type { TaskStatus } from '@afterlink/protocol';

export interface Ink {
  paper: string;
  fg: string;
  muted: string;
  ink: string;
  stop: string;
  ok: string;
  warn: string;
  fog: string;
  hull: string;
  shadow: string;
  pulse: string;
  dark: boolean;
}

const css = (root: Element, name: string) => getComputedStyle(root).getPropertyValue(name).trim();

export function readInk(root: Element): Ink {
  return {
    paper: css(root, '--w-paper'),
    fg: css(root, '--fg'),
    muted: css(root, '--fg-muted'),
    ink: css(root, '--w-ink'),
    stop: css(root, '--stop'),
    ok: css(root, '--ok'),
    warn: css(root, '--warn'),
    fog: css(root, '--w-fog'),
    hull: css(root, '--w-hull'),
    shadow: css(root, '--w-shadow'),
    pulse: css(root, '--w-pulse'),
    dark: css(root, '--w-dark') === '1',
  };
}

/** Resolves a `var(--x)` colour so a canvas can use it. */
export const resolve = (root: Element, colour: string): string => {
  const name = /var\((--[\w-]+)\)/.exec(colour)?.[1];
  return name ? css(root, name) : colour;
};

type Ctx = CanvasRenderingContext2D;

const line = (c: Ctx, x1: number, y1: number, x2: number, y2: number) => {
  c.beginPath();
  c.moveTo(x1, y1);
  c.lineTo(x2, y2);
  c.stroke();
};

/** One small person. Feet at (x, y). */
export function person(c: Ctx, x: number, y: number, s: number, colour: string, ink: Ink, step: number, moving: boolean, facing: number, satchel = false) {
  const swing = moving ? Math.sin(step) * 2.7 * s : 0;
  const bob = moving ? Math.abs(Math.cos(step)) * 0.8 * s : 0;
  const hip = y - 6.2 * s - bob;
  const neck = y - 12 * s - bob;
  const head = y - 15.4 * s - bob;
  c.lineCap = 'round';

  c.fillStyle = ink.shadow;
  c.beginPath();
  c.ellipse(x + 0.8 * s, y + 0.4 * s, 4.6 * s, 1.5 * s, 0, 0, Math.PI * 2);
  c.fill();

  c.strokeStyle = ink.paper;
  c.lineWidth = 3.4 * s;
  line(c, x - 0.8 * s, hip, x - 0.9 * s + swing, y);
  line(c, x + 0.8 * s, hip, x + 0.9 * s - swing, y);
  c.lineWidth = 6 * s;
  line(c, x, hip, x, neck);
  c.fillStyle = ink.paper;
  c.beginPath();
  c.arc(x + facing * 0.3 * s, head, 3.4 * s, 0, Math.PI * 2);
  c.fill();

  c.strokeStyle = colour;
  c.lineWidth = 1.7 * s;
  line(c, x - 0.8 * s, hip, x - 0.9 * s + swing, y);
  line(c, x + 0.8 * s, hip, x + 0.9 * s - swing, y);
  c.lineWidth = 4.3 * s;
  line(c, x, hip, x, neck);
  c.fillStyle = colour;
  c.beginPath();
  c.arc(x + facing * 0.3 * s, head, 2.5 * s, 0, Math.PI * 2);
  c.fill();
  if (satchel) {
    c.fillStyle = ink.paper;
    c.fillRect(x - facing * 4.2 * s - 1.8 * s, neck + 1.6 * s, 3.6 * s, 3 * s);
    c.strokeStyle = colour;
    c.lineWidth = 0.8 * s;
    c.strokeRect(x - facing * 4.2 * s - 1.8 * s, neck + 1.6 * s, 3.6 * s, 3 * s);
  }
}

/** Text with a paper halo, readable over any part of the map. */
export function label(c: Ctx, text: string, x: number, y: number, size: number, colour: string, ink: Ink, weight = 600, align: CanvasTextAlign = 'center') {
  c.font = `${weight} ${size}px -apple-system, 'Segoe UI Variable Text', 'Segoe UI', Roboto, sans-serif`;
  c.textAlign = align;
  c.textBaseline = 'middle';
  c.lineJoin = 'round';
  c.strokeStyle = ink.paper;
  c.lineWidth = size * 0.36;
  c.strokeText(text, x, y);
  c.fillStyle = colour;
  c.fillText(text, x, y);
}

/** A task is a small flag planted where the work is. */
export function flag(c: Ctx, x: number, y: number, s: number, status: TaskStatus, colour: string, ink: Ink, now: number, still: boolean) {
  const h = 19 * s;
  c.lineCap = 'round';
  c.lineJoin = 'round';

  c.fillStyle = ink.shadow;
  c.beginPath();
  c.ellipse(x + 0.6 * s, y + 0.3 * s, 3.6 * s, 1.2 * s, 0, 0, Math.PI * 2);
  c.fill();

  if (status === 'completed') {
    c.fillStyle = ink.paper;
    c.beginPath();
    c.arc(x, y - 6 * s, 6.3 * s, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = colour;
    c.lineWidth = 1.5 * s;
    c.beginPath();
    c.arc(x, y - 6 * s, 5.4 * s, 0, Math.PI * 2);
    c.stroke();
    c.beginPath();
    c.moveTo(x - 2.5 * s, y - 5.9 * s);
    c.lineTo(x - 0.6 * s, y - 4.1 * s);
    c.lineTo(x + 2.7 * s, y - 7.8 * s);
    c.stroke();
    return;
  }

  const stopped = status === 'refused' || status === 'conflicted' || status === 'cancelled';
  const waiting = status === 'open' || status === 'deferred';
  const tone = stopped ? ink.stop : colour;

  c.strokeStyle = ink.paper;
  c.lineWidth = 3 * s;
  line(c, x, y, x, y - h);
  c.strokeStyle = tone;
  c.lineWidth = 1.5 * s;
  line(c, x, y, x, y - h);

  const flutter = still || waiting ? 0 : Math.sin(now / 240 + x) * 0.9 * s;
  const tipX = x + 12.5 * s;
  const tipY = y - h + 4.6 * s + flutter;
  const outline = () => {
    c.beginPath();
    c.moveTo(x, y - h);
    c.quadraticCurveTo(x + 6 * s, y - h + 1.4 * s - flutter * 0.4, tipX, tipY);
    c.quadraticCurveTo(x + 6 * s, y - h + 8.2 * s - flutter * 0.4, x, y - h + 9.4 * s);
    c.closePath();
  };
  c.strokeStyle = ink.paper;
  c.lineWidth = 3 * s;
  outline();
  c.stroke();
  outline();
  if (status === 'accepted' || stopped) {
    c.fillStyle = tone;
    c.fill();
  } else {
    c.fillStyle = ink.paper;
    c.fill();
    c.strokeStyle = tone;
    c.lineWidth = 1.5 * s;
    if (status === 'deferred') c.setLineDash([2.5 * s, 2.5 * s]);
    c.stroke();
    c.setLineDash([]);
  }
  if (stopped) {
    c.strokeStyle = ink.paper;
    c.lineWidth = 1.3 * s;
    line(c, x + 2.8 * s, y - h + 2.8 * s, x + 7 * s, y - h + 6.8 * s);
    line(c, x + 7 * s, y - h + 2.8 * s, x + 2.8 * s, y - h + 6.8 * s);
  }
}

/** A small hand-held pair of scissors, pointing along the direction of the cut. */
export function scissors(c: Ctx, x: number, y: number, s: number, angle: number, open: number, ink: Ink) {
  c.save();
  c.translate(x, y);
  c.rotate(angle);
  c.strokeStyle = ink.fg;
  c.fillStyle = ink.paper;
  c.lineWidth = 1.4 * s;
  c.lineCap = 'round';
  for (const side of [-1, 1]) {
    c.save();
    c.rotate(side * open * 0.42);
    line(c, -8 * s, 0, 11 * s, 0);
    c.beginPath();
    c.arc(-11.5 * s, side * 1.8 * s, 3 * s, 0, Math.PI * 2);
    c.fill();
    c.stroke();
    c.restore();
  }
  c.restore();
}

/** Mist with some grain in it, made once. */
export function mistTile(size = 128): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const c = canvas.getContext('2d')!;
  const image = c.createImageData(size, size);
  const octaves = [8, 16, 32].map((grid, i) => {
    const cells = new Float32Array(grid * grid).map(() => Math.random());
    return { grid, cells, weight: 1 / (i + 1.4) };
  });
  const sample = ({ grid, cells }: (typeof octaves)[number], x: number, y: number) => {
    const fx = (x / size) * grid;
    const fy = (y / size) * grid;
    const x0 = Math.floor(fx) % grid;
    const y0 = Math.floor(fy) % grid;
    const x1 = (x0 + 1) % grid;
    const y1 = (y0 + 1) % grid;
    const tx = fx - Math.floor(fx);
    const ty = fy - Math.floor(fy);
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    const top = cells[y0 * grid + x0]! * (1 - sx) + cells[y0 * grid + x1]! * sx;
    const low = cells[y1 * grid + x0]! * (1 - sx) + cells[y1 * grid + x1]! * sx;
    return top * (1 - sy) + low * sy;
  };
  const total = octaves.reduce((s, o) => s + o.weight, 0);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = octaves.reduce((s, o) => s + sample(o, x, y) * o.weight, 0) / total;
      const i = (y * size + x) * 4;
      image.data[i + 3] = Math.max(0, Math.min(255, (v - 0.32) * 2.4 * 255));
    }
  }
  c.putImageData(image, 0, 0);
  return canvas;
}
