import { useEffect, useRef } from 'react';
import type { StageCarry, StageController } from './contract';
import type { Scene } from './scene';

const QR_SHARE = 0.62;

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The pixels a device rendered, physically carried to the other device. */
export function Courier({ controller, scene, carry }: { controller: StageController; scene: Scene; carry: StageCarry }) {
  const el = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const walking = carry.phase === 'walking';

  useEffect(() => {
    return controller.on((e) => {
      const c = canvas.current;
      if (e.kind !== 'frame' || !c) return;
      c.width = e.pixels.width;
      c.height = e.pixels.height;
      c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(e.pixels.data), e.pixels.width, e.pixels.height), 0, 0);
    });
  }, [controller]);

  useEffect(() => {
    const host = el.current;
    const from = scene.box(carry.sender);
    const to = scene.box(carry.receiver);
    if (!host || !from || !to) return;
    const size = Math.min(from.w, from.h) * QR_SHARE;
    host.style.setProperty('--st-qr', `${size}px`);
    const at = (b: { x: number; y: number; w: number; h: number }) => `translate(${b.x + (b.w - size) / 2}px, ${b.y + (b.h - size) / 2}px)`;
    const start = at(from);
    const end = at(to);
    host.style.transform = walking || carry.phase === 'preparing' ? start : end;
    if (!walking) return;
    if (reduced()) {
      host.style.transform = end;
      controller.carried();
      return;
    }
    const mid = `translate(${(from.x + to.x + from.w - size) / 2}px, ${Math.min(from.y, to.y) + (from.h - size) / 2 - size * 0.14}px)`;
    const walk = host.animate([{ transform: start }, { transform: mid }, { transform: end }], {
      duration: carry.walkMs,
      easing: 'cubic-bezier(0.55, 0, 0.25, 1)',
      fill: 'forwards',
    });
    walk.onfinish = () => {
      host.style.transform = end;
      walk.cancel();
      controller.carried();
    };
    return () => walk.cancel();
  }, [walking, carry.phase, carry.sender, carry.receiver, carry.walkMs, controller, scene]);

  return (
    <div className="st-courier" ref={el} data-phase={carry.phase} aria-hidden="true">
      <canvas ref={canvas} aria-hidden="true" />
      {carry.total > 0 && (
        <span className="st-courier-count">
          {carry.have} of {carry.total}
        </span>
      )}
    </div>
  );
}
