import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { ActorId } from '@afterlink/protocol';
import { DEVICE_W, frameFor, isStacked, type Frame } from './layout';
import type { Pair } from './graph';
import type { Scene } from './scene';

export interface TheatreDevice {
  id: ActorId;
  name: string;
  src: string;
  /** Reported by the device itself. */
  signalUp: boolean;
}

interface TheatreProps {
  devices: TheatreDevice[];
  pairs: Pair[];
  groups: ActorId[][];
  scene: Scene;
  bind: (id: ActorId, el: HTMLIFrameElement | null) => void;
  overlay?: (id: ActorId) => ReactNode;
  marks: Record<ActorId, { tone: string } | undefined>;
  children?: ReactNode;
}

const DeviceFrame = memo(function DeviceFrame({
  id,
  name,
  src,
  width,
  height,
  scale,
  bind,
}: {
  id: ActorId;
  name: string;
  src: string;
  width: number;
  height: number;
  scale: number;
  bind: (id: ActorId, el: HTMLIFrameElement | null) => void;
}) {
  return (
    <iframe
      ref={(el) => bind(id, el)}
      className="st-iframe"
      title={`${name} device`}
      src={src}
      allow="microphone; camera; autoplay"
      style={{ width, height, transform: `scale(${scale})` }}
    />
  );
});

export function Theatre({ devices, pairs, groups, scene, bind, overlay, marks, children }: TheatreProps) {
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const order = useMemo(() => devices.map((d) => d.id), [devices]);

  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const read = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const frame: Frame | null = useMemo(
    () => (size ? frameFor(size.w, size.h, order.length, isStacked(window.innerWidth)) : null),
    [size, order.length],
  );

  useLayoutEffect(() => {
    if (frame) scene.setFrame(frame, order);
  }, [frame, order, scene]);

  useEffect(() => {
    scene.setGroups(groups);
  }, [scene, groups, frame]);

  useEffect(() => {
    scene.start();
    return () => scene.stop();
  }, [scene]);


  return (
    <div className="st-theatre" ref={host} data-mode={frame?.mode} style={frame?.mode === 'stack' ? { height: frame.height } : undefined}>
      {frame && (
        <>
          <svg className="st-links" width={frame.width} height={Math.max(frame.height, size?.h ?? 0)} aria-hidden="true">
            {devices.map((d) => (
              <path
                key={d.id}
                ref={(el) => scene.bindHq(d.id, el)}
                className="st-hq-line"
                data-up={d.signalUp}
                pathLength={1}
              />
            ))}
            {pairs.map((p) => (
              <path
                key={`${p.a}|${p.b}`}
                ref={(el) => scene.bindPeer(p.a, p.b, el)}
                className="st-peer"
                data-state={p.state}
                pathLength={1}
              />
            ))}
            <g ref={(el) => scene.bindPulseLayer(el)} />
          </svg>

          {devices.map((d) => (
            <div
              key={d.id}
              ref={(el) => scene.bindDevice(d.id, el)}
              className="st-device"
              data-mark={marks[d.id]?.tone}
              style={{ width: frame.slots[0]!.w, height: frame.slots[0]!.h, '--st-scale': frame.scale } as CSSProperties}
            >
              <div className="st-screen">
                <DeviceFrame
                  id={d.id}
                  name={d.name}
                  src={d.src}
                  width={DEVICE_W}
                  height={frame.deviceH}
                  scale={frame.scale}
                  bind={bind}
                />
              </div>
              {overlay?.(d.id)}
            </div>
          ))}
          {children}
        </>
      )}
    </div>
  );
}
