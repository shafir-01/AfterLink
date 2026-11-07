import { fromB64u, sha256 } from '@afterlink/protocol';
import type { ActorId, AnyEvent, EventId } from '@afterlink/protocol';
import { WORDS } from './words.ts';

export interface ActorHead {
  actor: ActorId;
  /** The last event of this actor's chain. A forked actor has several, lowest position first. */
  tips: { seq: number; id: EventId }[];
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Each actor's chain tips: events no other event of that actor names as `prev`. */
export function missionHeads(events: AnyEvent[]): ActorHead[] {
  const unique = new Map(events.map((e) => [e.id, e]));
  const extended = new Set<string>();
  for (const e of unique.values()) if (e.prev) extended.add(`${e.actor} ${e.prev}`);
  const heads = new Map<ActorId, ActorHead>();
  for (const e of unique.values()) {
    if (extended.has(`${e.actor} ${e.id}`)) continue;
    const head = heads.get(e.actor) ?? { actor: e.actor, tips: [] };
    head.tips.push({ seq: e.seq, id: e.id });
    heads.set(e.actor, head);
  }
  for (const head of heads.values()) head.tips.sort((a, b) => a.seq - b.seq || compareText(a.id, b.id));
  return [...heads.values()].sort((a, b) => compareText(a.actor, b.actor));
}

const leafOf = (h: ActorHead): string => sha256(`afterlink-leaf\n${h.actor}\n${h.tips.map((t) => `${t.seq}:${t.id}`).join('\n')}`);

const nodeOf = (left: string, right: string): string => sha256(`afterlink-node\n${left}\n${right}`);

/** A lone node rises unchanged, so no two leaf sets can share a tree by duplicating a branch. */
function merkleTop(leaves: string[]): string {
  if (leaves.length === 0) return sha256('afterlink-empty');
  let level = leaves;
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const right = level[i + 1];
      next.push(right === undefined ? level[i]! : nodeOf(level[i]!, right));
    }
    level = next;
  }
  return level[0]!;
}

/**
 * Merkle root over the per-actor chain heads. Every head hashes its whole chain, so the root
 * commits to the full history and depends only on the set of events, never on their order.
 */
export function missionFingerprint(events: AnyEvent[]): string {
  const heads = missionHeads(events);
  return sha256(`afterlink-root\n${heads.length}\n${merkleTop(heads.map(leafOf))}`);
}

const PHRASE_WORDS = 6;
const BITS_PER_WORD = 10;

/** The first 60 bits of a fingerprint as six words someone can read aloud. */
export function fingerprintWords(hash: string): string[] {
  const bytes = fromB64u(hash);
  if (bytes.length < 8) throw new Error('Fingerprint is too short');
  let bits = 0n;
  for (const byte of bytes.subarray(0, 8)) bits = (bits << 8n) | BigInt(byte);
  const words: string[] = [];
  for (let i = 1; i <= PHRASE_WORDS; i++) words.push(WORDS[Number((bits >> BigInt(64 - BITS_PER_WORD * i)) & 1023n)]!);
  return words;
}
