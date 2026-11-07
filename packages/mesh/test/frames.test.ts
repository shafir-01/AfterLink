import { describe, expect, it } from 'vitest';
import { encodeFrames, FRAME_PAYLOAD_BYTES, FrameDecoder } from '../src/index.ts';

const roundTrip = (msg: unknown) => {
  const decoder = new FrameDecoder();
  const frames = encodeFrames(msg);
  const results = frames.map((f) => decoder.push(f));
  expect(results.filter((r) => r.done)).toHaveLength(1);
  const last = results.at(-1)!;
  return { frames, msg: last.done ? last.msg : undefined };
};

describe('frames', () => {
  it('sends a small message as one frame', () => {
    const { frames, msg } = roundTrip({ t: 'ping', n: 1 });
    expect(frames).toHaveLength(1);
    expect(msg).toEqual({ t: 'ping', n: 1 });
  });

  it('keeps every frame of a large message under 16 KB', () => {
    const payload = { t: 'events', data: 'x'.repeat(200_000) };
    const { frames, msg } = roundTrip(payload);
    expect(frames.length).toBeGreaterThan(10);
    for (const f of frames) expect(f.length).toBeLessThan(16 * 1024);
    expect(msg).toEqual(payload);
  });

  it('survives multibyte text split across a frame boundary', () => {
    const payload = { text: 'å€🙂'.repeat(20_000) };
    expect(roundTrip(payload).msg).toEqual(payload);
  });

  it('handles an exact multiple of the frame size', () => {
    const overhead = JSON.stringify({ d: '' }).length;
    const payload = { d: 'x'.repeat(FRAME_PAYLOAD_BYTES * 2 - overhead) };
    const { frames, msg } = roundTrip(payload);
    expect(frames).toHaveLength(2);
    expect(msg).toEqual(payload);
  });

  it('decodes consecutive messages on one stream', () => {
    const decoder = new FrameDecoder();
    const out: unknown[] = [];
    for (const m of [{ a: 'x'.repeat(40_000) }, { b: 2 }, { c: 'y'.repeat(20_000) }]) {
      for (const f of encodeFrames(m)) {
        const r = decoder.push(f);
        if (r.done) out.push(r.msg);
      }
    }
    expect(out).toHaveLength(3);
    expect(out[1]).toEqual({ b: 2 });
  });

  it('refuses a message past the limit instead of buffering without end', () => {
    const decoder = new FrameDecoder();
    const frame = new Uint8Array(FRAME_PAYLOAD_BYTES + 1);
    expect(() => {
      for (let i = 0; i < 100; i++) decoder.push(frame);
    }).toThrow('too large');
  });

  it('refuses empty frames and invalid payloads', () => {
    expect(() => new FrameDecoder().push(new Uint8Array(0))).toThrow();
    expect(() => new FrameDecoder().push(new Uint8Array([1, 123, 123]))).toThrow();
  });
});
