// Minimal stand-in for @afterlink/protocol, used only while the real module is absent.
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 as nobleSha } from '@noble/hashes/sha2.js';
import type { AnyEvent, SyncSummary } from '../../protocol/src/types.ts';

export function canonicalize(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonicalize(x))).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalize(o[k])}`)
    .join(',')}}`;
}
export function b64u(b: Uint8Array): string {
  return Buffer.from(b).toString('base64url');
}
export function fromB64u(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64url'));
}
export function sha256(d: string | Uint8Array): string {
  return b64u(nobleSha(typeof d === 'string' ? new TextEncoder().encode(d) : d));
}
export function generateKeys() {
  const sk = ed25519.utils.randomSecretKey();
  return { publicKey: b64u(ed25519.getPublicKey(sk)), secretKey: b64u(sk) };
}
export function signBytes(sk: string, data: Uint8Array): string {
  return b64u(ed25519.sign(data, fromB64u(sk)));
}
export function verifyBytes(pk: string, data: Uint8Array, sig: string): boolean {
  return ed25519.verify(fromB64u(sig), data, fromB64u(pk));
}
export function createEvent(a: any): AnyEvent {
  const unsigned = {
    v: 1, mission: a.mission, actor: a.keys.publicKey, seq: a.seq, prev: a.prev, parents: a.parents,
    lamport: a.lamport, wall: a.wall, type: a.type, body: a.body,
  };
  const id = sha256(canonicalize(unsigned));
  return { ...unsigned, id, sig: signBytes(a.keys.secretKey, fromB64u(id)) } as AnyEvent;
}
export function verifyEvent(e: AnyEvent): { ok: true } | { ok: false; reason: string } {
  const { id, sig, ...rest } = e as any;
  if (sha256(canonicalize(rest)) !== id) return { ok: false, reason: 'id mismatch' };
  try {
    return verifyBytes(e.actor, fromB64u(id), sig) ? { ok: true } : { ok: false, reason: 'bad signature' };
  } catch {
    return { ok: false, reason: 'bad signature' };
  }
}
export class EventLog {
  private byId = new Map<string, AnyEvent>();
  private chains = new Map<string, AnyEvent[]>();
  private pending: AnyEvent[] = [];
  constructor(public mission: string) {}
  get size() { return this.byId.size; }
  has(id: string) { return this.byId.has(id); }
  get(id: string) { return this.byId.get(id); }
  ingest(e: AnyEvent): 'added' | 'duplicate' | 'gap' | 'invalid' | 'fork' {
    if (e.mission !== this.mission || !verifyEvent(e).ok) return 'invalid';
    if (this.byId.has(e.id)) return 'duplicate';
    const chain = this.chains.get(e.actor) ?? [];
    if (e.seq <= chain.length) return 'fork';
    if (e.seq > chain.length + 1 || (chain.length && e.prev !== chain[chain.length - 1]!.id)) {
      this.pending.push(e);
      return 'gap';
    }
    chain.push(e);
    this.chains.set(e.actor, chain);
    this.byId.set(e.id, e);
    const next = this.pending.find((p) => p.actor === e.actor && p.seq === e.seq + 1);
    if (next) {
      this.pending = this.pending.filter((p) => p !== next);
      this.ingest(next);
    }
    return 'added';
  }
  ingestMany(es: AnyEvent[]) {
    const r = { added: [] as AnyEvent[], duplicates: 0, gaps: 0, invalid: [] as AnyEvent[], forks: [] as AnyEvent[] };
    for (const e of es) {
      const s = this.ingest(e);
      if (s === 'added') r.added.push(e);
      else if (s === 'duplicate') r.duplicates++;
      else if (s === 'gap') r.gaps++;
      else if (s === 'invalid') r.invalid.push(e);
      else r.forks.push(e);
    }
    return r;
  }
  all(): AnyEvent[] {
    return [...this.byId.values()].sort((a, b) => a.lamport - b.lamport || a.actor.localeCompare(b.actor) || a.seq - b.seq);
  }
  byActor(a: string) { return this.chains.get(a) ?? []; }
  heads() { return [...this.chains.values()].map((c) => c[c.length - 1]!.id); }
  summary(): SyncSummary {
    const heads: SyncSummary['heads'] = {};
    for (const [a, c] of this.chains) heads[a] = { seq: c.length, id: c[c.length - 1]!.id };
    return { mission: this.mission, heads };
  }
  lamport() { return Math.max(0, ...this.all().map((e) => e.lamport)); }
}
