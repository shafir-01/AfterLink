import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 as sha256Digest } from '@noble/hashes/sha2.js';
import type { ActorId } from './types.ts';

export interface KeyPair {
  publicKey: ActorId;
  secretKey: string;
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const VALUES = new Map(Array.from(ALPHABET, (char, value) => [char, value]));
const utf8 = new TextEncoder();

export function b64u(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += ALPHABET[a >> 2]!;
    out += ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
    if (b !== undefined) out += ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
    if (c !== undefined) out += ALPHABET[c & 63]!;
  }
  return out;
}

/** Strict: one byte string has exactly one spelling, so ids and keys cannot be aliased. */
export function fromB64u(s: string): Uint8Array {
  if (s.length % 4 === 1) throw new Error('Invalid base64url length');
  const bytes = new Uint8Array(Math.floor((s.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let at = 0;
  for (const char of s) {
    const value = VALUES.get(char);
    if (value === undefined) throw new Error('Invalid base64url character');
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[at++] = (buffer >> bits) & 255;
      buffer &= (1 << bits) - 1;
    }
  }
  if (buffer !== 0) throw new Error('Non-canonical base64url padding bits');
  return bytes;
}

export function sha256(data: string | Uint8Array): string {
  return b64u(sha256Digest(typeof data === 'string' ? utf8.encode(data) : data));
}

/** Pass a 32-byte seed for reproducible identities. */
export function generateKeys(seed?: Uint8Array): KeyPair {
  const { secretKey, publicKey } = ed25519.keygen(seed?.slice());
  return { publicKey: b64u(publicKey), secretKey: b64u(secretKey) };
}

export function signBytes(secretKey: string, data: Uint8Array): string {
  return b64u(ed25519.sign(data, fromB64u(secretKey)));
}

export function verifyBytes(publicKey: ActorId, data: Uint8Array, sig: string): boolean {
  try {
    return ed25519.verify(fromB64u(sig), data, fromB64u(publicKey), { zip215: false });
  } catch {
    return false;
  }
}
