import type { ActorId, SignalMessage, TaskSpec } from '@afterlink/protocol';

export interface HubLike {
  connect(send: (m: SignalMessage) => void): { receive(m: SignalMessage): void; close(): void };
  state(): unknown;
  ingress?(ref: string, spec: TaskSpec): 'delivered' | 'queued' | 'duplicate';
  onChange?(fn: () => void): () => void;
}
export type HubFactory = () => HubLike;

export interface Hq {
  /** Open a signalling session. Returns null while the relay is killed. */
  open(send: (m: SignalMessage) => void, onClose: () => void): { receive(m: SignalMessage): void; close(): void } | null;
  kill(): number;
  restore(): void;
  alive(): boolean;
  /** Send an ingress message to one connected device. False when none is connected. */
  deliver(msg: Extract<SignalMessage, { t: 'ingress' }>): boolean;
  onDeviceReady(fn: () => void): void;
  stats(): { alive: boolean; sessions: number; reports: number; lastReportAt: number | null; actors: number };
}

/** Observer only: relays signalling and counts reports. It never replies with a decision. */
export function createHq(makeHub: HubFactory): Hq {
  let hub: HubLike | null = null;
  const sessions = new Set<{ close(): void }>();
  const seen = new Set<ActorId>();
  const devices = new Map<{ close(): void }, (m: SignalMessage) => void>();
  const ready: Array<() => void> = [];
  const fireReady = () => {
    for (const fn of ready) fn();
  };
  const build = (): HubLike => {
    const h = makeHub();
    h.onChange?.(fireReady);
    return h;
  };
  hub = build();
  let reports = 0;
  let lastReportAt: number | null = null;

  return {
    open(send, onClose) {
      if (!hub) return null;
      let conn: { receive(m: SignalMessage): void; close(): void };
      try {
        conn = hub.connect(send);
      } catch {
        return null;
      }
      const s = {
        close() {
          sessions.delete(s);
          devices.delete(s);
          conn.close();
          onClose();
        },
      };
      sessions.add(s);
      return {
        receive(m) {
          if (m.t === 'hello' && !devices.has(s)) {
            devices.set(s, send);
            fireReady();
          }
          if (m.t === 'report') {
            reports++;
            lastReportAt = Date.now();
            seen.add(m.actor);
          }
          conn.receive(m);
        },
        close: s.close,
      };
    },
    deliver(msg) {
      if (hub?.ingress) {
        const r = hub.ingress(msg.ref, msg.spec);
        if (r === 'delivered') return true;
        if (r === 'queued') return false;
        const st = hub.state() as { ingress?: { delivered: { ref: string }[] } } | null;
        return Boolean(st?.ingress?.delivered.some((d) => d.ref === msg.ref));
      }
      for (const [s, send] of devices) {
        if (!sessions.has(s)) continue;
        try {
          send(msg);
          return true;
        } catch {
          devices.delete(s);
        }
      }
      return false;
    },
    onDeviceReady(fn) {
      ready.push(fn);
    },
    kill() {
      const n = sessions.size;
      hub = null;
      for (const s of [...sessions]) s.close();
      return n;
    },
    restore() {
      if (!hub) hub = build();
    },
    alive: () => hub !== null,
    stats: () => ({ alive: hub !== null, sessions: sessions.size, reports, lastReportAt, actors: seen.size }),
  };
}
