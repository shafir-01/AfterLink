import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { b64u, fromB64u, generateKeys, sha256, signBytes, verifyBytes } from '../src/index.ts';

const hex = (s: string): Uint8Array => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));

describe('base64url', () => {
  it('matches a reference encoder and round trips', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 70 }), (bytes) => {
        const text = b64u(bytes);
        expect(text).toBe(Buffer.from(bytes).toString('base64url'));
        expect(fromB64u(text)).toEqual(bytes);
      }),
    );
  });

  it('refuses every alternate spelling of the same bytes', () => {
    expect(() => fromB64u('QR')).toThrow();
    expect(fromB64u('QQ')).toEqual(Uint8Array.of(65));
    expect(() => fromB64u('A')).toThrow();
    expect(() => fromB64u('AA==')).toThrow();
    expect(() => fromB64u('a+b/')).toThrow();
    expect(() => fromB64u('ab cd')).toThrow();
  });
});

describe('sha256', () => {
  it('matches published vectors, hashing strings as UTF-8', () => {
    expect(sha256('abc')).toBe(b64u(hex('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')));
    expect(sha256(new Uint8Array())).toBe(
      b64u(hex('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')),
    );
    expect(sha256('é')).toBe(sha256(Uint8Array.of(0xc3, 0xa9)));
  });
});

describe('ed25519', () => {
  const rfc8032 = {
    seed: hex('c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7'),
    publicKey: hex('fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025'),
    message: hex('af82'),
    signature: hex(
      '6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a',
    ),
  };

  it('reproduces the RFC 8032 test vector', () => {
    const keys = generateKeys(rfc8032.seed);
    expect(keys.publicKey).toBe(b64u(rfc8032.publicKey));
    expect(signBytes(keys.secretKey, rfc8032.message)).toBe(b64u(rfc8032.signature));
    expect(verifyBytes(keys.publicKey, rfc8032.message, b64u(rfc8032.signature))).toBe(true);
  });

  it('generates distinct random keys that sign and verify', () => {
    const a = generateKeys();
    const b = generateKeys();
    expect(a.publicKey).not.toBe(b.publicKey);
    const data = Uint8Array.of(1, 2, 3);
    const sig = signBytes(a.secretKey, data);
    expect(verifyBytes(a.publicKey, data, sig)).toBe(true);
    expect(verifyBytes(b.publicKey, data, sig)).toBe(false);
    expect(verifyBytes(a.publicKey, Uint8Array.of(1, 2, 4), sig)).toBe(false);
  });

  it('returns false instead of throwing on garbage', () => {
    const keys = generateKeys();
    const data = Uint8Array.of(1);
    const sig = signBytes(keys.secretKey, data);
    for (const [publicKey, signature] of [
      ['', sig],
      ['%%%', sig],
      [keys.publicKey, ''],
      [keys.publicKey, '%%%'],
      [keys.publicKey, 'AAAA'],
      ['AAAA', sig],
    ] as const) {
      expect(verifyBytes(publicKey, data, signature)).toBe(false);
    }
  });

  it('refuses a small-order public key, which would otherwise verify every message', () => {
    const identityPoint = hex('01'.padEnd(64, '0'));
    const basePoint = hex('58'.padEnd(64, '6'));
    const scalarOne = hex('01'.padEnd(64, '0'));
    const universal = b64u(Uint8Array.from([...basePoint, ...scalarOne]));
    for (const message of [Uint8Array.of(1), Uint8Array.of(2, 3)]) {
      expect(verifyBytes(b64u(identityPoint), message, universal)).toBe(false);
    }
  });

  it('refuses a malleated signature with s + L', () => {
    const keys = generateKeys(new Uint8Array(32).fill(3));
    const data = Uint8Array.of(7);
    const sig = fromB64u(signBytes(keys.secretKey, data));
    const order = 2n ** 252n + 27742317777372353535851937790883648493n;
    let s = 0n;
    for (let i = 63; i >= 32; i--) s = (s << 8n) | BigInt(sig[i]!);
    let raised = s + order;
    for (let i = 32; i < 64; i++) {
      sig[i] = Number(raised & 255n);
      raised >>= 8n;
    }
    expect(verifyBytes(keys.publicKey, data, b64u(sig))).toBe(false);
  });
});
