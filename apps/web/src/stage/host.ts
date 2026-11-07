import type { ActorId, ProvisionBundle } from '@afterlink/protocol';
import type { HubState } from '@afterlink/mesh';
import { DeviceHandle, deviceSrc, type DeviceCommand, type DeviceReport } from '../bridge';
import { HqController } from '../hq';

/** How a mission reaches one device. */
export interface DeviceLink {
  send(command: DeviceCommand, transfer?: Transferable[]): void;
  on(listener: (report: DeviceReport) => void): () => void;
  dispose(): void;
}

export interface HostHq {
  alive: boolean;
  /** Null when HQ is a remote relay whose observer state cannot be read here. */
  state: HubState | null;
  lastConfirmedAt: number | null;
}

/** Where a mission runs: four iframes in this page, or real phones behind a relay. */
export interface MissionHost {
  /** True when real people tap the buttons, so waits are measured for humans. */
  readonly humans: boolean;
  room(run: number): string;
  begin(onHq: () => void, onFail: (message: string) => void): void;
  device(run: number, index: number, bundle: ProvisionBundle, pace: number): { link: DeviceLink; src: string };
  ready(bundles: ProvisionBundle[], issuer: { publicKey: ActorId; secretKey: string }): void;
  hq(): HostHq;
  killHq(): void;
  restoreHq(): void;
  attach(id: ActorId, frame: HTMLIFrameElement | null): void;
  end(): void;
}

/** Four same-origin iframes, each a complete device, with HQ as a dedicated worker. */
export class SoloHost implements MissionHost {
  readonly humans = false;
  private controller: HqController | null = null;
  private off: (() => void) | null = null;
  private handles = new Map<ActorId, DeviceHandle>();

  room(run: number) {
    return `solo-${run}-${Date.now().toString(36)}`;
  }

  begin(onHq: () => void) {
    this.controller = new HqController();
    this.off = this.controller.subscribe(onHq);
  }

  device(run: number, index: number, bundle: ProvisionBundle, pace: number) {
    const handle = new DeviceHandle(`${run}-${index}-${bundle.team}`);
    this.handles.set(bundle.actor.publicKey, handle);
    this.controller?.attach(handle);
    const boot = { kind: 'provision', bundle, autopilot: true, autopilotDelayMs: pace };
    handle.send({ ...boot, fresh: true } as DeviceCommand);
    let booted = false;
    handle.on((report) => {
      if (report.kind === 'booted') booted = true;
      if (report.kind === 'ready' && booted) handle.send({ ...boot, fresh: false } as DeviceCommand);
    });
    return { link: handle, src: deviceSrc(handle.slot) };
  }

  ready() {
    this.controller?.start();
  }

  hq(): HostHq {
    const s = this.controller?.snapshot();
    return { alive: s?.alive ?? false, state: s?.state ?? null, lastConfirmedAt: s?.lastConfirmedAt ?? null };
  }

  killHq() {
    this.controller?.kill();
  }

  restoreHq() {
    this.controller?.restore();
  }

  attach(id: ActorId, frame: HTMLIFrameElement | null) {
    this.handles.get(id)?.attach(frame);
  }

  end() {
    this.off?.();
    this.off = null;
    this.controller?.dispose();
    this.controller = null;
    this.handles = new Map();
  }
}
