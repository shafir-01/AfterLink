import { useSyncExternalStore } from 'react';
import { createActor, createIdbStorage, type ActorNode } from '@afterlink/actor';
import { portSignalClient, webrtcConnector, wsSignalClient } from '@afterlink/mesh';
import type { ProvisionBundle, SignalClient } from '@afterlink/protocol';
import { insideStage, listenToStage, reportToStage } from '../bridge/device';
import type { DeviceCommand } from '../bridge/protocol';
import { compactView } from './compact';
import { FerryReceiver, sendFerry } from './ferryRun';
import { decodeBundle, loadStoredBundle, signalUrl, storeBundle } from './provisionLink';

export type DevicePhase = 'waiting' | 'booting' | 'running' | 'failed';

export interface DeviceSnapshot {
  phase: DevicePhase;
  node: ActorNode | null;
  error: string | null;
}

interface BootOptions {
  bundle: ProvisionBundle;
  autopilot?: boolean;
  tickMs?: number;
  fresh?: boolean;
  relay?: string;
}

const REPORT_MS = 120;
const LINK_REPORT_MS = 1000;
/** How fast a device notices HQ has gone: a terminated worker sends no goodbye. */
const HQ_HEARTBEAT = { heartbeatMs: 300, timeoutMs: 1000 };

function namespaceOf(bundle: ProvisionBundle): string {
  return `${bundle.room}.${bundle.actor.publicKey.slice(0, 16)}`;
}

/** Removes a device's durable state. Waits for any connection still closing. */
function wipeStorage(namespace: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(`afterlink-${namespace}`);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * One device: boots a single actor and keeps it running. Lives outside React so that
 * remounts never start a second actor.
 */
class DeviceRuntime {
  private current: DeviceSnapshot = { phase: 'waiting', node: null, error: null };
  private readonly listeners = new Set<() => void>();
  private started = false;
  private options: BootOptions | null = null;
  private signal: SignalClient | null = null;
  private pendingPort: MessagePort | null = null;
  private receiver: FerryReceiver | null = null;
  private teardown: (() => void)[] = [];
  private bootRun = 0;

  snapshot = () => this.current;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  start(fragment: { bundle?: string; relay?: string }) {
    if (this.started) return;
    this.started = true;
    if (insideStage()) {
      listenToStage((command, ports) => void this.handle(command, ports));
      return;
    }
    void this.startOnPhone(fragment);
  }

  private async startOnPhone({ bundle: encoded, relay }: { bundle?: string; relay?: string }) {
    try {
      if (encoded) {
        const bundle = await decodeBundle(encoded);
        storeBundle(bundle, relay);
        window.history.replaceState(null, '', '#/device');
        await this.boot({ bundle, relay });
        return;
      }
      const stored = loadStoredBundle();
      if (stored) await this.boot(stored);
    } catch (error) {
      this.fail(error);
    }
  }

  private async handle(command: DeviceCommand, ports: readonly MessagePort[]) {
    try {
      const node = this.current.node;
      switch (command.kind) {
        case 'provision':
          await this.boot(command);
          return;
        case 'hqPort':
          if (ports[0]) this.connectHq(ports[0]);
          return;
        case 'restart':
          if (this.options) await this.boot({ ...this.options, fresh: false });
          return;
      }
      if (!node) return;
      switch (command.kind) {
        case 'setFaults':
          node.setFaults(command.plan);
          break;
        case 'addTask':
          node.submitTask(command.spec, command.source);
          break;
        case 'observe':
          node.observe(command.key, command.value, command.options);
          break;
        case 'ferryStart':
          await sendFerry(node, command.ferryId, command.remote, command.frameMs);
          break;
        case 'ferryFrame':
          this.receiver ??= new FerryReceiver();
          await this.receiver.take(node, command.ferryId, command.pixels);
          break;
        case 'requestEvents': {
          const view = node.view();
          reportToStage({ kind: 'events', requestId: command.requestId, events: node.events(), hqSeen: view.hqSeen, hqBackfilled: view.hqBackfilled });
          break;
        }
      }
    } catch (error) {
      reportToStage({ kind: 'failed', message: messageOf(error) });
    }
  }

  private async boot(options: BootOptions) {
    const run = ++this.bootRun;
    const previous = this.current.node;
    this.stop();
    this.options = options;
    this.update({ phase: 'booting', node: null, error: null });
    try {
      const { bundle, autopilot, tickMs, fresh, relay } = options;
      const namespace = namespaceOf(bundle);
      await previous?.settled();
      if (fresh) await wipeStorage(namespace);
      const storage = createIdbStorage(namespace);
      const restored = ((await storage.load())?.events.length ?? 0) > 0;
      const signal = insideStage() ? undefined : wsSignalClient(signalUrl(relay));
      const node = createActor({ bundle, connector: webrtcConnector(), signal, storage, autopilot, tickMs });
      await node.start();
      if (run !== this.bootRun) {
        node.stop();
        return;
      }
      this.signal = signal ?? null;
      this.teardown.push(this.watch(node));
      this.update({ phase: 'running', node });
      reportToStage({ kind: 'booted', actor: node.id, team: node.team, restored });
      if (this.pendingPort) this.connectHq(this.pendingPort);
    } catch (error) {
      if (run === this.bootRun) this.fail(error);
    }
  }

  private connectHq(port: MessagePort) {
    const node = this.current.node;
    if (!node) {
      this.pendingPort = port;
      return;
    }
    this.pendingPort = null;
    const next = portSignalClient(port, HQ_HEARTBEAT);
    const previous = this.signal;
    this.signal = next;
    node.setSignal(next);
    previous?.close();
  }

  /** Mirrors the actor to the stage. A phone has no stage, so nothing is sent there. */
  private watch(node: ActorNode): () => void {
    if (!insideStage()) return () => undefined;
    const seen = new Set<string>();
    let queued: ReturnType<typeof setTimeout> | null = null;
    const report = () => {
      queued = null;
      const view = node.view();
      reportToStage({ kind: 'view', view: compactView(view, Date.now()) });
      for (const decision of view.refusals) {
        if (seen.has(decision.id)) continue;
        seen.add(decision.id);
        reportToStage({ kind: 'refusal', decision });
      }
    };
    const unsubscribe = node.subscribe(() => {
      queued ??= setTimeout(report, REPORT_MS);
    });
    const links = setInterval(() => {
      const view = node.view();
      reportToStage({ kind: 'links', links: view.links, reachable: view.reachable, signalUp: view.signalUp, at: Date.now() });
    }, LINK_REPORT_MS);
    report();
    return () => {
      unsubscribe();
      clearInterval(links);
      if (queued) clearTimeout(queued);
    };
  }

  private stop() {
    this.teardown.forEach((fn) => fn());
    this.teardown = [];
    this.current.node?.stop();
    this.signal?.close();
    this.signal = null;
    this.receiver = null;
  }

  private fail(error: unknown) {
    const message = messageOf(error);
    this.update({ phase: 'failed', node: null, error: message });
    reportToStage({ kind: 'failed', message });
  }

  private update(patch: Partial<DeviceSnapshot>) {
    this.current = { ...this.current, ...patch };
    this.listeners.forEach((listener) => listener());
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const runtime = new DeviceRuntime();

export function startDevice(fragment: { bundle?: string; relay?: string }) {
  runtime.start(fragment);
}

export function useDevice(): DeviceSnapshot {
  return useSyncExternalStore(runtime.subscribe, runtime.snapshot);
}
