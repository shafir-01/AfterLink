import type { ActorId, ProvisionBundle } from '@afterlink/protocol';
import type { DeviceCommand, DeviceReport } from '../bridge';
import { encodeBundle, signalUrl } from '../device/provisionLink';
import { ControlChannel, controlRoom, signCommand, type LeadCommand, type PhoneMessage } from './control';
import type { DeviceLink, HostHq, MissionHost } from './host';

const RELAY_WAIT_MS = 7000;

export interface RoomState {
  /** The link each team's QR opens. */
  links: Record<ActorId, string>;
  joined: ActorId[];
  relay: string;
}

class RemoteDevice implements DeviceLink {
  private listeners = new Set<(report: DeviceReport) => void>();
  private parts: Extract<DeviceReport, { kind: 'events' }>[] = [];

  constructor(private readonly post: (command: LeadCommand) => void) {}

  send(command: DeviceCommand) {
    if (command.kind !== 'provision') this.post(command);
  }

  on(listener: (report: DeviceReport) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose() {
    this.listeners.clear();
  }

  hear({ report, part, parts }: PhoneMessage) {
    if (report.kind !== 'events' || !parts) {
      this.listeners.forEach((fn) => fn(report));
      return;
    }
    this.parts[part ?? 0] = report;
    if (this.parts.filter(Boolean).length < parts) return;
    const all = this.parts;
    this.parts = [];
    this.listeners.forEach((fn) => fn({ ...report, events: all.flatMap((p) => p.events) }));
  }
}

/** Real phones behind the relay. HQ is the relay: phones drop or take back their link to it on command. */
export class RelayHost implements MissionHost {
  readonly humans = true;
  private devices = new Map<ActorId, RemoteDevice>();
  private control: ControlChannel | null = null;
  private listeners = new Set<() => void>();
  private state: RoomState = { links: {}, joined: [], relay: '' };
  private alive = true;
  private n = 0;
  private onHq: () => void = () => undefined;
  private onFail: (message: string) => void = () => undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private issuer: { publicKey: ActorId; secretKey: string } | null = null;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  roomState = () => this.state;

  room() {
    return `lead-${crypto.randomUUID().slice(0, 13)}`;
  }

  begin(onHq: () => void, onFail: (message: string) => void) {
    this.onHq = onHq;
    this.onFail = onFail;
    this.alive = true;
  }

  device(_run: number, _index: number, bundle: ProvisionBundle) {
    const id = bundle.actor.publicKey;
    const link = new RemoteDevice((command) => this.post(id, command));
    this.devices.set(id, link);
    return { link, src: '' };
  }

  ready(bundles: ProvisionBundle[], issuer: { publicKey: ActorId; secretKey: string }) {
    const url = signalUrl();
    const first = bundles[0];
    if (!first) return;
    this.issuer = issuer;
    const relay = new URL(url.replace(/^ws/, 'http')).origin;
    this.control = new ControlChannel(url, controlRoom(first.room), issuer, {
      message: (from, data) => this.devices.get(from)?.hear(data as PhoneMessage),
      presence: (here) => this.update({ joined: [...here] }),
      state: (up) => {
        if (up) clearTimeout(this.timer);
      },
    });
    this.timer = setTimeout(() => {
      if (!this.control?.connected) this.onFail(`Cannot reach the relay at ${relay}. Real phones need one.`);
    }, RELAY_WAIT_MS);
    void Promise.all(
      bundles.map(async (b) => {
        const query = new URLSearchParams({ join: await encodeBundle(b), relay });
        return [b.actor.publicKey, `${window.location.origin}${window.location.pathname}#/lead?${query}`] as const;
      }),
    ).then((pairs) => this.update({ links: Object.fromEntries(pairs), relay }));
  }

  hq(): HostHq {
    return { alive: this.alive, state: null, lastConfirmedAt: null };
  }

  killHq() {
    this.setHq(false);
  }

  restoreHq() {
    this.setHq(true);
  }

  attach() {
    return undefined;
  }

  end() {
    clearTimeout(this.timer);
    this.control?.close();
    this.control = null;
    this.devices = new Map();
    this.state = { links: {}, joined: [], relay: '' };
  }

  private setHq(up: boolean) {
    this.alive = up;
    for (const id of this.devices.keys()) this.post(id, { kind: 'hq', up });
    this.onHq();
  }

  private post(id: ActorId, command: LeadCommand) {
    if (this.issuer) this.control?.send(id, signCommand(this.issuer.secretKey, ++this.n, command));
  }

  private update(patch: Partial<RoomState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((fn) => fn());
  }
}
