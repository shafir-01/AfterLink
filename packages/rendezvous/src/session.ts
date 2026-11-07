import { b64u, fromB64u, sha256, type ActorId, type Link, type MissionId, type NextStep } from '@afterlink/protocol';
import type { WireFrame } from '@afterlink/ferry';
import { PayloadAssembler, payloadFrames } from './frames.ts';
import { ChannelLink } from './link.ts';
import { newNonce, openPayload, sealAnswer, sealOffer, type OpenFailure, type OfferBody, type Roster, type Signer } from './payload.ts';
import { compactSdp, expandSdp, type CandidateType, type CompactSdp } from './sdp.ts';

export const DEFAULT_GATHER_MS = 2500;
export const DEFAULT_OFFER_TTL_MS = 10 * 60_000;
export const DEFAULT_CONNECT_MS = 20_000;
export const DEFAULT_ANSWER_WAIT_MS = 3 * 60_000;
/** Devices that cannot reach a time source drift, so expiry allows this much disagreement. */
const CLOCK_SKEW_MS = 2 * 60_000;

/** Stated on every result, because a QR can carry an introduction but cannot carry a network. */
export const RENDEZVOUS_LIMITS = {
  requiresSharedNetwork: true,
  statement:
    'Both devices must share a local network path. The QR replaces the signalling server, not the network. With no shared path, carry an update by QR instead.',
} as const;

export type RendezvousLimits = typeof RENDEZVOUS_LIMITS;

export type RendezvousFailure =
  | OpenFailure
  | 'expired'
  | 'wrong-kind'
  | 'own-code'
  | 'not-for-this-device'
  | 'replayed'
  | 'closed'
  | 'no-local-network'
  | 'no-shared-network'
  | 'timeout';

const MESSAGES: Record<RendezvousFailure, string> = {
  malformed: 'That is not a reconnect code.',
  'wrong-mission': 'That code belongs to another mission.',
  'not-on-roster': 'That device is not on this mission.',
  'bad-signature': 'That code failed its signature check.',
  'wrong-offer': 'That reply answers a different code.',
  expired: 'That code has expired. Show a new one.',
  'wrong-kind': 'Scan the other device’s code for this step.',
  'own-code': 'That code came from this device.',
  'not-for-this-device': 'That code is meant for another device.',
  replayed: 'That code has already been used.',
  closed: 'This reconnect was cancelled.',
  'no-local-network': 'This device has no network to reconnect on. Carry an update by QR instead.',
  'no-shared-network': 'The devices could not reach each other. Join the same network, or carry an update by QR.',
  timeout: 'No connection in time. Join the same network, or carry an update by QR.',
};

const NO_PATH: RendezvousFailure[] = ['no-local-network', 'no-shared-network', 'timeout'];

export interface RendezvousRefusal {
  ok: false;
  reason: RendezvousFailure;
  message: string;
  /** Set when no electronic path exists, so the caller can switch to the ferry. */
  next?: NextStep;
  limits: RendezvousLimits;
}

export interface RendezvousLink {
  ok: true;
  peer: ActorId;
  link: Link;
  /** Selected candidate pair, read from the browser after connecting. */
  path: { local?: CandidateType; remote?: CandidateType; rttMs?: number };
  limits: RendezvousLimits;
}

export type RendezvousResult = RendezvousLink | RendezvousRefusal;

export interface RendezvousDevice {
  keys: Signer;
  mission: MissionId;
  roster: Roster;
  now?: () => number;
  iceServers?: RTCIceServer[];
  /** Upper bound on ICE gathering. The payload carries whatever was found by then. */
  gatherMs?: number;
  connectMs?: number;
  answerWaitMs?: number;
  /** Offers already answered. Share one set per device to refuse a second use of the same code. */
  seen?: Set<string>;
  createConnection?: (config: RTCConfiguration) => RTCPeerConnection;
}

/** What one device shows on screen. */
export interface Shown {
  ok: true;
  /** Base64url text of the signed payload, for copy and paste when no camera is available. */
  text: string;
  frames: WireFrame[];
  bytes: number;
  /** Size of the browser's own description, for comparison. */
  sdpBytes: number;
  close(): void;
  limits: RendezvousLimits;
}

export interface PendingOffer extends Shown {
  expires: number;
  digest: string;
  /** Internal state consumed by completeAnswer. */
  session: { pc: RTCPeerConnection; channel: RTCDataChannel; to?: ActorId; used: boolean };
}

export interface AcceptedOffer extends Shown {
  peer: ActorId;
  /** Settles when the data channel opens or the wait runs out. */
  connected: Promise<RendezvousResult>;
}

export type Scanned = string | Uint8Array | WireFrame[];

export function refusal(reason: RendezvousFailure): RendezvousRefusal {
  return {
    ok: false,
    reason,
    message: MESSAGES[reason],
    limits: RENDEZVOUS_LIMITS,
    ...(NO_PATH.includes(reason) ? { next: 'CARRY_UPDATE' as const } : {}),
  };
}

function connection(d: RendezvousDevice): RTCPeerConnection {
  const config: RTCConfiguration = { iceServers: d.iceServers ?? [] };
  return d.createConnection ? d.createConnection(config) : new RTCPeerConnection(config);
}

/** Non-trickle: waits for gathering to finish, but never longer than the bound. */
function gathered(pc: RTCPeerConnection, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === 'complete') done();
    };
    const timer = setTimeout(done, ms);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

async function describe(pc: RTCPeerConnection, d: RendezvousDevice): Promise<{ sdp: CompactSdp; sdpBytes: number } | null> {
  await gathered(pc, d.gatherMs ?? DEFAULT_GATHER_MS);
  const text = pc.localDescription?.sdp ?? '';
  const sdp = compactSdp(text);
  return sdp.candidates.length ? { sdp, sdpBytes: text.length } : null;
}

function toBytes(input: Scanned): Uint8Array | null {
  try {
    if (input instanceof Uint8Array) return input;
    if (typeof input === 'string') return fromB64u(input.trim());
    const assembler = new PayloadAssembler();
    for (const frame of input) assembler.add(frame);
    return assembler.done ? assembler.payload() : null;
  } catch {
    return null;
  }
}

function shown(payload: Uint8Array, digest: string, sdpBytes: number, close: () => void): Shown {
  return {
    ok: true,
    text: b64u(payload),
    frames: payloadFrames(payload, digest),
    bytes: payload.length,
    sdpBytes,
    close,
    limits: RENDEZVOUS_LIMITS,
  };
}

async function selectedPath(pc: RTCPeerConnection): Promise<RendezvousLink['path']> {
  try {
    const stats = new Map<string, Record<string, unknown>>();
    (await pc.getStats()).forEach((s: Record<string, unknown>) => stats.set(s.id as string, s));
    const all = [...stats.values()];
    const transport = all.find((s) => s.type === 'transport' && s.selectedCandidatePairId);
    const pair = transport
      ? stats.get(transport.selectedCandidatePairId as string)
      : all.find((s) => s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded');
    if (!pair) return {};
    const rtt = pair.currentRoundTripTime;
    return {
      local: stats.get(pair.localCandidateId as string)?.candidateType as CandidateType | undefined,
      remote: stats.get(pair.remoteCandidateId as string)?.candidateType as CandidateType | undefined,
      rttMs: typeof rtt === 'number' ? Math.round(rtt * 1000) : undefined,
    };
  } catch {
    return {};
  }
}

async function linked(peer: ActorId, pc: RTCPeerConnection, channel: RTCDataChannel): Promise<RendezvousLink> {
  const link = new ChannelLink(peer, pc, channel);
  return { ok: true, peer, link, path: await selectedPath(pc), limits: RENDEZVOUS_LIMITS };
}

function channelOpen(pc: RTCPeerConnection, channel: Promise<RTCDataChannel>, ms: number, failFast: boolean): Promise<RTCDataChannel | RendezvousRefusal> {
  return new Promise((resolve) => {
    const finish = (value: RTCDataChannel | RendezvousRefusal) => {
      clearTimeout(timer);
      pc.removeEventListener('connectionstatechange', watch);
      resolve(value);
    };
    const watch = () => {
      if (pc.connectionState === 'closed') finish(refusal('closed'));
      else if (pc.connectionState === 'failed' && failFast) finish(refusal('no-shared-network'));
    };
    const timer = setTimeout(() => finish(refusal('timeout')), ms);
    pc.addEventListener('connectionstatechange', watch);
    watch();
    void channel.then((c) => {
      if (c.readyState === 'open') finish(c);
      else c.addEventListener('open', () => finish(c), { once: true });
    });
  });
}

/** Device A: gathers, signs and returns the code to show. Nothing leaves the device. */
export async function createOfferPayload(d: RendezvousDevice, o: { to?: ActorId; ttlMs?: number } = {}): Promise<PendingOffer | RendezvousRefusal> {
  const pc = connection(d);
  const channel = pc.createDataChannel('afterlink', { ordered: true });
  await pc.setLocalDescription(await pc.createOffer());
  const local = await describe(pc, d);
  if (!local) {
    pc.close();
    return refusal('no-local-network');
  }
  const expires = (d.now?.() ?? Date.now()) + (o.ttlMs ?? DEFAULT_OFFER_TTL_MS);
  const payload = sealOffer(d.keys, d.mission, { to: o.to, nonce: newNonce(), expires, sdp: local.sdp });
  const digest = sha256(payload);
  return {
    ...shown(payload, digest, local.sdpBytes, () => pc.close()),
    expires,
    digest,
    session: { pc, channel, to: o.to, used: false },
  };
}

function checkOffer(d: RendezvousDevice, body: OfferBody): RendezvousFailure | null {
  const now = d.now?.() ?? Date.now();
  if (body.from === d.keys.publicKey) return 'own-code';
  if (body.to && body.to !== d.keys.publicKey) return 'not-for-this-device';
  if (now > body.expires + CLOCK_SKEW_MS) return 'expired';
  if (body.expires > now + DEFAULT_OFFER_TTL_MS + CLOCK_SKEW_MS) return 'expired';
  if (d.seen?.has(body.nonce)) return 'replayed';
  return null;
}

/** Device B: verifies a scanned offer against the roster, then returns the signed reply to show. */
export async function acceptOffer(d: RendezvousDevice, scanned: Scanned): Promise<AcceptedOffer | RendezvousRefusal> {
  const bytes = toBytes(scanned);
  if (!bytes) return refusal('malformed');
  const opened = openPayload(bytes, { mission: d.mission, roster: d.roster });
  if (!opened.ok) return refusal(opened.reason === 'wrong-offer' ? 'wrong-kind' : opened.reason);
  const { body, digest } = opened;
  if (body.kind !== 'offer') return refusal('wrong-kind');
  const problem = checkOffer(d, body);
  if (problem) return refusal(problem);
  d.seen?.add(body.nonce);

  const pc = connection(d);
  const channel = new Promise<RTCDataChannel>((resolve) => pc.addEventListener('datachannel', (e) => resolve(e.channel), { once: true }));
  await pc.setRemoteDescription({ type: 'offer', sdp: expandSdp(body.sdp, 'offer') });
  await pc.setLocalDescription(await pc.createAnswer());
  const local = await describe(pc, d);
  if (!local) {
    pc.close();
    return refusal('no-local-network');
  }

  const payload = sealAnswer(d.keys, d.mission, { offer: digest, sdp: local.sdp });
  // ICE may report failure here while the reply is still being carried, so only the deadline ends the wait.
  const connected = channelOpen(pc, channel, d.answerWaitMs ?? DEFAULT_ANSWER_WAIT_MS, false).then<RendezvousResult>((c) => {
    if ('ok' in c) {
      pc.close();
      return c;
    }
    return linked(body.from, pc, c);
  });
  return { ...shown(payload, sha256(payload), local.sdpBytes, () => pc.close()), peer: body.from, connected };
}

/** Device A: verifies the scanned reply against its own offer and opens the link. */
export async function completeAnswer(d: RendezvousDevice, pending: PendingOffer, scanned: Scanned): Promise<RendezvousResult> {
  const { session } = pending;
  if (session.pc.connectionState === 'closed') return refusal('closed');
  if (session.used) return refusal('replayed');
  const bytes = toBytes(scanned);
  if (!bytes) return refusal('malformed');
  const opened = openPayload(bytes, { mission: d.mission, roster: d.roster, offerDigest: pending.digest });
  if (!opened.ok) return refusal(opened.reason);
  const { body } = opened;
  if (body.kind !== 'answer') return refusal('wrong-kind');
  if (body.from === d.keys.publicKey) return refusal('own-code');
  if (session.to && body.from !== session.to) return refusal('not-for-this-device');

  session.used = true;
  await session.pc.setRemoteDescription({ type: 'answer', sdp: expandSdp(body.sdp, 'answer') });
  const c = await channelOpen(session.pc, Promise.resolve(session.channel), d.connectMs ?? DEFAULT_CONNECT_MS, true);
  if ('ok' in c) {
    session.pc.close();
    return c;
  }
  return linked(body.from, session.pc, c);
}
