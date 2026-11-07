import { useEffect, useMemo, useRef, useState } from 'react';
import type { ActorId, ProvisionBundle, SignalClient } from '@afterlink/protocol';
import { wsSignalClient } from '@afterlink/mesh';
import { DeviceHandle, deviceSrc, type DeviceReport } from '../bridge';
import { decodeBundle, signalUrl } from '../device/provisionLink';
import { PULSE_MS } from '../hq';
import { ControlChannel, controlRoom, verifyCommand, type PhoneMessage, type SignedCommand } from './control';
import './stage.css';

const STATUS_MS = 700;
const EVENTS_PER_PART = 60;

/** Runs on the phone around its device: joins the lead's room, bridges HQ to the relay and obeys signed drill commands. */
class PhoneShell {
  readonly handle: DeviceHandle;
  private control: ControlChannel;
  private lead: ActorId;
  private lastN = 0;
  private epoch = 0;
  private wantHq = true;
  private mission: { ws: SignalClient; beat: ReturnType<typeof setInterval>; ports: MessagePort[] } | null = null;
  private latest = new Map<string, DeviceReport>();
  private flush: ReturnType<typeof setInterval>;

  constructor(
    private readonly bundle: ProvisionBundle,
    private readonly url: string,
  ) {
    this.lead = bundle.genesis.body.capsule.issuer;
    this.handle = new DeviceHandle(`phone-${bundle.team}`);
    this.handle.on((r) => this.heard(r));
    this.handle.send({ kind: 'provision', bundle, autopilot: false, fresh: false });
    this.control = new ControlChannel(url, controlRoom(bundle.room), bundle.actor, { message: (from, data) => this.command(from, data as SignedCommand) });
    this.flush = setInterval(() => {
      for (const report of this.latest.values()) this.tell({ report });
      this.latest.clear();
    }, STATUS_MS);
  }

  stop() {
    clearInterval(this.flush);
    this.dropHq();
    this.control.close();
    this.handle.dispose();
  }

  private heard(report: DeviceReport) {
    switch (report.kind) {
      case 'booted':
        if (this.wantHq) this.connectHq();
        this.tell({ report });
        break;
      case 'view':
      case 'links':
        this.latest.set(report.kind, report);
        break;
      case 'ready':
      case 'ferryFrame':
        break;
      case 'events': {
        const parts = Math.max(1, Math.ceil(report.events.length / EVENTS_PER_PART));
        for (let part = 0; part < parts; part++) {
          const events = report.events.slice(part * EVENTS_PER_PART, (part + 1) * EVENTS_PER_PART);
          this.tell({ report: { ...report, events, hqSeen: part ? [] : report.hqSeen, hqBackfilled: part ? [] : report.hqBackfilled }, part, parts });
        }
        break;
      }
      default:
        this.tell({ report });
    }
  }

  private tell(message: PhoneMessage) {
    this.control.send(this.lead, message);
  }

  private command(from: ActorId, c: SignedCommand) {
    if (from !== this.lead || !c || c.n <= this.lastN || !verifyCommand(this.lead, c)) return;
    this.lastN = c.n;
    if (c.body.kind !== 'hq') {
      this.handle.send(c.body);
      return;
    }
    this.wantHq = c.body.up;
    if (c.body.up) this.connectHq();
    else this.dropHq();
  }

  /** The device speaks to HQ over ports, as it does on the stage. Here the far end of those ports is the relay. */
  private connectHq() {
    this.dropHq();
    const ws = wsSignalClient(this.url);
    const signal = new MessageChannel();
    const pulse = new MessageChannel();
    signal.port1.onmessage = (e: MessageEvent) => {
      if (e.data?.t !== 'hb') ws.send(e.data);
      else if (ws.connected) signal.port1.postMessage(e.data);
    };
    ws.onMessage((m) => signal.port1.postMessage(m));
    const beat = setInterval(() => pulse.port1.postMessage(0), PULSE_MS);
    this.mission = { ws, beat, ports: [signal.port1, pulse.port1] };
    this.handle.send({ kind: 'hqPort', epoch: ++this.epoch }, [signal.port2, pulse.port2]);
  }

  private dropHq() {
    if (!this.mission) return;
    clearInterval(this.mission.beat);
    this.mission.ws.close();
    this.mission.ports.forEach((p) => p.close());
    this.mission = null;
  }
}

export function Join({ encoded, relay }: { encoded: string; relay?: string }) {
  const [bundle, setBundle] = useState<ProvisionBundle | null>(null);
  const [failed, setFailed] = useState(false);
  const shell = useRef<PhoneShell | null>(null);

  useEffect(() => {
    let live = true;
    decodeBundle(encoded)
      .then((b) => live && setBundle(b))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [encoded]);

  const src = useMemo(() => (bundle ? deviceSrc(`phone-${bundle.team}`) : null), [bundle]);

  useEffect(() => {
    if (!bundle) return;
    const s = new PhoneShell(bundle, signalUrl(relay));
    shell.current = s;
    return () => {
      s.stop();
      shell.current = null;
    };
  }, [bundle, relay]);

  if (failed) {
    return (
      <main className="al-center">
        <p>This link is not valid. Scan the code on the lead screen again.</p>
      </main>
    );
  }
  if (!src) return null;
  return <iframe className="st-join" ref={(el) => shell.current?.handle.attach(el)} title={`${bundle?.name} device`} src={src} allow="microphone; camera; autoplay" />;
}
