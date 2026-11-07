import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { frameText, parseFrameText, type WireFrame } from './frames.ts';

const ECC = 'L' as const;
const QUIET = 4;

export async function renderFrame(canvas: HTMLCanvasElement, f: WireFrame): Promise<void> {
  await QRCode.toCanvas(canvas, frameText(f), {
    errorCorrectionLevel: ECC,
    margin: QUIET,
    width: canvas.clientWidth || canvas.width || 480,
  });
}

/** Raw QR pixels for a frame as RGBA, usable without a DOM. */
export function frameImage(f: WireFrame, scale = 6): { data: Uint8ClampedArray; width: number; height: number } {
  const { modules } = QRCode.create(frameText(f), { errorCorrectionLevel: ECC });
  const size = modules.size;
  const dim = (size + QUIET * 2) * scale;
  const data = new Uint8ClampedArray(dim * dim * 4).fill(255);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!modules.get(r, c)) continue;
      for (let y = 0; y < scale; y++) {
        for (let x = 0; x < scale; x++) {
          const o = (((r + QUIET) * scale + y) * dim + (c + QUIET) * scale + x) * 4;
          data[o] = data[o + 1] = data[o + 2] = 0;
        }
      }
    }
  }
  return { data, width: dim, height: dim };
}

export function readFrame(image: ImageData | { data: Uint8ClampedArray; width: number; height: number }): WireFrame | null {
  const hit = jsQR(image.data, image.width, image.height, { inversionAttempts: 'attemptBoth' });
  return hit ? parseFrameText(hit.data) : null;
}

/** Cycles frames on a canvas for the sender screen. */
export class FrameCycler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private idx = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private frames: WireFrame[],
    private opts: { intervalMs?: number; onFrame?: (index: number, total: number) => void } = {},
  ) {}

  get index(): number {
    return this.idx;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer !== null || !this.frames.length) return;
    const tick = async () => {
      const at = this.idx;
      await renderFrame(this.canvas, this.frames[at]!);
      if (this.timer === null) return;
      this.opts.onFrame?.(at, this.frames.length);
      this.idx = (at + 1) % this.frames.length;
      this.timer = setTimeout(tick, this.opts.intervalMs ?? 300);
    };
    this.timer = setTimeout(tick, 0);
  }

  stop(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
