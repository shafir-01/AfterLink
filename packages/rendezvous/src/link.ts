import { encodeFrames, FrameDecoder } from '@afterlink/mesh';
import type { ActorId, Link, LinkState, WireMessage } from '@afterlink/protocol';

const BUFFER_HIGH_BYTES = 1024 * 1024;
const BUFFER_LOW_BYTES = 256 * 1024;

/** An open data channel as a Link. Uses the mesh frame format, so large batches travel the same way. */
export class ChannelLink implements Link {
  readonly kind = 'webrtc' as const;
  state: LinkState = 'open';
  private readonly decoder = new FrameDecoder();
  private queue: Uint8Array<ArrayBuffer>[] = [];
  private messageFn: (msg: WireMessage) => void = () => {};
  private stateFn: (s: LinkState) => void = () => {};

  constructor(
    readonly peer: ActorId,
    private readonly pc: RTCPeerConnection,
    private readonly channel: RTCDataChannel,
  ) {
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = BUFFER_LOW_BYTES;
    channel.onbufferedamountlow = () => this.pump();
    channel.onmessage = (e: MessageEvent<ArrayBuffer>) => this.receive(e.data);
    channel.onclose = () => this.finish('closed');
    channel.onerror = () => this.finish('closed');
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.finish('closed');
    };
  }

  send(msg: WireMessage): void {
    if (this.state !== 'open') return;
    this.queue.push(...encodeFrames(msg));
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

  private receive(data: ArrayBuffer): void {
    try {
      const frame = this.decoder.push(new Uint8Array(data));
      if (frame.done) this.messageFn(frame.msg as WireMessage);
    } catch {
      this.finish('closed');
    }
  }

  private pump(): void {
    if (this.channel.readyState !== 'open') return;
    while (this.queue.length && this.channel.bufferedAmount < BUFFER_HIGH_BYTES) this.channel.send(this.queue.shift()!);
  }

  private finish(state: 'closed' | 'severed'): void {
    if (this.state !== 'open') return;
    this.state = state;
    this.queue = [];
    this.channel.onmessage = null;
    this.channel.onclose = null;
    this.channel.onerror = null;
    this.channel.onbufferedamountlow = null;
    this.pc.onconnectionstatechange = null;
    this.channel.close();
    this.pc.close();
    this.stateFn(state);
  }
}
