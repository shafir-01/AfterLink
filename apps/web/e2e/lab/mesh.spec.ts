import { expect, test, type Frame, type Page } from '@playwright/test';
import { instrument } from '../support/harness';
import type { Arrival, Probe, ProbeConnection } from '../support/probe';

const names = ['A', 'B', 'C', 'D'] as const;
type Name = (typeof names)[number];

type Lab = {
  emit(n?: number, pad?: number): string[];
  ids(): string[];
  has(id: string): boolean;
  size(): number;
  summary(): unknown;
  links(): { peer: string; state: string }[];
  reachable(): string[];
  signalUp(): boolean;
  block(peers: string[]): void;
};
type DeviceWin = Window & { lab: Lab; __probe: Probe };
type StageWin = Window & { stage: { ids(): Record<Name, string>; load(): Promise<void>; startHq(): void; killHq(): void } };

const frame = (page: Page, n: Name): Frame => {
  const f = page.frame({ name: n });
  if (!f) throw new Error(`no frame ${n}`);
  return f;
};
const lab = <T,>(page: Page, n: Name, fn: (l: Lab, arg: unknown) => T, arg?: unknown) =>
  frame(page, n).evaluate(
    ([src, a]) => {
      const run = new Function('l', 'a', `return (${src as string})(l, a)`);
      return run((window as unknown as DeviceWin).lab, a) as T;
    },
    [fn.toString(), arg] as const,
  );
const conns = (page: Page, n: Name): Promise<ProbeConnection[]> =>
  frame(page, n).evaluate(() => (window as unknown as DeviceWin).__probe.connections());
const arrivals = (page: Page, n: Name): Promise<Arrival[]> => frame(page, n).evaluate(() => (window as unknown as DeviceWin).__probe.arrivals());

const liveCount = (cs: ProbeConnection[]) => cs.filter((c) => c.connectionState === 'connected' && c.channels.some((ch) => ch.readyState === 'open')).length;

async function openLinks(page: Page) {
  let open = 0;
  for (const n of names) open += liveCount(await conns(page, n));
  return open;
}

async function logs(page: Page) {
  return Promise.all(names.map((n) => lab(page, n, (l) => l.ids())));
}

async function expectConverged(page: Page, size?: number) {
  await expect
    .poll(
      async () => {
        const all = await logs(page);
        return { same: all.every((ids) => JSON.stringify(ids) === JSON.stringify(all[0])), size: all[0]!.length };
      },
      { timeout: 30_000 },
    )
    .toEqual({ same: true, size: size ?? expect.any(Number) });
}

async function boot(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await instrument(page.context());
  await page.goto('/e2e/lab/mesh.html');
  await page.waitForFunction(() => 'stage' in window);
  await page.evaluate(() => (window as unknown as StageWin).stage.load());
  await page.evaluate(() => (window as unknown as StageWin).stage.startHq());
  await expect.poll(() => openLinks(page), { timeout: 30_000 }).toBe(12);
  const ids = await page.evaluate(() => (window as unknown as StageWin).stage.ids());
  return { ids, errors };
}

async function partition(page: Page, ids: Record<Name, string>) {
  for (const n of ['A', 'B'] as const) await lab(page, n, (l, p) => l.block(p as string[]), [ids.C, ids.D]);
  for (const n of ['C', 'D'] as const) await lab(page, n, (l, p) => l.block(p as string[]), [ids.A, ids.B]);
}

async function heal(page: Page) {
  for (const n of names) await lab(page, n, (l) => l.block([]));
}

test('real mesh over real WebRTC: signalling through the HQ worker, anti-entropy converges every log', async ({ page }) => {
  const { errors } = await boot(page);
  for (const n of names) {
    await lab(page, n, (l) => l.emit(3));
    expect(await lab(page, n, (l) => l.signalUp())).toBe(true);
  }
  await expectConverged(page, 12);
  expect(errors).toEqual([]);
});

test('killing the HQ worker: devices notice by pulse, the sync path keeps running peer to peer', async ({ page }) => {
  const { errors } = await boot(page);
  await expect.poll(() => page.workers().length).toBeGreaterThan(0);
  const before = (await arrivals(page, 'B')).length;

  const killedAt = Date.now();
  await page.evaluate(() => (window as unknown as StageWin).stage.killHq());
  await expect.poll(() => page.workers().length, { timeout: 5_000 }).toBe(0);

  await expect
    .poll(async () => (await Promise.all(names.map((n) => lab(page, n, (l) => l.signalUp())))).filter(Boolean).length, { timeout: 5_000, intervals: [100] })
    .toBe(0);
  console.log(JSON.stringify({ signalDownNoticedMs: Date.now() - killedAt }));

  const [id] = await lab(page, 'A', (l) => l.emit(1));
  await expect.poll(() => lab(page, 'D', (l, x) => l.has(x as string), id)).toBe(true);

  const crossed = (await arrivals(page, 'B')).slice(before);
  expect(crossed.map((a) => a.id)).toContain(id);
  expect(crossed.find((a) => a.id === id)!.at).toBeGreaterThan(killedAt);
  expect(await openLinks(page)).toBe(12);
  expect(errors).toEqual([]);
});

test('partition really severs: cross links close, nothing crosses, dials are refused for the duration', async ({ page }) => {
  const { ids, errors } = await boot(page);
  await page.evaluate(() => (window as unknown as StageWin).stage.killHq());
  await partition(page, ids);
  await expect.poll(() => openLinks(page)).toBe(4);

  const [inA] = await lab(page, 'A', (l) => l.emit(1));
  const [inC] = await lab(page, 'C', (l) => l.emit(1));
  await expect.poll(() => lab(page, 'B', (l, x) => l.has(x as string), inA)).toBe(true);
  await expect.poll(() => lab(page, 'D', (l, x) => l.has(x as string), inC)).toBe(true);

  await page.waitForTimeout(5_000);
  for (const n of ['C', 'D'] as const) expect(await lab(page, n, (l, x) => l.has(x as string), inA)).toBe(false);
  for (const n of ['A', 'B'] as const) expect(await lab(page, n, (l, x) => l.has(x as string), inC)).toBe(false);
  expect(await openLinks(page)).toBe(4);
  expect(errors).toEqual([]);
});

test('restore: a fresh worker and cleared faults rebuild 12 links and every log converges in the same order', async ({ page }) => {
  const { ids, errors } = await boot(page);
  await page.evaluate(() => (window as unknown as StageWin).stage.killHq());
  await partition(page, ids);
  await expect.poll(() => openLinks(page)).toBe(4);
  await lab(page, 'A', (l) => l.emit(5));
  await lab(page, 'C', (l) => l.emit(7));
  await lab(page, 'D', (l) => l.emit(2));

  await page.evaluate(() => (window as unknown as StageWin).stage.startHq());
  await heal(page);
  await expect.poll(() => openLinks(page), { timeout: 30_000 }).toBe(12);
  await expectConverged(page, 14);
  expect(errors).toEqual([]);
});

test('sync crosses the 16 KB data channel frame limit without loss', async ({ page }) => {
  const { errors } = await boot(page);
  await lab(page, 'A', (l) => l.emit(40, 2000));
  await expectConverged(page, 40);
  expect(errors).toEqual([]);
});

test('five partition and heal cycles with live traffic still converge', async ({ page }) => {
  test.setTimeout(180_000);
  const { ids, errors } = await boot(page);
  let total = 0;
  for (let cycle = 0; cycle < 5; cycle += 1) {
    await partition(page, ids);
    await expect.poll(() => openLinks(page), { timeout: 15_000 }).toBe(4);
    await lab(page, 'B', (l) => l.emit(2));
    await lab(page, 'C', (l) => l.emit(3));
    total += 5;
    await heal(page);
    await expect.poll(() => openLinks(page), { timeout: 30_000 }).toBe(12);
    await expectConverged(page, total);
  }
  expect(errors).toEqual([]);
});
