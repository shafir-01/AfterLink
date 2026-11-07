import { b64u, canonicalize, verifyBytes, verifyEvent } from '@afterlink/protocol';
import type { ActorId, AnyEvent, EventId, LinkInfo, SignalMessage, TaskSpec } from '@afterlink/protocol';

/** Liveness frame between a signalling client and the hub. Answered in kind, never forwarded. */
export const HEARTBEAT = { t: 'hb' } as const;
/** Hub to device: sign this nonce to prove you hold the key behind your actor id. */
export interface HubChallenge {
  t: 'challenge';
  nonce: string;
}
export type ProvedHello = Extract<SignalMessage, { t: 'hello' }> & { nonce: string; sig: string };
export type HubFrame = SignalMessage | typeof HEARTBEAT | HubChallenge;

/** Events accepted from one report. Devices report in much smaller batches. */
const MAX_REPORT_EVENTS = 512;

/** The bytes a device signs to answer a hub challenge. */
export function helloProofBytes(room: string, actor: ActorId, nonce: string): Uint8Array {
  return new TextEncoder().encode(canonicalize({ domain: 'afterlink/hello/1', room, actor, nonce }));
}

export interface HubActor {
  actor: ActorId;
  room: string | null;
  connected: boolean;
  /** True when the current connection proved it holds this actor's key. */
  proved: boolean;
  /** Hub time of the freshest information about this actor: a report from it, or a new event by it. */
  lastConfirmedAt: number | null;
  lastSeq: number;
  /** Link table from the actor's latest report. */
  links: LinkInfo[];
}

export interface HubState {
  rooms: Record<string, ActorId[]>;
  actors: Record<ActorId, HubActor>;
  /** Every event id that reached the observer, in arrival order. */
  seen: EventId[];
  /** Most recent events that reached the observer, oldest first. */
  recent: AnyEvent[];
  ingress: { delivered: { ref: string; to: ActorId }[]; queued: string[] };
}

export interface HubConnection {
  receive(m: SignalMessage): void;
  close(): void;
}

export type IngressResult = 'delivered' | 'queued' | 'duplicate';

export interface Hub {
  connect(send: (m: SignalMessage) => void): HubConnection;
  state(): HubState;
  onChange(fn: () => void): () => void;
  /** Delivers an external request to exactly one connected device, or holds it until one connects. */
  ingress(ref: string, spec: TaskSpec, room?: string): IngressResult;
}

export interface HubOptions {
  now?: () => number;
  recentLimit?: number;
  /** Refuse devices that have not proved their key. Without it a proved device still cannot be displaced. */
  requireProof?: boolean;
  /** Check signatures on reported events. Only a simulation should turn this off. */
  verifyEvents?: boolean;
}

interface Conn {
  send: (m: SignalMessage) => void;
  actor: ActorId | null;
  room: string | null;
  nonce: string | null;
  /** The one actor whose key this connection has proved. */
  provedAs: ActorId | null;
}

/**
 * Signalling hub and read-only observer. It introduces peers and forwards negotiation payloads;
 * it never sits in the data path and never decides anything. No I/O and no timers, so the same code
 * runs inside a Web Worker and inside a Node server.
 */
export function createHub(o: HubOptions = {}): Hub {
  const now = o.now ?? (() => Date.now());
  const recentLimit = o.recentLimit ?? 200;
  const requireProof = o.requireProof ?? false;
  const verifyEvents = o.verifyEvents ?? true;
  const rooms = new Map<string, Map<ActorId, Conn>>();
  const actors = new Map<ActorId, HubActor>();
  const seen = new Set<EventId>();
  const recent: AnyEvent[] = [];
  const delivered = new Map<string, ActorId>();
  const queued = new Map<string, { spec: TaskSpec; room?: string }>();
  const changeFns = new Set<() => void>();
  let ingressCursor = 0;

  const changed = () => {
    for (const fn of [...changeFns]) fn();
  };

  const actorRecord = (actor: ActorId): HubActor => {
    let record = actors.get(actor);
    if (!record) {
      record = { actor, room: null, connected: false, proved: false, lastConfirmedAt: null, lastSeq: 0, links: [] };
      actors.set(actor, record);
    }
    return record;
  };

  const provesKey = (actor: ActorId, room: string, nonce: string, sig: string): boolean => {
    try {
      return verifyBytes(actor, helloProofBytes(room, actor, nonce), sig);
    } catch {
      return false;
    }
  };

  const deliver = (conn: Conn, m: SignalMessage) => {
    try {
      conn.send(m);
    } catch {
      leave(conn);
    }
  };

  const toRoom = (room: Map<ActorId, Conn>, except: ActorId, m: SignalMessage) => {
    for (const [actor, conn] of [...room]) {
      if (actor !== except) deliver(conn, m);
    }
  };

  function leave(conn: Conn): void {
    const { actor, room: roomName } = conn;
    conn.actor = null;
    conn.room = null;
    if (!actor || !roomName) return;
    const room = rooms.get(roomName);
    if (room?.get(actor) !== conn) return;
    room.delete(actor);
    if (room.size === 0) rooms.delete(roomName);
    const record = actorRecord(actor);
    record.connected = false;
    record.proved = false;
    if (room.size > 0) toRoom(room, actor, { t: 'left', actor });
    changed();
  }

  const challenge = (conn: Conn) => {
    conn.nonce = b64u(crypto.getRandomValues(new Uint8Array(16)));
    deliver(conn, { t: 'challenge', nonce: conn.nonce } as unknown as SignalMessage);
  };

  const hello = (conn: Conn, m: Partial<ProvedHello>) => {
    const { room: roomName, actor, sig } = m;
    if (typeof roomName !== 'string' || typeof actor !== 'string') return;
    const holder = rooms.get(roomName)?.get(actor);
    if (sig === undefined) {
      challenge(conn);
      if (requireProof && conn.provedAs !== actor) return;
      if (holder && holder !== conn && holder.provedAs === actor) return;
    } else {
      const nonce = conn.nonce;
      conn.nonce = null;
      if (!nonce || m.nonce !== nonce || !provesKey(actor, roomName, nonce, sig)) return;
      conn.provedAs = actor;
      if (holder === conn) {
        actorRecord(actor).proved = true;
        changed();
        return;
      }
    }
    if (conn.actor !== actor || conn.room !== roomName) leave(conn);
    let room = rooms.get(roomName);
    if (!room) {
      room = new Map();
      rooms.set(roomName, room);
    }
    const previous = room.get(actor);
    if (previous && previous !== conn) {
      previous.actor = null;
      previous.room = null;
    }
    room.set(actor, conn);
    conn.actor = actor;
    conn.room = roomName;
    const record = actorRecord(actor);
    record.room = roomName;
    record.connected = true;
    record.proved = conn.provedAs === actor;
    record.lastConfirmedAt = now();
    deliver(conn, { t: 'peers', peers: [...room.keys()].filter((a) => a !== actor) });
    toRoom(room, actor, { t: 'joined', actor });
    for (const [ref, item] of [...queued]) {
      if (item.room === undefined || item.room === roomName) {
        queued.delete(ref);
        offer(ref, item.spec, item.room);
      }
    }
    changed();
  };

  const report = (conn: Conn, events: AnyEvent[], links: LinkInfo[]) => {
    if (!conn.actor) return;
    const at = now();
    const reporter = actorRecord(conn.actor);
    reporter.lastConfirmedAt = at;
    reporter.links = Array.isArray(links) ? links : [];
    for (const e of Array.isArray(events) ? events.slice(0, MAX_REPORT_EVENTS) : []) {
      if (typeof e?.id !== 'string' || seen.has(e.id)) continue;
      if (verifyEvents && !verifyEvent(e).ok) continue;
      seen.add(e.id);
      recent.push(e);
      if (recent.length > recentLimit) recent.shift();
      const author = actorRecord(e.actor);
      author.lastConfirmedAt = at;
      author.lastSeq = Math.max(author.lastSeq, e.seq);
    }
    changed();
  };

  const devices = (room?: string): [ActorId, Conn][] => {
    const names = room === undefined ? [...rooms.keys()] : [room];
    return names
      .flatMap((name) => [...(rooms.get(name) ?? [])])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  };

  const offer = (ref: string, spec: TaskSpec, room?: string): boolean => {
    const targets = devices(room);
    const target = targets[ingressCursor++ % Math.max(targets.length, 1)];
    if (!target) {
      queued.set(ref, { spec, room });
      return false;
    }
    delivered.set(ref, target[0]);
    deliver(target[1], { t: 'ingress', ref, spec });
    return true;
  };

  const ingress = (ref: string, spec: TaskSpec, room?: string): IngressResult => {
    if (delivered.has(ref) || queued.has(ref)) return 'duplicate';
    const result = offer(ref, spec, room) ? 'delivered' : 'queued';
    changed();
    return result;
  };

  return {
    connect(send) {
      const conn: Conn = { send, actor: null, room: null, nonce: null, provedAs: null };
      return {
        receive(frame) {
          const m = frame as HubFrame;
          switch (m?.t) {
            case 'hb':
              deliver(conn, HEARTBEAT as unknown as SignalMessage);
              break;
            case 'hello':
              hello(conn, m);
              break;
            case 'signal': {
              if (!conn.room || m.from !== conn.actor) break;
              const target = rooms.get(conn.room)?.get(m.to);
              if (target) deliver(target, m);
              break;
            }
            case 'report':
              report(conn, m.events, m.links);
              break;
          }
        },
        close() {
          leave(conn);
        },
      };
    },
    state() {
      return {
        rooms: Object.fromEntries([...rooms].map(([name, room]) => [name, [...room.keys()].sort()])),
        actors: Object.fromEntries([...actors].map(([id, record]) => [id, { ...record }])),
        seen: [...seen],
        recent: [...recent],
        ingress: {
          delivered: [...delivered].map(([ref, to]) => ({ ref, to })),
          queued: [...queued.keys()],
        },
      };
    },
    onChange(fn) {
      changeFns.add(fn);
      return () => changeFns.delete(fn);
    },
    ingress,
  };
}
