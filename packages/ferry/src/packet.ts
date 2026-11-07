import {
  canonicalize,
  sha256,
  signBytes,
  verifyBytes,
  verifyEvent,
  type EventLog,
} from '@afterlink/protocol';
import type { ActorId, AnyEvent, EventType, FerryPacket, MissionId, SyncSummary } from '@afterlink/protocol';

const enc = new TextEncoder();
const SECRET_KEY = /secret|private/i;

export const DEFAULT_MAX_EVENTS = 80;

export interface DroppedEvent {
  id: string;
  type: EventType;
  actor: ActorId;
  seq: number;
  reason: 'over-budget';
}

export interface PacketPlan {
  packet: FerryPacket;
  dropped: DroppedEvent[];
  /** Events the receiver is believed to be missing, before the budget was applied. */
  candidates: number;
}

/** Lower is more important. Link telemetry is always last. */
export function priorityOf(type: EventType): number {
  if (type.startsWith('right.') || type.startsWith('task.')) return 0;
  if (type === 'observation.recorded') return 1;
  if (type === 'link.changed') return 3;
  return 2;
}

function hasSecret(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasSecret);
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([k, v]) => SECRET_KEY.test(k) || hasSecret(v));
  }
  return false;
}

function signedBytes(p: FerryPacket): Uint8Array {
  const { sig: _sig, ...rest } = p;
  return enc.encode(canonicalize(rest));
}

function packetId(a: { mission: MissionId; from: ActorId; createdAt: number; events: AnyEvent[] }): string {
  return sha256(canonicalize({ m: a.mission, f: a.from, t: a.createdAt, e: a.events.map((e) => e.id) })).slice(0, 22);
}

/**
 * Selects the events the receiver lacks, keeps every actor's chain contiguous from the
 * receiver's known head, and reports what did not fit.
 */
export function planPacket(a: {
  keys: { publicKey: ActorId; secretKey: string };
  log: EventLog;
  remote?: SyncSummary;
  maxEvents?: number;
  wall?: number;
}): PacketPlan {
  const max = a.maxEvents ?? DEFAULT_MAX_EVENTS;
  const all = a.log.all();
  const actors = new Set(all.map((e) => e.actor));
  const chains = new Map<ActorId, AnyEvent[]>();
  const included = new Map<ActorId, number>();
  const candidates: AnyEvent[] = [];

  for (const actor of actors) {
    const own = a.log.byActor(actor).filter((e) => e.type !== 'mission.issued');
    if (!own.length) continue;
    const head = a.remote?.heads[actor];
    let expect = head ? head.seq + 1 : own[0]!.seq;
    const chain: AnyEvent[] = [];
    for (const e of own) {
      if (e.seq < expect) continue;
      if (e.seq !== expect) break;
      chain.push(e);
      expect++;
    }
    if (!chain.length) continue;
    chains.set(actor, chain);
    included.set(actor, chain[0]!.seq - 1);
    candidates.push(...chain);
  }

  const ranked = [...candidates].sort(
    (x, y) => priorityOf(x.type) - priorityOf(y.type) || y.lamport - x.lamport || x.id.localeCompare(y.id),
  );
  let total = 0;
  for (const e of ranked) {
    const top = included.get(e.actor)!;
    const cost = Math.max(0, e.seq - top);
    if (total + cost > max) continue;
    total += cost;
    included.set(e.actor, Math.max(top, e.seq));
  }

  const chosen = new Set<string>();
  for (const [actor, chain] of chains) {
    const top = included.get(actor)!;
    for (const e of chain) if (e.seq <= top) chosen.add(e.id);
  }
  const events = all.filter((e) => chosen.has(e.id));
  const dropped: DroppedEvent[] = candidates
    .filter((e) => !chosen.has(e.id))
    .map((e) => ({ id: e.id, type: e.type, actor: e.actor, seq: e.seq, reason: 'over-budget' as const }));

  if (hasSecret(events)) throw new Error('ferry: event bodies must not carry secrets');

  const createdAt = a.wall ?? Date.now();
  const mission = all[0]?.mission ?? a.remote?.mission ?? '';
  const packet: FerryPacket = {
    v: 1,
    id: packetId({ mission, from: a.keys.publicKey, createdAt, events }),
    mission,
    from: a.keys.publicKey,
    createdAt,
    events,
    summary: a.log.summary(),
    sig: '',
  };
  packet.sig = signBytes(a.keys.secretKey, signedBytes(packet));
  return { packet, dropped, candidates: candidates.length };
}

export function buildPacket(a: Parameters<typeof planPacket>[0]): FerryPacket {
  return planPacket(a).packet;
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export function verifyPacket(
  p: FerryPacket,
  opts: { mission?: MissionId; now?: number; maxAgeMs?: number } = {},
): VerifyResult {
  if (!p || p.v !== 1 || !Array.isArray(p.events) || !p.summary) return { ok: false, reason: 'malformed packet' };
  if (opts.mission !== undefined && p.mission !== opts.mission) return { ok: false, reason: 'wrong mission' };
  if (p.summary.mission !== p.mission) return { ok: false, reason: 'summary mission mismatch' };
  if (hasSecret(p.events) || hasSecret(p.summary)) return { ok: false, reason: 'packet carries secret material' };
  let sigOk = false;
  try {
    sigOk = verifyBytes(p.from, signedBytes(p), p.sig);
  } catch {
    sigOk = false;
  }
  if (!sigOk) return { ok: false, reason: 'bad packet signature' };
  if (p.id !== packetId(p)) return { ok: false, reason: 'packet id mismatch' };
  if (opts.maxAgeMs !== undefined && (opts.now ?? Date.now()) - p.createdAt > opts.maxAgeMs) {
    return { ok: false, reason: 'packet expired' };
  }
  for (const e of p.events) {
    if (e.mission !== p.mission) return { ok: false, reason: 'event from another mission' };
    const r = verifyEvent(e);
    if (!r.ok) return { ok: false, reason: `invalid event ${e.id}: ${r.reason}` };
  }
  return { ok: true };
}

/** Verifies and applies a packet. Ingesting the same packet again changes nothing. */
export function ingestPacket(
  log: EventLog,
  p: FerryPacket,
  opts: { mission: MissionId; now?: number; maxAgeMs?: number },
): { ok: boolean; reason?: string; newEvents: number; duplicates: number; rejected: number } {
  const v = verifyPacket(p, opts);
  if (!v.ok) return { ok: false, reason: v.reason, newEvents: 0, duplicates: 0, rejected: p.events?.length ?? 0 };
  const r = log.ingestMany(p.events);
  return { ok: true, newEvents: r.added.length, duplicates: r.duplicates, rejected: r.invalid.length + r.forks.length };
}
