import { bodyError } from './body.ts';
import { canonicalize } from './canonical.ts';
import { fromB64u, sha256, signBytes, verifyBytes, type KeyPair } from './crypto.ts';
import type { AnyEvent, EventBodies, EventEnvelope, EventId, EventType, MissionId } from './types.ts';

/** Largest canonical event accepted from a peer. */
export const MAX_EVENT_BYTES = 16 * 1024;
/** A mission capsule is the one legitimately large event, and there is one per mission. */
export const MAX_GENESIS_BYTES = 256 * 1024;
export const MAX_PARENTS = 256;

export interface EventDraft<T extends EventType> {
  keys: KeyPair;
  mission: MissionId;
  seq: number;
  prev: EventId | null;
  parents: EventId[];
  lamport: number;
  wall: number;
  type: T;
  body: EventBodies[T];
}

export type Verdict = { ok: true } | { ok: false; reason: string };

/** Signature checks repeat across replicas in one process. Entries bind a recomputed id to its signature. */
const verified = new Set<string>();
const VERIFIED_LIMIT = 1 << 16;

const utf8 = new TextEncoder();

export function eventId(unsigned: object): EventId {
  return sha256(canonicalize(unsigned));
}

function shapeError(u: Record<string, unknown>): string | null {
  if (u.v !== 1) return 'unsupported version';
  if (typeof u.mission !== 'string' || !u.mission) return 'missing mission';
  if (typeof u.actor !== 'string' || !u.actor) return 'missing actor';
  if (!Number.isSafeInteger(u.seq) || (u.seq as number) < 1) return 'seq must be a positive integer';
  if (u.seq === 1 ? u.prev !== null : typeof u.prev !== 'string') return 'prev does not fit seq';
  if (!Array.isArray(u.parents) || u.parents.some((p) => typeof p !== 'string')) return 'parents must be event ids';
  if (!Number.isSafeInteger(u.lamport) || (u.lamport as number) < 0) return 'lamport must be a non-negative integer';
  if (typeof u.wall !== 'number' || !Number.isFinite(u.wall)) return 'wall must be a finite number';
  if (typeof u.type !== 'string' || !u.type) return 'missing type';
  if (typeof u.body !== 'object' || u.body === null) return 'body must be an object';
  return null;
}

/**
 * The returned event is exactly what every peer will decode: its body is normalised through
 * the canonical form. Contract rules on type, body and size are enforced by `verifyEvent`.
 */
export function createEvent<T extends EventType>(a: EventDraft<T>): EventEnvelope<T> {
  const unsigned = JSON.parse(
    canonicalize({
      v: 1,
      mission: a.mission,
      actor: a.keys.publicKey,
      seq: a.seq,
      prev: a.prev,
      parents: [...new Set(a.parents)].sort(),
      lamport: a.lamport,
      wall: a.wall,
      type: a.type,
      body: a.body,
    }),
  ) as Omit<EventEnvelope<T>, 'id' | 'sig'>;
  const problem = shapeError(unsigned as unknown as Record<string, unknown>);
  if (problem) throw new TypeError(`Cannot create event: ${problem}`);
  const id = eventId(unsigned);
  return { ...unsigned, id, sig: signBytes(a.keys.secretKey, fromB64u(id)) };
}

/** Accepts anything off the wire. Never throws. */
export function verifyEvent(e: AnyEvent): Verdict {
  try {
    const { id, sig, ...unsigned } = e;
    const problem = shapeError(unsigned) ?? bodyError(e.type, e.body);
    if (problem) return { ok: false, reason: problem };
    if (e.parents.length > MAX_PARENTS) return { ok: false, reason: 'too many parents' };
    if (typeof id !== 'string' || typeof sig !== 'string') return { ok: false, reason: 'missing id or signature' };
    const bytes = utf8.encode(canonicalize(unsigned));
    if (bytes.length > (e.type === 'mission.issued' ? MAX_GENESIS_BYTES : MAX_EVENT_BYTES)) {
      return { ok: false, reason: 'event too large' };
    }
    if (sha256(bytes) !== id) return { ok: false, reason: 'id does not match content' };
    const entry = `${id}.${sig}`;
    if (verified.has(entry)) return { ok: true };
    if (!verifyBytes(e.actor, fromB64u(id), sig)) return { ok: false, reason: 'bad signature' };
    if (verified.size >= VERIFIED_LIMIT) verified.clear();
    verified.add(entry);
    return { ok: true };
  } catch {
    return { ok: false, reason: 'unreadable event' };
  }
}
