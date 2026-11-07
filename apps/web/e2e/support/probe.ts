/**
 * Installed in every frame before any app code runs. It wraps the native browser objects, so the
 * tests read real RTCPeerConnection, RTCDataChannel and Worker state rather than what the UI claims.
 * Must stay self contained: Playwright serialises this function into the page.
 */
export function installProbe() {
  const w = window as unknown as { __probe?: unknown };
  if (w.__probe) return;

  interface ChannelRecord {
    dc: RTCDataChannel;
    sent: number;
    received: number;
    bytesSent: number;
    bytesReceived: number;
    lastReceivedAt: number;
  }
  interface PcRecord {
    id: number;
    pc: RTCPeerConnection;
    createdAt: number;
    closedAt: number | null;
    channels: ChannelRecord[];
  }
  interface WorkerRecord {
    url: string;
    createdAt: number;
    terminatedAt: number | null;
  }

  interface Arrival {
    id: string;
    type: string;
    actor: string;
    at: number;
    pc: number;
  }

  const pcs: PcRecord[] = [];
  const workers: WorkerRecord[] = [];
  const arrivals: Arrival[] = [];
  const byPc = new WeakMap<RTCPeerConnection, PcRecord>();
  const byDc = new WeakMap<RTCDataChannel, ChannelRecord>();
  const sizeOf = (d: unknown) =>
    typeof d === 'string' ? d.length : d instanceof ArrayBuffer ? d.byteLength : ((d as Blob | ArrayBufferView).size ?? (d as ArrayBufferView).byteLength ?? 0);

  const watch = (rec: PcRecord, dc: RTCDataChannel) => {
    const c: ChannelRecord = { dc, sent: 0, received: 0, bytesSent: 0, bytesReceived: 0, lastReceivedAt: 0 };
    rec.channels.push(c);
    byDc.set(dc, c);
    let parts: Uint8Array[] = [];
    dc.addEventListener('message', (e) => {
      c.received += 1;
      c.bytesReceived += sizeOf(e.data);
      c.lastReceivedAt = Date.now();
      if (!(e.data instanceof ArrayBuffer)) return;
      const frame = new Uint8Array(e.data);
      parts.push(frame.slice(1));
      if (frame[0] !== 1) return;
      const whole = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const p of parts) {
        whole.set(p, at);
        at += p.length;
      }
      parts = [];
      try {
        const msg = JSON.parse(new TextDecoder().decode(whole)) as { t?: string; events?: Arrival[] };
        if (msg.t !== 'events') return;
        for (const ev of msg.events ?? []) arrivals.push({ id: ev.id, type: ev.type, actor: ev.actor, at: Date.now(), pc: rec.id });
      } catch {
        return;
      }
    });
  };

  const NativePc = window.RTCPeerConnection;
  class ProbePc extends NativePc {
    constructor(config?: RTCConfiguration) {
      super(config);
      const rec: PcRecord = { id: pcs.length, pc: this, createdAt: Date.now(), closedAt: null, channels: [] };
      pcs.push(rec);
      byPc.set(this, rec);
      this.addEventListener('datachannel', (e) => watch(rec, (e as RTCDataChannelEvent).channel));
    }
    override createDataChannel(label: string, init?: RTCDataChannelInit) {
      const dc = super.createDataChannel(label, init);
      watch(byPc.get(this)!, dc);
      return dc;
    }
    override close() {
      const rec = byPc.get(this);
      if (rec && rec.closedAt === null) rec.closedAt = Date.now();
      super.close();
    }
  }
  window.RTCPeerConnection = ProbePc as typeof RTCPeerConnection;

  const nativeSend = RTCDataChannel.prototype.send as (this: RTCDataChannel, d: unknown) => void;
  RTCDataChannel.prototype.send = function send(this: RTCDataChannel, d: unknown) {
    nativeSend.call(this, d);
    const c = byDc.get(this);
    if (c) {
      c.sent += 1;
      c.bytesSent += sizeOf(d);
    }
  } as typeof RTCDataChannel.prototype.send;

  const NativeWorker = window.Worker;
  class ProbeWorker extends NativeWorker {
    private rec: WorkerRecord;
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      this.rec = { url: String(url), createdAt: Date.now(), terminatedAt: null };
      workers.push(this.rec);
    }
    override terminate() {
      this.rec.terminatedAt = Date.now();
      super.terminate();
    }
  }
  window.Worker = ProbeWorker as typeof Worker;

  const selectedPair = async (pc: RTCPeerConnection) => {
    const stats = await pc.getStats();
    let pair: RTCIceCandidatePairStats | undefined;
    stats.forEach((r) => {
      if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId);
    });
    if (!pair) return null;
    return {
      local: stats.get(pair.localCandidateId)?.candidateType as string,
      remote: stats.get(pair.remoteCandidateId)?.candidateType as string,
      bytesSent: pair.bytesSent ?? 0,
      bytesReceived: pair.bytesReceived ?? 0,
    };
  };

  const reports: { kind: string; team: string | null; at: number; body: Record<string, unknown> }[] = [];
  const sources = new Map<string, MessageEventSource>();
  const views = new Map<string, unknown>();
  const teamOf = new WeakMap<object, string>();
  const carried = new Map<string, { width: number; height: number; data: Uint8ClampedArray; index: number; ferryId: string }>();

  if (window === window.top) {
    window.addEventListener('message', (e) => {
      const data = e.data as { channel?: string; body?: { kind?: string; view?: { self: { team: string } }; pixels?: unknown } } | null;
      if (data?.channel !== 'afterlink/bridge/1' || !data.body?.kind || !e.source) return;
      const body = data.body;
      if (body.kind === 'view' && body.view) {
        const team = body.view.self.team;
        sources.set(team, e.source);
        teamOf.set(e.source, team);
        views.set(team, body.view);
      }
      if (body.kind === 'view' || body.kind === 'links') return;
      const { pixels, ...rest } = body;
      if (body.kind === 'ferryFrame') {
        const p = pixels as { width: number; height: number; data: Uint8ClampedArray };
        const f = body as unknown as { index: number; ferryId: string };
        carried.set(`${f.ferryId}:${f.index}`, { width: p.width, height: p.height, data: new Uint8ClampedArray(p.data), index: f.index, ferryId: f.ferryId });
        return;
      }
      reports.push({ kind: body.kind, team: teamOf.get(e.source) ?? null, at: Date.now(), body: rest });
    });
  }

  w.__probe = {
    arrivals: () => arrivals.slice(),
    reports: () => reports.slice(),
    views: () => Object.fromEntries(views),
    teams: () => [...sources.keys()],
    send: (team: string, body: unknown) => {
      (sources.get(team) as Window).postMessage({ channel: 'afterlink/bridge/1', body }, '*');
    },
    carriedFrames: () => [...carried.values()].map((f) => ({ ferryId: f.ferryId, index: f.index, width: f.width, height: f.height })),
    framePixels: (ferryId: string, index: number) => {
      const f = carried.get(`${ferryId}:${index}`);
      return f ? { width: f.width, height: f.height, data: Array.from(f.data) } : null;
    },
    replayFrames: (team: string, ferryId: string, replayId: string) => {
      const frames = [...carried.values()].filter((f) => f.ferryId === ferryId).sort((a, b) => a.index - b.index);
      for (const f of frames) {
        const data = new Uint8ClampedArray(f.data);
        (sources.get(team) as Window).postMessage(
          { channel: 'afterlink/bridge/1', body: { kind: 'ferryFrame', ferryId: replayId, pixels: { width: f.width, height: f.height, data } } },
          '*',
          [data.buffer],
        );
      }
      return frames.length;
    },
    connections: () =>
      pcs.map((r) => ({
        id: r.id,
        connectionState: r.pc.connectionState,
        iceConnectionState: r.pc.iceConnectionState,
        createdAt: r.createdAt,
        closedAt: r.closedAt,
        channels: r.channels.map((c) => ({
          label: c.dc.label,
          readyState: c.dc.readyState,
          sent: c.sent,
          received: c.received,
          bytesSent: c.bytesSent,
          bytesReceived: c.bytesReceived,
          lastReceivedAt: c.lastReceivedAt,
        })),
      })),
    pairs: () => Promise.all(pcs.filter((r) => r.pc.connectionState === 'connected').map((r) => selectedPair(r.pc))),
    workers: () => workers.map((r) => ({ ...r })),
  };
}

export interface ProbeChannel {
  label: string;
  readyState: RTCDataChannelState;
  sent: number;
  received: number;
  bytesSent: number;
  bytesReceived: number;
  lastReceivedAt: number;
}

export interface ProbeConnection {
  id: number;
  connectionState: RTCPeerConnectionState;
  iceConnectionState: RTCIceConnectionState;
  createdAt: number;
  closedAt: number | null;
  channels: ProbeChannel[];
}

export interface Arrival {
  id: string;
  type: string;
  actor: string;
  at: number;
  pc: number;
}

export interface BridgeReport {
  kind: string;
  team: string | null;
  at: number;
  body: Record<string, unknown>;
}

export interface Probe {
  arrivals(): Arrival[];
  reports(): BridgeReport[];
  views(): Record<string, unknown>;
  teams(): string[];
  send(team: string, body: unknown): void;
  carriedFrames(): { ferryId: string; index: number; width: number; height: number }[];
  framePixels(ferryId: string, index: number): { width: number; height: number; data: number[] } | null;
  replayFrames(team: string, ferryId: string, replayId: string): number;
  connections(): ProbeConnection[];
  pairs(): Promise<({ local: string; remote: string; bytesSent: number; bytesReceived: number } | null)[]>;
  workers(): { url: string; createdAt: number; terminatedAt: number | null }[];
}
