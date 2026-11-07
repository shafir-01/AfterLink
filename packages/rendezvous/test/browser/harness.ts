import { Author, EventLog, generateKeys, type ActorId, type KeyPair } from '@afterlink/protocol';
import { Mesh, attachSync, webrtcConnector, type SyncHandle } from '@afterlink/mesh';
import { readFrame, renderFrame, type WireFrame } from '@afterlink/ferry';
import {
  RelayedSignal,
  acceptOffer,
  completeAnswer,
  createOfferPayload,
  isRendezvousFrame,
  type AcceptedOffer,
  type PendingOffer,
  type RendezvousDevice,
  type RendezvousResult,
} from '../../src/index.ts';

type Plain = Record<string, unknown>;

function summary(r: RendezvousResult): Plain {
  return r.ok
    ? { ok: true, peer: r.peer, path: r.path, limits: r.limits }
    : { ok: false, reason: r.reason, message: r.message, next: r.next, limits: r.limits };
}

/** Rewrites what a device advertises, so two devices share no path even though the host could route between them. */
function unreachable(config: RTCConfiguration): RTCPeerConnection {
  const pc = new RTCPeerConnection(config);
  return new Proxy(pc, {
    get(target, key) {
      if (key === 'localDescription') {
        const d = target.localDescription;
        return d && { type: d.type, sdp: d.sdp.replace(/(a=candidate:\S+ 1 udp \d+) \S+ \d+/g, '$1 192.0.2.77 9') };
      }
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(target, key, value) {
      return Reflect.set(target, key, value);
    },
  });
}

let device: RendezvousDevice;
let mesh: Mesh;
let sync: SyncHandle;
let log: EventLog;
let author: Author;
let relay: RelayedSignal | null = null;
let pending: PendingOffer | null = null;
let accepted: AcceptedOffer | null = null;
let scanned: WireFrame[] = [];
let shown: WireFrame[] = [];
let connectedAt = 0;
const results: Plain[] = [];
const relayed: Plain[] = [];

const canvas = () => document.getElementById('qr') as HTMLCanvasElement;

async function show(frames: WireFrame[]): Promise<void> {
  shown = frames;
  await renderFrame(canvas(), frames[0]!);
}

const rv = {
  keys: (): KeyPair => generateKeys(),

  boot(o: { keys: KeyPair; mission: string; roster: ActorId[]; relay?: boolean; unreachable?: boolean; connectMs?: number }) {
    log = new EventLog(o.mission);
    author = new Author(o.keys, log);
    device = {
      keys: o.keys,
      mission: o.mission,
      roster: o.roster.map((actor) => ({ actor })),
      seen: new Set(),
      connectMs: o.connectMs,
      createConnection: o.unreachable ? unreachable : undefined,
    };
    mesh = new Mesh({ self: o.keys.publicKey, peers: o.roster, connector: webrtcConnector() });
    sync = attachSync(mesh, log, () => {}, { intervalMs: 500, gossipMs: 20 });
    mesh.start();
    if (o.relay) {
      relay = new RelayedSignal({ device, mesh, onResult: (peer, r) => relayed.push({ peer, ...summary(r) }) });
      relay.start();
    }
  },

  async showOffer(to?: ActorId) {
    const r = await createOfferPayload(device, { to });
    if (!r.ok) return summary(r);
    pending = r;
    await show(r.frames);
    return { ok: true, bytes: r.bytes, sdpBytes: r.sdpBytes, frames: r.frames.length, text: r.text };
  },

  async showFrame(i: number) {
    await renderFrame(canvas(), shown[i]!);
  },

  /** Reads a screenshot of the other device through a slightly blurred, tilted view, as a camera would. */
  async scan(png: string) {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
    const view = new OffscreenCanvas(560, 560);
    const ctx = view.getContext('2d', { willReadFrequently: true })!;
    ctx.fillStyle = '#cfcfcf';
    ctx.fillRect(0, 0, 560, 560);
    ctx.filter = 'blur(0.6px)';
    ctx.translate(280, 280);
    ctx.rotate((4 * Math.PI) / 180);
    ctx.drawImage(bitmap, -240, -240, 480, 480);
    const frame = readFrame(ctx.getImageData(0, 0, 560, 560));
    if (frame && isRendezvousFrame(frame)) scanned.push(frame);
    return { read: !!frame, have: scanned.length, total: frame?.n ?? 0 };
  },

  async answer() {
    const r = await acceptOffer(device, scanned);
    scanned = [];
    if (!r.ok) return summary(r);
    accepted = r;
    void r.connected.then((c) => {
      connectedAt = performance.now();
      if (c.ok) mesh.adopt(c.link);
      results.push(summary(c));
      sync.nudge();
    });
    await show(r.frames);
    return { ok: true, peer: r.peer, bytes: r.bytes, sdpBytes: r.sdpBytes, frames: r.frames.length, text: r.text };
  },

  async answerText(text: string) {
    return summary((await acceptOffer(device, text)) as RendezvousResult);
  },

  async complete() {
    const started = performance.now();
    const r = await completeAnswer(device, pending!, scanned);
    scanned = [];
    const ms = Math.round(performance.now() - started);
    if (r.ok) mesh.adopt(r.link);
    const out = { ...summary(r), ms };
    results.push(out);
    sync.nudge();
    return out;
  },

  emit(count: number, tag: string) {
    for (let i = 0; i < count; i++) {
      author.emit('observation.recorded', {
        observation: { key: `${tag}.${i}`, value: i, subject: tag, observedAt: Date.now(), validForMs: 0, source: device.keys.publicKey },
      });
    }
    sync.nudge();
    return log.size;
  },

  size: () => log.size,
  links: () => mesh.stats().map((s) => ({ peer: s.peer, state: s.state, opens: s.opens, sent: s.sent, received: s.received })),
  results: () => results,
  relayed: () => relayed,
  connectedAt: () => connectedAt,
  acceptedPeer: () => accepted?.peer ?? null,
  offerText: () => pending?.text ?? null,
  stopPeer(peer: ActorId) {
    mesh.setFaults({ blocked: [peer] });
    mesh.setFaults({ blocked: [] });
  },
};

export type Rv = typeof rv;
(window as unknown as { rv: Rv }).rv = rv;
