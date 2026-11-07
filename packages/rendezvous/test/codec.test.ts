import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { b64u, fromB64u, generateKeys, signBytes } from '@afterlink/protocol';
import { frameImage, frameText, parseFrameText, readFrame } from '@afterlink/ferry';
import {
  MAX_CANDIDATES,
  PayloadAssembler,
  compactSdp,
  expandSdp,
  isRendezvousFrame,
  openPayload,
  payloadFrames,
  sealAnswer,
  sealOffer,
  type CompactSdp,
} from '../src/index.ts';
import { CHROME_OFFER, FINGERPRINT } from './fake-rtc.ts';

const MDNS_A = '7e4e1c0a-9f7e-4c35-8a4b-2f0a4b0c1d2e.local';
const MDNS_B = '0b1c2d3e-4f50-4162-8374-859600112233.local';

const chrome = (candidates: string[]) => CHROME_OFFER('Xy+/', 'abcdefghijklmnopqrstuv/+', FINGERPRINT, candidates);

const firefox = [
  'v=0',
  'o=mozilla...THIS_IS_SDPARTA-99.0 6093628123548213251 0 IN IP4 0.0.0.0',
  's=-',
  't=0 0',
  'a=sendrecv',
  'a=fingerprint:sha-256 ' + FINGERPRINT,
  'a=group:BUNDLE 0',
  'a=ice-options:trickle',
  'a=msid-semantic:WMS *',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=candidate:0 1 UDP 2122187007 192.168.1.20 53741 typ host',
  'a=candidate:1 1 TCP 2105458943 192.168.1.20 9 typ host tcptype active',
  'a=sendrecv',
  'a=ice-pwd:0123456789abcdef0123456789abcdef',
  'a=ice-ufrag:deadbeef',
  'a=mid:0',
  'a=setup:actpass',
  'a=sctp-port:5000',
  'a=max-message-size:1073741823',
  '',
].join('\r\n');

const mission = 'mission-1';
const alice = generateKeys();
const bob = generateKeys();
const stranger = generateKeys();
const roster = [{ actor: alice.publicKey }, { actor: bob.publicKey }];
const future = Date.UTC(2030, 0, 1);

const core = (extra: Partial<CompactSdp> = {}): CompactSdp => ({
  ufrag: 'Xy+/',
  pwd: 'abcdefghijklmnopqrstuv/+',
  hash: 'sha-256',
  fingerprint: Uint8Array.from({ length: 32 }, (_, i) => i),
  mid: '0',
  candidates: [{ type: 'host', address: MDNS_A, port: 50000 }],
  ...extra,
});

const offer = (signer = alice, sdp = core(), to?: string) =>
  sealOffer(signer, mission, { to, nonce: b64u(new Uint8Array(8).fill(9)), expires: future, sdp });

describe('SDP compression', () => {
  it('keeps exactly what the session needs and rebuilds an equivalent description', () => {
    const input = chrome([
      `a=candidate:1 1 udp 2113937151 ${MDNS_A} 54321 typ host generation 0 network-cost 999`,
      'a=candidate:2 1 udp 1677729535 203.0.113.9 46154 typ srflx raddr 0.0.0.0 rport 0 generation 0',
      'a=candidate:3 1 tcp 1518280447 192.168.1.2 9 typ host tcptype active generation 0',
    ]);
    const c = compactSdp(input);
    expect(c).toMatchObject({ ufrag: 'Xy+/', pwd: 'abcdefghijklmnopqrstuv/+', hash: 'sha-256', mid: '0' });
    expect(c.candidates).toEqual([
      { type: 'host', address: MDNS_A, port: 54321 },
      { type: 'srflx', address: '203.0.113.9', port: 46154 },
    ]);

    const rebuilt = expandSdp(c, 'offer');
    expect(rebuilt).toContain('m=application 9 UDP/DTLS/SCTP webrtc-datachannel');
    expect(rebuilt).toContain(`a=fingerprint:sha-256 ${FINGERPRINT}`);
    expect(rebuilt).toContain('a=setup:actpass');
    expect(rebuilt).toContain('raddr 0.0.0.0 rport 0');
    expect(rebuilt.endsWith('\r\n')).toBe(true);
    expect(compactSdp(rebuilt)).toEqual(c);
    expect(compactSdp(expandSdp(c, 'answer'))).toEqual(c);
    expect(expandSdp(c, 'answer')).toContain('a=setup:active');
  });

  it('reads a description with session-level fingerprint and upper case transport', () => {
    const c = compactSdp(firefox);
    expect(c).toMatchObject({ ufrag: 'deadbeef', pwd: '0123456789abcdef0123456789abcdef' });
    expect(c.candidates).toEqual([{ type: 'host', address: '192.168.1.20', port: 53741 }]);
  });

  it('keeps the highest priority candidates and drops duplicates', () => {
    const lines = Array.from({ length: 12 }, (_, i) => `a=candidate:${i} 1 udp ${1000 + i} 10.0.0.${i + 1} 5000 typ host`);
    const c = compactSdp(chrome([...lines, lines[0]!]));
    expect(c.candidates).toHaveLength(MAX_CANDIDATES);
    expect(c.candidates[0]!.address).toBe('10.0.0.12');
  });

  it('refuses a description with nothing to authenticate', () => {
    expect(() => compactSdp('v=0\r\n')).toThrow(/ICE credentials/);
  });
});

describe('signed payload', () => {
  it('survives the binary round trip for every candidate family', () => {
    const sdp = core({
      ufrag: 'a1',
      pwd: 'x'.repeat(22),
      mid: 'data',
      candidates: [
        { type: 'host', address: MDNS_B, port: 1 },
        { type: 'srflx', address: '203.0.113.9', port: 65535 },
        { type: 'relay', address: '2001:db8:0:0:0:0:0:1', port: 3478 },
        { type: 'prflx', address: 'router.lan', port: 9 },
      ],
    });
    const opened = openPayload(offer(alice, sdp, bob.publicKey), { mission, roster });
    expect(opened).toMatchObject({ ok: true, body: { kind: 'offer', from: alice.publicKey, to: bob.publicKey, expires: future } });
    if (opened.ok) expect(opened.body.sdp).toEqual({ ...sdp, candidates: [...sdp.candidates.slice(0, 2), { ...sdp.candidates[2]!, address: '2001:db8:0:0:0:0:0:1' }, sdp.candidates[3]] });
  });

  it('normalises compressed IPv6 without changing the address', () => {
    const sdp = core({ candidates: [{ type: 'host', address: '2001:db8::1', port: 4000 }] });
    const opened = openPayload(offer(alice, sdp), { mission, roster });
    expect(opened.ok && opened.body.sdp.candidates[0]!.address).toBe('2001:db8:0:0:0:0:0:1');
  });

  it('property: any valid session round-trips exactly', () => {
    const ice = (min: number, max: number) => fc.string({ unit: fc.constantFrom(...'abzAZ09+/'), minLength: min, maxLength: max });
    fc.assert(
      fc.property(ice(4, 32), ice(22, 64), fc.uint8Array({ minLength: 32, maxLength: 32 }), fc.array(fc.ipV4(), { maxLength: 8 }), fc.integer({ min: 1, max: 65535 }), (ufrag, pwd, fingerprint, ips, port) => {
        const sdp = core({ ufrag, pwd, fingerprint, candidates: ips.map((address) => ({ type: 'host' as const, address, port })) });
        const opened = openPayload(offer(alice, sdp), { mission, roster });
        expect(opened.ok && opened.body.sdp).toEqual(sdp);
      }),
      { numRuns: 100 },
    );
  });

  it('property: arbitrary bytes are refused, never thrown', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 400 }), (bytes) => {
        expect(openPayload(bytes, { mission, roster }).ok).toBe(false);
      }),
      { numRuns: 300 },
    );
  });

  it('property: flipping any one bit is refused', () => {
    const good = offer();
    fc.assert(
      fc.property(fc.integer({ min: 0, max: good.length * 8 - 1 }), (bit) => {
        const bad = good.slice();
        bad[bit >> 3] = good[bit >> 3]! ^ (1 << (bit & 7));
        expect(openPayload(bad, { mission, roster }).ok).toBe(false);
      }),
      { numRuns: 400 },
    );
  });

  it('refuses a stranger, a forged sender, another mission and a foreign signature', () => {
    expect(openPayload(offer(stranger), { mission, roster })).toEqual({ ok: false, reason: 'not-on-roster' });

    const forged = offer(alice);
    forged.set(fromB64u(signBytes(stranger.secretKey, new Uint8Array(4))), forged.length - 64);
    expect(openPayload(forged, { mission, roster })).toEqual({ ok: false, reason: 'bad-signature' });

    const impersonated = offer(stranger);
    impersonated.set(fromB64u(alice.publicKey).slice(0, 8), 5);
    expect(openPayload(impersonated, { mission, roster })).toEqual({ ok: false, reason: 'bad-signature' });

    expect(openPayload(offer(), { mission: 'other', roster })).toEqual({ ok: false, reason: 'wrong-mission' });
  });

  it('binds an answer to the whole digest of its offer, though only 4 bytes travel', () => {
    const digest = b64u(new Uint8Array(32).fill(7));
    const near = b64u(Uint8Array.from({ length: 32 }, (_, i) => (i < 4 ? 7 : 8)));
    const answer = sealAnswer(bob, mission, { offer: digest, sdp: core() });
    expect(openPayload(answer, { mission, roster, offerDigest: digest })).toMatchObject({ ok: true, body: { kind: 'answer', from: bob.publicKey } });
    expect(openPayload(answer, { mission, roster, offerDigest: near })).toEqual({ ok: false, reason: 'bad-signature' });
    expect(openPayload(answer, { mission, roster, offerDigest: b64u(new Uint8Array(32)) })).toEqual({ ok: false, reason: 'wrong-offer' });
    expect(openPayload(answer, { mission, roster })).toEqual({ ok: false, reason: 'wrong-offer' });
  });
});

describe('QR frames', () => {
  const two = [
    { type: 'host' as const, address: MDNS_A, port: 50000 },
    { type: 'host' as const, address: MDNS_B, port: 50001 },
  ];

  it('fits a realistic offer in one frame and a worst case in two', () => {
    const small = offer(alice, core({ candidates: two }));
    expect(small.length).toBeLessThan(200);
    expect(payloadFrames(small, 'digestdigest')).toHaveLength(1);

    const worst = offer(alice, core({ candidates: Array.from({ length: MAX_CANDIDATES }, (_, i) => ({ type: 'host' as const, address: '2001:db8:1:2:3:4:5:' + (i + 1), port: 50000 + i })) }), bob.publicKey);
    expect(payloadFrames(worst, 'digestdigest').length).toBeLessThanOrEqual(2);
  });

  it('passes through real QR pixels and reassembles in any order', () => {
    const payload = offer(alice, core({ candidates: Array.from({ length: MAX_CANDIDATES }, (_, i) => ({ type: 'host' as const, address: MDNS_A, port: 50000 + i })) }));
    const frames = payloadFrames(payload, 'digestdigest', 200);
    expect(frames.length).toBeGreaterThan(1);
    const assembler = new PayloadAssembler();
    for (const f of [...frames].reverse()) {
      const decoded = readFrame(frameImage(f, 4));
      expect(decoded).not.toBeNull();
      expect(isRendezvousFrame(decoded!)).toBe(true);
      assembler.add(decoded!);
      assembler.add(decoded!);
    }
    expect(assembler.done).toBe(true);
    expect(assembler.payload()).toEqual(payload);
  });

  it('never collides with ferry frames and ignores foreign or corrupt ones', () => {
    const [f] = payloadFrames(offer(), 'digestdigest');
    expect(parseFrameText(frameText(f!))).toEqual(f);
    expect(isRendezvousFrame({ id: 'rvabcdef' })).toBe(false);

    const assembler = new PayloadAssembler();
    assembler.add({ ...f!, data: `${f!.data}x` });
    assembler.add({ id: 'abcdefgh', i: 0, n: 1, data: 'AAAA', c: '00000000' });
    expect(assembler.done).toBe(false);
    assembler.add(f!);
    expect(assembler.done).toBe(true);

  });
});
