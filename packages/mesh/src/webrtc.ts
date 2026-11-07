import type { ActorId, Link, LinkState, WireMessage } from '@afterlink/protocol';
import { encodeFrames, FrameDecoder } from './frames.ts';
import type { BoundLink, LinkConnector, LinkRequest, NegotiatedLink } from './types.ts';

export interface WebrtcOptions {
  /** Not needed on one machine or a LAN, where host candidates connect directly. */
  iceServers?: RTCIceServer[];
  /** Overrides the global constructor. */
  RTCPeerConnection?: typeof RTCPeerConnection;
}

type Negotiation =
  | { description: RTCSessionDescriptionInit }
  | { candidate: RTCIceCandidateInit };

const CHANNEL_LABEL = 'afterlink';
/** Sending pauses above this many bytes queued in the channel and resumes below the low mark. */
const BUFFER_HIGH_BYTES = 1024 * 1024;
const BUFFER_LOW_BYTES = 256 * 1024;
/** Beyond this the peer is not keeping up. Whole messages are refused; anti-entropy resends what matters. */
const QUEUE_LIMIT_BYTES = 8 * 1024 * 1024;

/** Framing, backpressure and lifecycle of one data channel on one peer connection. */
class ChannelLink implements BoundLink {
  readonly kind = 'webrtc' as const;
  state: LinkState = 'connecting';
  private channel: RTCDataChannel | null = null;
  private readonly decoder = new FrameDecoder();
  private messageFn: (msg: WireMessage) => void = () => {};
  private stateFn: (s: LinkState) => void = () => {};
  private queue: Uint8Array<ArrayBuffer>[] = [];
  private queueHead = 0;
  private queuedBytes = 0;

  constructor(
    readonly peer: ActorId,
    protected readonly pc: RTCPeerConnection,
  ) {
    this.pc.onconnectionstatechange = () => {
      const { connectionState } = this.pc;
      if (connectionState === 'failed' || connectionState === 'closed') this.finish('closed');
    };
  }

  send(msg: WireMessage): void {
    if (this.state !== 'open' || this.queuedBytes > QUEUE_LIMIT_BYTES) return;
    for (const frame of encodeFrames(msg)) {
      this.queue.push(frame);
      this.queuedBytes += frame.length;
    }
    this.pump();
  }

  onMessage(fn: (msg: WireMessage) => void): void {
    this.messageFn = fn;
  }

  onState(fn: (s: LinkState) => void): void {
    this.stateFn = fn;
  }

  close(reason: 'severed' | 'closed'): void {
    this.finish(reason);
  }

  /** The DTLS fingerprints of both ends, identical on each side unless someone swapped them in signalling. */
  binding(): string {
    const sdp = `${this.pc.localDescription?.sdp ?? ''}\n${this.pc.remoteDescription?.sdp ?? ''}`;
    const prints = sdp.match(/^a=fingerprint:.*$/gim) ?? [];
    return [...new Set(prints.map((line) => line.trim().toLowerCase()))].sort().join('|');
  }

  protected get bound(): boolean {
    return this.channel !== null;
  }

  bindChannel(channel: RTCDataChannel): void {
    this.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = BUFFER_LOW_BYTES;
    channel.onbufferedamountlow = () => this.pump();
    channel.onopen = () => this.setState('open');
    channel.onclose = () => this.finish('closed');
    channel.onerror = () => this.finish('closed');
    channel.onmessage = (e: MessageEvent<ArrayBuffer>) => this.receive(e.data);
    if (channel.readyState === 'open') this.setState('open');
    else if (channel.readyState !== 'connecting') this.finish('closed');
  }

  protected finish(state: 'closed' | 'severed'): void {
    if (this.state === 'closed' || this.state === 'severed') return;
    this.queue = [];
    this.queueHead = 0;
    this.queuedBytes = 0;
    this.pc.onnegotiationneeded = null;
    this.pc.onicecandidate = null;
    this.pc.onconnectionstatechange = null;
    this.pc.ondatachannel = null;
    if (this.channel) {
      this.channel.onopen = null;
      this.channel.onclose = null;
      this.channel.onerror = null;
      this.channel.onmessage = null;
      this.channel.onbufferedamountlow = null;
      this.channel.close();
    }
    this.pc.close();
    this.setState(state);
  }

  private receive(data: ArrayBuffer): void {
    let frame: ReturnType<FrameDecoder['push']>;
    try {
      frame = this.decoder.push(new Uint8Array(data));
    } catch {
      this.finish('closed');
      return;
    }
    if (frame.done) this.messageFn(frame.msg as WireMessage);
  }

  private pump(): void {
    const { channel } = this;
    if (!channel || channel.readyState !== 'open') return;
    while (this.queueHead < this.queue.length && channel.bufferedAmount < BUFFER_HIGH_BYTES) {
      const frame = this.queue[this.queueHead++]!;
      this.queuedBytes -= frame.length;
      channel.send(frame);
    }
    if (this.queueHead === this.queue.length) {
      this.queue = [];
      this.queueHead = 0;
    }
  }

  private setState(state: LinkState): void {
    if (this.state === state) return;
    this.state = state;
    this.stateFn(state);
  }
}

class WebrtcLink extends ChannelLink implements NegotiatedLink {
  private readonly req: LinkRequest;
  private makingOffer = false;
  private ignoreOffer = false;

  constructor(req: LinkRequest, o: WebrtcOptions) {
    const Peer = o.RTCPeerConnection ?? globalThis.RTCPeerConnection;
    super(req.peer, new Peer({ iceServers: o.iceServers ?? [] }));
    this.req = req;
    this.pc.onnegotiationneeded = () => void this.offer();
    this.pc.onicecandidate = (e) => {
      if (e.candidate) this.req.signal({ candidate: e.candidate.toJSON() } satisfies Negotiation);
    };
    if (req.role === 'dialer') {
      this.bindChannel(this.pc.createDataChannel(CHANNEL_LABEL, { ordered: true }));
    } else {
      this.pc.ondatachannel = (e) => {
        if (e.channel.label === CHANNEL_LABEL && !this.bound) this.bindChannel(e.channel);
        else e.channel.close();
      };
    }
  }

  signal(data: unknown): void {
    void this.negotiate(data as Negotiation);
  }

  private async offer(): Promise<void> {
    try {
      this.makingOffer = true;
      await this.pc.setLocalDescription();
      if (this.pc.localDescription) {
        this.req.signal({ description: this.pc.localDescription.toJSON() } satisfies Negotiation);
      }
    } catch {
      this.finish('closed');
    } finally {
      this.makingOffer = false;
    }
  }

  /** Perfect negotiation: on an offer collision the polite end rolls back, the impolite end ignores. */
  private async negotiate(data: Negotiation): Promise<void> {
    if (this.state === 'closed' || this.state === 'severed') return;
    try {
      if ('description' in data) {
        const { description } = data;
        const collision =
          description.type === 'offer' && (this.makingOffer || this.pc.signalingState !== 'stable');
        this.ignoreOffer = !this.req.polite && collision;
        if (this.ignoreOffer) return;
        await this.pc.setRemoteDescription(description);
        if (description.type === 'offer') {
          await this.pc.setLocalDescription();
          if (this.pc.localDescription) {
            this.req.signal({ description: this.pc.localDescription.toJSON() } satisfies Negotiation);
          }
        }
      } else if ('candidate' in data) {
        try {
          await this.pc.addIceCandidate(data.candidate);
        } catch (error) {
          if (!this.ignoreOffer) throw error;
        }
      }
    } catch {
      this.finish('closed');
    }
  }
}

/**
 * Wraps a data channel negotiated elsewhere, so every path shares framing and backpressure.
 * The channel must be ordered and reliable. Closing the link closes the peer connection.
 */
export function dataChannelLink(peer: ActorId, pc: RTCPeerConnection, channel: RTCDataChannel): Link {
  const link = new ChannelLink(peer, pc);
  link.bindChannel(channel);
  return link;
}

export function webrtcConnector(o: WebrtcOptions = {}): LinkConnector {
  return {
    kind: 'webrtc',
    connect: (req) => new WebrtcLink(req, o),
  };
}
