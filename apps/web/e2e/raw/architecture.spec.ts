import { expect, test, type Frame, type Page } from '@playwright/test';

const ids = ['A', 'B', 'C', 'D'] as const;
type Id = (typeof ids)[number];
type LinkView = { pc: string; ice: string; dc: string };

declare global {
  interface Window {
    stage: {
      load(): Promise<unknown>;
      startHub(): void;
      attach(id: string): void;
      attachAll(): void;
      killHub(): void;
      hubAlive(): boolean;
      reloadDevice(id: string): Promise<unknown>;
    };
    device: {
      id: string;
      log: {
        candidates: { peer: string; type: string; address: string; protocol: string }[];
        portCloseEvents: number;
        linkEvents: { peer: string; kind: string; state: string; at: number }[];
      };
      links(): Record<string, LinkView>;
      pairs(): Promise<
        Record<string, { local: string; remote: string; rttMs: number | null; bytesSent: number; bytesReceived: number } | null>
      >;
      connectMs(): Record<string, number>;
      sendAll(tag: string, n: number): number;
      send(peer: string, tag: string): boolean;
      count(peer: string, tag: string): number;
      pingHub(ms: number): Promise<boolean>;
      sever(peer: string): void;
      unblockAll(): void;
      rejoin(peers: string[]): void;
    };
  }
}

const device = (page: Page, id: Id): Frame => {
  const frame = page.frame({ name: id });
  if (!frame) throw new Error(`no frame ${id}`);
  return frame;
};

const linksOf = (page: Page, id: Id) => device(page, id).evaluate(() => window.device.links());

async function openLinkCount(page: Page) {
  let open = 0;
  for (const id of ids) {
    const links = await linksOf(page, id);
    open += Object.values(links).filter((l) => l.pc === 'connected' && l.dc === 'open').length;
  }
  return open;
}

async function boot(page: Page) {
  await page.goto('/stage.html');
  await page.evaluate(() => window.stage.load());
  await page.evaluate(() => {
    window.stage.startHub();
    window.stage.attachAll();
  });
  await expect.poll(() => openLinkCount(page), { timeout: 30_000 }).toBe(12);
}

async function expectAllToAll(page: Page, tag: string, n: number) {
  for (const id of ids) {
    await device(page, id).evaluate(([t, c]) => window.device.sendAll(t as string, c as number), [tag, n] as const);
  }
  await expect
    .poll(
      async () => {
        let got = 0;
        for (const id of ids) {
          for (const peer of ids) {
            if (peer === id) continue;
            got += await device(page, id).evaluate(([p, t]) => window.device.count(p, t), [peer, tag] as const);
          }
        }
        return got;
      },
      { timeout: 15_000 },
    )
    .toBe(12 * n);
}

async function hubReachableCount(page: Page) {
  const results = await Promise.all(ids.map((id) => device(page, id).evaluate(() => window.device.pingHub(1500))));
  return results.filter(Boolean).length;
}

const severBoth = async (page: Page, a: Id, b: Id) => {
  await device(page, a).evaluate((p) => window.device.sever(p), b);
  await device(page, b).evaluate((p) => window.device.sever(p), a);
};

test('a worker hub brokers four iframes into a full WebRTC mesh over transferred MessagePorts', async ({ page }, info) => {
  await boot(page);
  expect(await hubReachableCount(page)).toBe(4);
  await expectAllToAll(page, 'intact', 25);

  const report: Record<string, unknown> = {};
  for (const id of ids) {
    report[id] = await device(page, id).evaluate(async () => ({
      connectMs: window.device.connectMs(),
      pairs: await window.device.pairs(),
      candidates: [...new Set(window.device.log.candidates.map((c) => `${c.type}/${c.protocol}/${c.address}`))],
    }));
  }
  console.log(JSON.stringify({ project: info.project.name, ua: await page.evaluate(() => navigator.userAgent), report }));
});

test('terminating the worker removes signalling and leaves every data channel carrying messages', async ({ page }, info) => {
  await boot(page);
  expect(await hubReachableCount(page)).toBe(4);

  await page.evaluate(() => window.stage.killHub());
  expect(await page.evaluate(() => window.stage.hubAlive())).toBe(false);
  expect(await hubReachableCount(page)).toBe(0);

  await expectAllToAll(page, 'after-kill', 200);
  expect(await openLinkCount(page)).toBe(12);

  const closeEvents = await Promise.all(ids.map((id) => device(page, id).evaluate(() => window.device.log.portCloseEvents)));
  console.log(JSON.stringify({ project: info.project.name, portCloseEventsAfterTerminate: closeEvents }));
});

test('channels outlive the ICE consent window with the worker gone', async ({ page }) => {
  test.setTimeout(150_000);
  await boot(page);
  await page.evaluate(() => window.stage.killHub());

  for (let s = 0; s < 45; s += 15) {
    await page.waitForTimeout(15_000);
    await expectAllToAll(page, `soak-${s}`, 10);
  }
  expect(await openLinkCount(page)).toBe(12);
});

test('severing closes the link, bytes stop, and a restarted worker re-forms it', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.stage.killHub());

  for (const [a, b] of [['A', 'C'], ['A', 'D'], ['B', 'C'], ['B', 'D']] as const) await severBoth(page, a, b);

  expect(await device(page, 'A').evaluate(() => window.device.send('C', 'cross'))).toBe(false);
  expect(await device(page, 'A').evaluate(() => window.device.send('B', 'inside'))).toBe(true);
  expect(await device(page, 'C').evaluate(() => window.device.send('D', 'inside'))).toBe(true);
  await expect.poll(() => device(page, 'B').evaluate(() => window.device.count('A', 'inside'))).toBe(1);
  await expect.poll(() => device(page, 'D').evaluate(() => window.device.count('C', 'inside'))).toBe(1);
  expect(await device(page, 'C').evaluate(() => window.device.count('A', 'cross'))).toBe(0);

  await page.evaluate(() => {
    window.stage.startHub();
    window.stage.attachAll();
  });
  await expect.poll(() => hubReachableCount(page)).toBe(4);
  for (const id of ids) await device(page, id).evaluate(() => window.device.unblockAll());
  await device(page, 'A').evaluate(() => window.device.rejoin(['C', 'D']));
  await device(page, 'B').evaluate(() => window.device.rejoin(['C', 'D']));
  await expect.poll(() => openLinkCount(page), { timeout: 30_000 }).toBe(12);
  await expectAllToAll(page, 'restored', 20);
});

test('one sided close: how long the far side takes to notice', async ({ page }, info) => {
  await boot(page);
  await page.evaluate(() => window.stage.killHub());
  const start = await device(page, 'B').evaluate(() => performance.now());
  await device(page, 'A').evaluate(() => window.device.sever('B'));
  await expect.poll(async () => (await linksOf(page, 'B')).A?.dc, { timeout: 45_000, intervals: [100] }).toBe('closed');
  const events = await device(page, 'B').evaluate(() => window.device.log.linkEvents.filter((e) => e.peer === 'A'));
  const after = events.filter((e) => e.at >= start).map((e) => ({ kind: e.kind, state: e.state, ms: Math.round(e.at - start) }));
  console.log(JSON.stringify({ project: info.project.name, farSideAfterOneSidedClose: after }));
});

test('reloading a device with the worker gone: peers notice, it stays isolated until signalling returns', async ({ page }, info) => {
  await boot(page);
  await page.evaluate(() => window.stage.killHub());
  const start = await device(page, 'A').evaluate(() => performance.now());

  await page.evaluate(() => window.stage.reloadDevice('C'));
  await expect.poll(async () => (await linksOf(page, 'A')).C?.dc, { timeout: 45_000, intervals: [100] }).toBe('closed');
  const events = await device(page, 'A').evaluate(() => window.device.log.linkEvents.filter((e) => e.peer === 'C'));
  const after = events.filter((e) => e.at >= start).map((e) => ({ kind: e.kind, state: e.state, ms: Math.round(e.at - start) }));
  console.log(JSON.stringify({ project: info.project.name, peerAfterDeviceReload: after }));

  expect(await device(page, 'C').evaluate(() => Object.keys(window.device.links()).length)).toBe(0);
  expect(await device(page, 'A').evaluate(() => window.device.send('B', 'still-up'))).toBe(true);
  await expect.poll(() => device(page, 'B').evaluate(() => window.device.count('A', 'still-up'))).toBe(1);
});
