import { useSyncExternalStore } from 'react';
import type { HubState } from '@afterlink/mesh';
import type { TaskSpec } from '@afterlink/protocol';
import type { DeviceHandle } from '../bridge/stage';
import type { HqCommand, HqNotice } from './protocol';

export interface HqSnapshot {
  alive: boolean;
  /** Increases every time HQ starts. */
  epoch: number;
  /** The last thing HQ knew. Kept after a kill: it is stale, never live. */
  state: HubState | null;
  /** When HQ last reported. This is what "last confirmed at" means. */
  lastConfirmedAt: number | null;
  killedAt: number | null;
}

function spawn(): Worker {
  return new Worker(new URL('./hq.worker.ts', import.meta.url), { type: 'module', name: 'afterlink-hq' });
}

/**
 * The stage's control of HQ. `kill` is a literal worker.terminate(): nothing tells the
 * devices, they find out when their heartbeats go unanswered. `restore` starts a fresh
 * worker and hands every device a new port.
 */
export class HqController {
  private worker: Worker | null = null;
  private current: HqSnapshot = { alive: false, epoch: 0, state: null, lastConfirmedAt: null, killedAt: null };
  private readonly listeners = new Set<() => void>();
  private readonly devices = new Map<DeviceHandle, { booted: boolean; stop: () => void }>();

  constructor(private readonly createWorker: () => Worker = spawn) {}

  start() {
    if (this.worker) return;
    const worker = this.createWorker();
    worker.onmessage = (event: MessageEvent<HqNotice>) => this.heard(worker, event.data);
    this.worker = worker;
    this.update({ alive: true, epoch: this.current.epoch + 1, killedAt: null });
    for (const [device, entry] of this.devices) if (entry.booted) this.handOver(device);
  }

  kill() {
    if (!this.worker) return;
    this.worker.terminate();
    this.worker = null;
    this.update({ alive: false, killedAt: Date.now() });
  }

  restore() {
    this.start();
  }

  /** Keeps a device connected: on boot, on restart, and on every restore. */
  attach(device: DeviceHandle): () => void {
    const stop = device.on((report) => {
      if (report.kind !== 'booted') return;
      const entry = this.devices.get(device);
      if (entry) entry.booted = true;
      this.handOver(device);
    });
    this.devices.set(device, { booted: false, stop });
    return () => {
      stop();
      this.devices.delete(device);
    };
  }

  /** Delivers an external request through HQ. Returns false when HQ is down. */
  ingress(ref: string, spec: TaskSpec): boolean {
    if (!this.worker) return false;
    this.post({ kind: 'ingress', ref, spec });
    return true;
  }

  snapshot = (): HqSnapshot => this.current;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  dispose() {
    this.worker?.terminate();
    this.worker = null;
    for (const entry of this.devices.values()) entry.stop();
    this.devices.clear();
    this.listeners.clear();
  }

  private handOver(device: DeviceHandle) {
    if (!this.worker) return;
    const channel = new MessageChannel();
    this.post({ kind: 'connect', slot: device.slot }, [channel.port1]);
    device.send({ kind: 'hqPort', epoch: this.current.epoch }, [channel.port2]);
  }

  private post(command: HqCommand, transfer: Transferable[] = []) {
    this.worker?.postMessage(command, transfer);
  }

  private heard(worker: Worker, notice: HqNotice) {
    if (worker !== this.worker) return;
    if (notice.kind === 'state') this.update({ state: notice.state, lastConfirmedAt: notice.at });
  }

  private update(patch: Partial<HqSnapshot>) {
    this.current = { ...this.current, ...patch };
    this.listeners.forEach((listener) => listener());
  }
}

export function useHq(hq: HqController): HqSnapshot {
  return useSyncExternalStore(hq.subscribe, hq.snapshot);
}
