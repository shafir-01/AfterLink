import type { ActorId, SignalMessage } from '@afterlink/protocol';

export interface HubLike {
  connect(send: (m: SignalMessage) => void): { receive(m: SignalMessage): void; close(): void };
  state(): unknown;
}
export type HubFactory = () => HubLike;

export interface Hq {
  /** Open a signalling session. Returns null while the relay is killed. */
  open(send: (m: SignalMessage) => void, onClose: () => void): { receive(m: SignalMessage): void; close(): void } | null;
  kill(): number;
  restore(): void;
  alive(): boolean;
  stats(): { alive: boolean; sessions: number; reports: number; lastReportAt: number | null; actors: number };
}

/** Observer only: relays signalling and counts reports. It never replies with a decision. */
export function createHq(makeHub: HubFactory): Hq {
  let hub: HubLike | null = makeHub();
  const sessions = new Set<{ close(): void }>();
  const seen = new Set<ActorId>();
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
          conn.close();
          onClose();
        },
      };
      sessions.add(s);
      return {
        receive(m) {
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
    kill() {
      const n = sessions.size;
      hub = null;
      for (const s of [...sessions]) s.close();
      return n;
    },
    restore() {
      if (!hub) hub = makeHub();
    },
    alive: () => hub !== null,
    stats: () => ({ alive: hub !== null, sessions: sessions.size, reports, lastReportAt, actors: seen.size }),
  };
}
