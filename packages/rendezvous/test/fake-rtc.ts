/** Test double for RTCPeerConnection: real SDP text in and out, no network. Used only by Node tests. */

export const CHROME_OFFER = (ufrag: string, pwd: string, fingerprint: string, candidates: string[]) =>
  [
    'v=0',
    'o=- 2931047310947123456 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=extmap-allow-mixed',
    'a=msid-semantic: WMS',
    'm=application 54321 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    ...candidates,
    `a=ice-ufrag:${ufrag}`,
    `a=ice-pwd:${pwd}`,
    'a=ice-options:trickle',
    `a=fingerprint:sha-256 ${fingerprint}`,
    'a=setup:actpass',
    'a=mid:0',
    'a=sctp-port:5000',
    'a=max-message-size:262144',
    '',
  ].join('\r\n');

export const FINGERPRINT = Array.from({ length: 32 }, (_, i) => (i * 7 + 1).toString(16).padStart(2, '0').toUpperCase()).join(':');

let counter = 0;

class FakeChannel extends EventTarget {
  binaryType = 'arraybuffer';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  readyState: RTCDataChannelState = 'connecting';
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onbufferedamountlow: (() => void) | null = null;
  other: FakeChannel | null = null;

  open(): void {
    this.readyState = 'open';
    this.dispatchEvent(new Event('open'));
  }

  send(data: Uint8Array): void {
    const copy = data.slice().buffer;
    queueMicrotask(() => this.other?.onmessage?.({ data: copy } as MessageEvent));
  }

  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    const other = this.other;
    queueMicrotask(() => {
      if (other && other.readyState !== 'closed') {
        other.readyState = 'closed';
        other.onclose?.();
      }
    });
  }
}

/** Connections register by ICE ufrag, so a rebuilt remote description finds its real counterpart. */
export class FakeNetwork {
  private byUfrag = new Map<string, FakePeerConnection>();
  candidates: string[] = ['a=candidate:1 1 udp 2113937151 11111111-2222-4333-8444-555555555555.local 50000 typ host generation 0'];
  /** False models two devices with no shared path. */
  reachable = true;
  created = 0;

  factory = (): RTCPeerConnection => {
    this.created++;
    return new FakePeerConnection(this) as unknown as RTCPeerConnection;
  };

  register(ufrag: string, pc: FakePeerConnection): void {
    this.byUfrag.set(ufrag, pc);
  }

  find(ufrag: string): FakePeerConnection | undefined {
    return this.byUfrag.get(ufrag);
  }
}

export class FakePeerConnection extends EventTarget {
  iceGatheringState: RTCIceGatheringState = 'new';
  connectionState: RTCPeerConnectionState = 'new';
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  onconnectionstatechange: (() => void) | null = null;
  readonly ufrag = `uf${(counter++).toString(36).padStart(2, '0')}`;
  readonly pwd = 'abcdefghijklmnopqrstuvwx';
  channel: FakeChannel | null = null;

  constructor(private net: FakeNetwork) {
    super();
    net.register(this.ufrag, this);
  }

  createDataChannel(): FakeChannel {
    this.channel = new FakeChannel();
    return this.channel;
  }

  async createOffer() {
    return { type: 'offer', sdp: CHROME_OFFER(this.ufrag, this.pwd, FINGERPRINT, this.net.candidates) };
  }

  async createAnswer() {
    return { type: 'answer', sdp: CHROME_OFFER(this.ufrag, this.pwd, FINGERPRINT, this.net.candidates).replace('actpass', 'passive') };
  }

  async setLocalDescription(d: { type: string; sdp: string }) {
    this.localDescription = d;
    this.iceGatheringState = 'gathering';
    queueMicrotask(() => {
      this.iceGatheringState = 'complete';
      this.dispatchEvent(new Event('icegatheringstatechange'));
    });
  }

  async setRemoteDescription(d: { type: string; sdp: string }) {
    this.remoteDescription = d;
    if (d.type !== 'answer') return;
    const remote = this.net.find(/a=ice-ufrag:(\S+)/.exec(d.sdp)![1]!);
    if (!remote || !this.net.reachable) {
      this.setConnection('failed');
      return;
    }
    const ours = this.channel!;
    const theirs = new FakeChannel();
    ours.other = theirs;
    theirs.other = ours;
    remote.channel = theirs;
    remote.dispatchEvent(Object.assign(new Event('datachannel'), { channel: theirs }));
    queueMicrotask(() => {
      this.setConnection('connected');
      remote.setConnection('connected');
      ours.open();
      theirs.open();
    });
  }

  setConnection(s: RTCPeerConnectionState): void {
    this.connectionState = s;
    this.dispatchEvent(new Event('connectionstatechange'));
    this.onconnectionstatechange?.();
  }

  async getStats() {
    return new Map();
  }

  close(): void {
    if (this.connectionState === 'closed') return;
    this.channel?.close();
    this.connectionState = 'closed';
    this.dispatchEvent(new Event('connectionstatechange'));
  }
}
