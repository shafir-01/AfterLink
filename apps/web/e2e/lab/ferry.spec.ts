import { expect, test } from '@playwright/test';

type Result = {
  frames: number;
  canvas: { width: number; height: number };
  decodeMs: number;
  verified: boolean;
  tamperedVerified: boolean;
  first: { ok: boolean; newEvents: number; duplicates: number; rejected: number };
  replay: { ok: boolean; newEvents: number; duplicates: number; rejected: number };
  replayChangedHeads: boolean;
  receiverSize: number;
  senderSize: number;
};

for (const events of [1, 12, 40]) {
  test(`QR ferry on a real canvas: ${events} events render, decode from pixels, verify, and replay as a no-op`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/e2e/lab/ferry.html');
    await page.waitForFunction(() => 'ferryLab' in window);

    const r = await page.evaluate((n) => (window as unknown as { ferryLab: { run(n: number): Promise<Result> } }).ferryLab.run(n), events);
    console.log(JSON.stringify({ project: info.project.name, events, ...r }));

    expect(errors).toEqual([]);
    expect(r.verified).toBe(true);
    expect(r.tamperedVerified).toBe(false);
    expect(r.first).toMatchObject({ ok: true, newEvents: events, rejected: 0 });
    expect(r.replay).toMatchObject({ newEvents: 0, duplicates: events, rejected: 0 });
    expect(r.replayChangedHeads).toBe(false);
    expect(r.receiverSize).toBe(r.senderSize);
  });
}
