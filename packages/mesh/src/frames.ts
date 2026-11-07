/** Payload bytes per frame. With the one byte header every frame stays under the 16 KB interoperable limit. */
export const FRAME_PAYLOAD_BYTES = 15 * 1024;
/** Largest message accepted from a peer. Honest batches are far smaller, so this only stops abuse. */
export const MAX_MESSAGE_BYTES = 1024 * 1024;

const MORE = 0;
const LAST = 1;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Frames are only valid on an ordered reliable channel: the header marks the end of a message. */
export function encodeFrames(msg: unknown): Uint8Array<ArrayBuffer>[] {
  const bytes = encoder.encode(JSON.stringify(msg));
  const frames: Uint8Array<ArrayBuffer>[] = [];
  for (let at = 0; at === 0 || at < bytes.length; at += FRAME_PAYLOAD_BYTES) {
    const part = bytes.subarray(at, at + FRAME_PAYLOAD_BYTES);
    const frame = new Uint8Array(part.length + 1);
    frame[0] = at + part.length >= bytes.length ? LAST : MORE;
    frame.set(part, 1);
    frames.push(frame);
  }
  return frames;
}

export class FrameDecoder {
  private parts: Uint8Array[] = [];
  private size = 0;

  /** Returns the decoded message when this frame completes one. Throws on oversize or malformed input. */
  push(frame: Uint8Array): { done: true; msg: unknown } | { done: false } {
    if (frame.length === 0) throw new Error('empty frame');
    this.size += frame.length - 1;
    if (this.size > MAX_MESSAGE_BYTES) throw new Error('message too large');
    this.parts.push(frame.subarray(1));
    if (frame[0] !== LAST) return { done: false };
    const whole = new Uint8Array(this.size);
    let at = 0;
    for (const part of this.parts) {
      whole.set(part, at);
      at += part.length;
    }
    this.parts = [];
    this.size = 0;
    return { done: true, msg: JSON.parse(decoder.decode(whole)) };
  }
}
