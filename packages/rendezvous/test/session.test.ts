import { describe, expect, it } from 'vitest';
import { generateKeys, type ActorId } from '@afterlink/protocol';
import {
  acceptOffer,
  completeAnswer,
  createOfferPayload,
  type AcceptedOffer,
  type PendingOffer,
  type RendezvousDevice,
  type RendezvousRefusal,
  type RendezvousResult,
} from '../src/index.ts';
import { FakeNetwork } from './fake-rtc.ts';

const mission = 'mission-1';
const alice = generateKeys();
const bob = generateKeys();
const carol = generateKeys();
const stranger = generateKeys();
const roster = [alice, bob, carol].map((k) => ({ actor: k.publicKey }));

function device(net: FakeNetwork, keys: typeof alice, extra: Partial<RendezvousDevice> = {}): RendezvousDevice {
  return { keys, mission, roster, createConnection: net.factory, gatherMs: 50, connectMs: 100, answerWaitMs: 200, ...extra };
}

async function showOffer(d: RendezvousDevice, o?: { to?: ActorId; ttlMs?: number }): Promise<PendingOffer> {
  const r = await createOfferPayload(d, o);
  if (!r.ok) throw new Error(r.reason);
  return r;
}

async function answer(d: RendezvousDevice, offer: PendingOffer): Promise<AcceptedOffer> {
  const r = await acceptOffer(d, offer.text);
  if (!r.ok) throw new Error(r.reason);
  return r;
}

const refused = (r: { ok: boolean }, reason: string) => expect(r).toMatchObject({ ok: false, reason });

describe('reconnect by QR', () => {
  it('forms a link and states its limits on every outcome', async () => {
    const net = new FakeNetwork();
    const a = device(net, alice);
    const b = device(net, bob);
    const offer = await showOffer(a);
    expect(offer.frames).toHaveLength(1);
    expect(offer.bytes).toBeLessThan(offer.sdpBytes / 2);
    expect(offer.limits.requiresSharedNetwork).toBe(true);

    const reply = await answer(b, offer);
    expect(reply.peer).toBe(alice.publicKey);

    const done = (await completeAnswer(a, offer, reply.frames)) as Extract<RendezvousResult, { ok: true }>;
    const far = (await reply.connected) as Extract<RendezvousResult, { ok: true }>;
    expect(done).toMatchObject({ ok: true, peer: bob.publicKey });
    expect(far).toMatchObject({ ok: true, peer: alice.publicKey });
    expect(done.limits.statement).toMatch(/share a local network path/);

    const got: unknown[] = [];
    far.link.onMessage((m) => got.push(m));
    done.link.send({ t: 'ping', n: 7 });
    await expect.poll(() => got).toEqual([{ t: 'ping', n: 7 }]);

    const states: string[] = [];
    far.link.onState((s) => states.push(s));
    done.link.close('closed');
    await expect.poll(() => states).toEqual(['closed']);
    expect(far.link.state).toBe('closed');
  });

  it("refuses a stranger's offer without opening a connection", async () => {
    const net = new FakeNetwork();
    const offer = await showOffer(device(net, stranger));
    const before = net.created;
    refused(await acceptOffer(device(net, bob), offer.text), 'not-on-roster');
    expect(net.created).toBe(before);
  });

  it("refuses a stranger's answer and leaves the offer usable", async () => {
    const net = new FakeNetwork();
    const a = device(net, alice);
    const offer = await showOffer(a);
    const widerRoster = [...roster, { actor: stranger.publicKey }];
    const forged = await answer(device(net, stranger, { roster: widerRoster }), offer);
    refused(await completeAnswer(a, offer, forged.text), 'not-on-roster');

    const real = await answer(device(net, bob), offer);
    expect(await completeAnswer(a, offer, real.text)).toMatchObject({ ok: true, peer: bob.publicKey });
  });

  it('refuses tampered codes, wrong missions, own codes and wrong steps', async () => {
    const net = new FakeNetwork();
    const a = device(net, alice);
    const b = device(net, bob);
    const offer = await showOffer(a);

    const flipped = offer.text.slice(0, 60) + (offer.text[60] === 'A' ? 'B' : 'A') + offer.text.slice(61);
    expect((await acceptOffer(b, flipped)).ok).toBe(false);
    refused(await acceptOffer(b, 'not a code'), 'malformed');
    refused(await acceptOffer(device(net, bob, { mission: 'other' }), offer.text), 'wrong-mission');
    refused(await acceptOffer(a, offer.text), 'own-code');

    const reply = await answer(b, offer);
    refused(await acceptOffer(device(net, carol), reply.text), 'wrong-kind');
    refused(await completeAnswer(a, offer, offer.text), 'wrong-kind');
  });

  it('refuses an answer to a different offer', async () => {
    const net = new FakeNetwork();
    const a = device(net, alice);
    const first = await showOffer(a);
    const second = await showOffer(a);
    const reply = await answer(device(net, bob), first);
    refused(await completeAnswer(a, second, reply.text), 'wrong-offer');
  });

  it('honours the addressee on both ends', async () => {
    const net = new FakeNetwork();
    const a = device(net, alice);
    const offer = await showOffer(a, { to: bob.publicKey });
    refused(await acceptOffer(device(net, carol), offer.text), 'not-for-this-device');
    expect(await acceptOffer(device(net, bob), offer.text)).toMatchObject({ ok: true });
  });

  it('expires old codes, refuses far-future expiry, and tolerates small clock drift', async () => {
    const net = new FakeNetwork();
    const t0 = Date.UTC(2026, 10, 7, 15, 0, 0);
    const a = device(net, alice, { now: () => t0 });
    const offer = await showOffer(a, { ttlMs: 60_000 });
    refused(await acceptOffer(device(net, bob, { now: () => t0 + 10 * 60_000 }), offer.text), 'expired');
    expect((await acceptOffer(device(net, bob, { now: () => t0 + 2 * 60_000 }), offer.text)).ok).toBe(true);

    const distant = await showOffer(a, { ttlMs: 365 * 24 * 3600_000 });
    refused(await acceptOffer(device(net, bob, { now: () => t0 }), distant.text), 'expired');
  });

  it('refuses a replayed offer and a second use of the same pending offer', async () => {
    const net = new FakeNetwork();
    const a = device(net, alice);
    const b = device(net, bob, { seen: new Set() });
    const offer = await showOffer(a);
    const reply = await answer(b, offer);
    refused(await acceptOffer(b, offer.text), 'replayed');

    expect((await completeAnswer(a, offer, reply.text)).ok).toBe(true);
    refused(await completeAnswer(a, offer, reply.text), 'replayed');
  });

  it('says plainly when there is no path, and points at the ferry', async () => {
    const net = new FakeNetwork();
    const a = device(net, alice);
    const offer = await showOffer(a);
    const reply = await answer(device(net, bob), offer);
    net.reachable = false;
    const result = (await completeAnswer(a, offer, reply.text)) as RendezvousRefusal;
    expect(result).toMatchObject({ ok: false, reason: 'no-shared-network', next: 'CARRY_UPDATE' });
    expect(result.limits.requiresSharedNetwork).toBe(true);
    expect(await reply.connected).toMatchObject({ ok: false, reason: 'timeout', next: 'CARRY_UPDATE' });
  });

  it('refuses before showing anything when the device has no network at all', async () => {
    const net = new FakeNetwork();
    net.candidates = [];
    expect(await createOfferPayload(device(net, alice))).toMatchObject({ ok: false, reason: 'no-local-network', next: 'CARRY_UPDATE' });
  });

  it('cannot complete after the offer is cancelled', async () => {
    const net = new FakeNetwork();
    const a = device(net, alice);
    const offer = await showOffer(a);
    const reply = await answer(device(net, bob), offer);
    offer.close();
    refused(await completeAnswer(a, offer, reply.text), 'closed');
  });
});
