import { b64u, fromB64u, sha256, signBytes, verifyBytes } from '@afterlink/protocol';
import type { ActorId, MissionId } from '@afterlink/protocol';
import { HASHES, type CandidateType, type CompactCandidate, type CompactSdp } from './sdp.ts';

const VERSION = 1;
const DOMAIN = 'afterlink/rendezvous/1';
const MISSION_TAG = 4;
const ACTOR_PREFIX = 8;
const NONCE = 8;
const OFFER_REF = 4;
const SIGNATURE = 64;

const FLAG_ANSWER = 1;
const FLAG_TO = 2;
const FLAG_MID = 4;

const TYPES: CandidateType[] = ['host', 'srflx', 'prflx', 'relay'];
const HASH_BYTES = [32, 48, 64, 20];
const FAMILY_IPV4 = 0;
const FAMILY_IPV6 = 1;
const FAMILY_MDNS = 2;
const FAMILY_NAME = 3;

const MDNS = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\.local$/i;

const enc = new TextEncoder();
const dec = new TextDecoder();

export interface Signer {
  publicKey: ActorId;
  secretKey: string;
}

export type Roster = readonly { actor: ActorId }[];

export interface OfferBody {
  kind: 'offer';
  from: ActorId;
  /** Absent means any device on the roster may answer. */
  to?: ActorId;
  nonce: string;
  /** Milliseconds since the epoch, stored at one second resolution. */
  expires: number;
  sdp: CompactSdp;
}

export interface AnswerBody {
  kind: 'answer';
  from: ActorId;
  /** Digest of the exact offer this answers. The signature covers all of it; 4 bytes travel. */
  offer: string;
  sdp: CompactSdp;
}

export type PayloadBody = OfferBody | AnswerBody;

export type OpenFailure = 'malformed' | 'wrong-mission' | 'not-on-roster' | 'bad-signature' | 'wrong-offer';

export type Opened = { ok: true; body: PayloadBody; digest: string } | { ok: false; reason: OpenFailure };

class Writer {
  private out: number[] = [];

  u8(n: number): void {
    this.out.push(n & 0xff);
  }

  u16(n: number): void {
    this.out.push((n >>> 8) & 0xff, n & 0xff);
  }

  u32(n: number): void {
    this.out.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  }

  bytes(b: Uint8Array): void {
    for (const v of b) this.out.push(v);
  }

  done(): Uint8Array {
    return Uint8Array.from(this.out);
  }
}

class Reader {
  at = 0;

  constructor(private data: Uint8Array) {}

  bytes(n: number): Uint8Array {
    if (this.at + n > this.data.length) throw new RangeError('short payload');
    const out = this.data.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }

  u8(): number {
    return this.bytes(1)[0]!;
  }

  u16(): number {
    const b = this.bytes(2);
    return (b[0]! << 8) | b[1]!;
  }

  u32(): number {
    const b = this.bytes(4);
    return b[0]! * 2 ** 24 + (b[1]! << 16) + (b[2]! << 8) + b[3]!;
  }
}

/** ICE strings use the base64 alphabet, so they pack at 6 bits a character. */
function packIce(s: string): Uint8Array {
  if (!s.length || s.length > 255 || !/^[A-Za-z0-9+/]+$/.test(s)) throw new Error('rendezvous: invalid ICE string');
  return fromB64u(s.replace(/\+/g, '-').replace(/\//g, '_').padEnd(Math.ceil(s.length / 4) * 4, 'A'));
}

function packedSize(chars: number): number {
  return Math.ceil(chars / 4) * 3;
}

function unpackIce(bytes: Uint8Array, chars: number): string {
  return b64u(bytes).slice(0, chars).replace(/-/g, '+').replace(/_/g, '/');
}

function ipv4Bytes(s: string): Uint8Array | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((p) => p <= 255) ? Uint8Array.from(parts) : null;
}

function ipv6Bytes(s: string): Uint8Array | null {
  if (!/^[0-9a-f:]+$/i.test(s) || !s.includes(':')) return null;
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || head.length + tail.length + fill !== 8) return null;
  const groups = [...head, ...Array<string>(fill).fill('0'), ...tail];
  if (groups.some((g) => g.length === 0 || g.length > 4)) return null;
  const out = new Uint8Array(16);
  groups.forEach((g, i) => {
    const v = parseInt(g, 16);
    out[i * 2] = v >> 8;
    out[i * 2 + 1] = v & 0xff;
  });
  return out;
}

function ipv6Text(b: Uint8Array): string {
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(((b[i]! << 8) | b[i + 1]!).toString(16));
  return groups.join(':');
}

function hex(b: Uint8Array): string {
  return Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('');
}

function writeCandidate(w: Writer, c: CompactCandidate): void {
  const type = TYPES.indexOf(c.type);
  const v4 = ipv4Bytes(c.address);
  const v6 = v4 ? null : ipv6Bytes(c.address);
  const mdns = v4 || v6 ? null : MDNS.exec(c.address);
  if (v4) {
    w.u8(type | (FAMILY_IPV4 << 2));
    w.bytes(v4);
  } else if (v6) {
    w.u8(type | (FAMILY_IPV6 << 2));
    w.bytes(v6);
  } else if (mdns) {
    w.u8(type | (FAMILY_MDNS << 2));
    w.bytes(Uint8Array.from(mdns.slice(1).join('').match(/../g)!, (h) => parseInt(h, 16)));
  } else {
    const name = enc.encode(c.address);
    if (name.length > 255) throw new Error('rendezvous: candidate name too long');
    w.u8(type | (FAMILY_NAME << 2));
    w.u8(name.length);
    w.bytes(name);
  }
  w.u16(c.port);
}

function readCandidate(r: Reader): CompactCandidate {
  const tag = r.u8();
  const type = TYPES[tag & 3]!;
  const family = (tag >> 2) & 3;
  let address: string;
  if (family === FAMILY_IPV4) address = Array.from(r.bytes(4)).join('.');
  else if (family === FAMILY_IPV6) address = ipv6Text(r.bytes(16));
  else if (family === FAMILY_MDNS) {
    const h = hex(r.bytes(16));
    address = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}.local`;
  } else address = dec.decode(r.bytes(r.u8()));
  return { type, address, port: r.u16() };
}

function writeSdp(w: Writer, s: CompactSdp): void {
  w.u8(s.ufrag.length);
  w.bytes(packIce(s.ufrag));
  w.u8(s.pwd.length);
  w.bytes(packIce(s.pwd));
  const hash = HASHES.indexOf(s.hash);
  if (s.fingerprint.length !== HASH_BYTES[hash]) throw new Error('rendezvous: fingerprint length does not match its hash');
  w.u8(hash);
  w.bytes(s.fingerprint);
  if (s.mid !== '0') {
    const mid = enc.encode(s.mid);
    w.u8(mid.length);
    w.bytes(mid);
  }
  w.u8(s.candidates.length);
  for (const c of s.candidates) writeCandidate(w, c);
}

function readSdp(r: Reader, customMid: boolean): CompactSdp {
  const ufragChars = r.u8();
  const ufrag = unpackIce(r.bytes(packedSize(ufragChars)), ufragChars);
  const pwdChars = r.u8();
  const pwd = unpackIce(r.bytes(packedSize(pwdChars)), pwdChars);
  const hashIndex = r.u8();
  const hash = HASHES[hashIndex];
  if (!hash || !ufrag || !pwd) throw new RangeError('bad ICE section');
  const fingerprint = r.bytes(HASH_BYTES[hashIndex]!).slice();
  const mid = customMid ? dec.decode(r.bytes(r.u8())) : '0';
  const candidates: CompactCandidate[] = [];
  for (let n = r.u8(); n > 0; n--) candidates.push(readCandidate(r));
  return { ufrag, pwd, hash, fingerprint, mid, candidates };
}

function missionTag(mission: MissionId): Uint8Array {
  return fromB64u(sha256(`${DOMAIN}/mission/${mission}`)).slice(0, MISSION_TAG);
}

function actorPrefix(actor: ActorId): Uint8Array {
  return fromB64u(actor).slice(0, ACTOR_PREFIX);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Separates these signatures from events and ferry packets, and binds context that never travels. */
function signingInput(mission: MissionId, offerDigest: string, body: Uint8Array): Uint8Array {
  const prefix = enc.encode(`${DOMAIN}\n${mission}\n${offerDigest}\n`);
  const out = new Uint8Array(prefix.length + body.length);
  out.set(prefix);
  out.set(body, prefix.length);
  return out;
}

function seal(w: Writer, signer: Signer, mission: MissionId, offerDigest: string): Uint8Array {
  const body = w.done();
  const sig = fromB64u(signBytes(signer.secretKey, signingInput(mission, offerDigest, body)));
  const out = new Uint8Array(body.length + sig.length);
  out.set(body);
  out.set(sig, body.length);
  return out;
}

function header(w: Writer, flags: number, mission: MissionId, from: ActorId): void {
  w.u8((VERSION << 4) | flags);
  w.bytes(missionTag(mission));
  w.bytes(actorPrefix(from));
}

export function sealOffer(signer: Signer, mission: MissionId, o: Omit<OfferBody, 'kind' | 'from'>): Uint8Array {
  const w = new Writer();
  header(w, (o.to ? FLAG_TO : 0) | (o.sdp.mid === '0' ? 0 : FLAG_MID), mission, signer.publicKey);
  if (o.to) w.bytes(actorPrefix(o.to));
  w.bytes(fromB64u(o.nonce));
  w.u32(Math.floor(o.expires / 1000));
  writeSdp(w, o.sdp);
  return seal(w, signer, mission, '');
}

export function sealAnswer(signer: Signer, mission: MissionId, o: Omit<AnswerBody, 'kind' | 'from'>): Uint8Array {
  const w = new Writer();
  header(w, FLAG_ANSWER | (o.sdp.mid === '0' ? 0 : FLAG_MID), mission, signer.publicKey);
  w.bytes(fromB64u(o.offer).slice(0, OFFER_REF));
  writeSdp(w, o.sdp);
  return seal(w, signer, mission, o.offer);
}

export function newNonce(): string {
  return b64u(crypto.getRandomValues(new Uint8Array(NONCE)));
}

/**
 * Parses and authenticates a payload against the roster. Answers also need the digest of the
 * offer they claim to answer, so an answer for anything else fails here. Never throws.
 */
export function openPayload(bytes: Uint8Array, a: { mission: MissionId; roster: Roster; offerDigest?: string }): Opened {
  if (bytes.length < 1 + MISSION_TAG + ACTOR_PREFIX + SIGNATURE) return { ok: false, reason: 'malformed' };
  try {
    const signed = bytes.subarray(0, bytes.length - SIGNATURE);
    const r = new Reader(signed);
    const head = r.u8();
    if (head >> 4 !== VERSION) return { ok: false, reason: 'malformed' };
    if (!sameBytes(r.bytes(MISSION_TAG), missionTag(a.mission))) return { ok: false, reason: 'wrong-mission' };
    const prefix = r.bytes(ACTOR_PREFIX);
    const signers = a.roster.filter((e) => sameBytes(actorPrefix(e.actor), prefix));
    if (!signers.length) return { ok: false, reason: 'not-on-roster' };

    const customMid = (head & FLAG_MID) !== 0;
    let body: PayloadBody;
    let hidden = '';
    if (head & FLAG_ANSWER) {
      const ref = r.bytes(OFFER_REF);
      if (!a.offerDigest || !sameBytes(ref, fromB64u(a.offerDigest).slice(0, OFFER_REF))) return { ok: false, reason: 'wrong-offer' };
      hidden = a.offerDigest;
      body = { kind: 'answer', from: '', offer: a.offerDigest, sdp: readSdp(r, customMid) };
    } else {
      const toPrefix = head & FLAG_TO ? r.bytes(ACTOR_PREFIX) : null;
      const to = toPrefix ? a.roster.find((e) => sameBytes(actorPrefix(e.actor), toPrefix))?.actor : undefined;
      if (toPrefix && !to) return { ok: false, reason: 'not-on-roster' };
      const nonce = b64u(r.bytes(NONCE));
      const expires = r.u32() * 1000;
      body = { kind: 'offer', from: '', to, nonce, expires, sdp: readSdp(r, customMid) };
    }
    if (r.at !== signed.length) return { ok: false, reason: 'malformed' };

    const input = signingInput(a.mission, hidden, signed);
    const sig = b64u(bytes.subarray(signed.length));
    const signer = signers.find((e) => {
      try {
        return verifyBytes(e.actor, input, sig);
      } catch {
        return false;
      }
    });
    if (!signer) return { ok: false, reason: 'bad-signature' };
    body.from = signer.actor;
    return { ok: true, body, digest: sha256(bytes) };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}
