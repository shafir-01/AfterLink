import { describe, expect, it } from 'vitest';
import { createContext } from '../src/context.ts';
import type { HubLike } from '../src/hq.ts';
import type { SignalMessage } from '@afterlink/protocol';

const hub = (): HubLike => ({ connect: () => ({ receive() {}, close() {} }), state: () => null });
const spec = { id: 'ext-1', kind: 'assist', title: 't', brief: 't', objective: 'assist', priority: 2, location: { x: 1, y: 1 }, locationName: 'x', requires: [], needs: [], dependsOn: [], reversible: true };
const msg = { t: 'ingress' as const, ref: 'r1', spec } as Extract<SignalMessage, { t: 'ingress' }>;

describe('hq ingress transport', () => {
  it('returns false with no device, then delivers after hello and stops after close', async () => {
    const ctx = await createContext({ env: {}, hub });
    expect(ctx.ingress.deliver(msg)).toBe(false);
    let ready = 0;
    ctx.ingress.onDeviceReady?.(() => ready++);
    const got: SignalMessage[] = [];
    const s = ctx.hq.open((m) => got.push(m), () => {})!;
    s.receive({ t: 'hello', room: 'r', actor: 'a' });
    expect(ready).toBe(1);
    expect(ctx.ingress.deliver(msg)).toBe(true);
    expect(got).toEqual([msg]);
    s.close();
    expect(ctx.ingress.deliver(msg)).toBe(false);
  });
});
