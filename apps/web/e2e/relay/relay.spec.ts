import { expect, test, type BrowserContext, type Browser, type Page } from '@playwright/test';
import type { ProvisionBundle } from '@afterlink/protocol';
import { instrument } from '../support/harness';
import type { Arrival, Probe, ProbeConnection } from '../support/probe';
import { RelayProcess, chainFaults, deviceLink, provisionMission, storedLog } from '../support/relay';

type Win = Window & { __probe: Probe };

const conns = (p: Page): Promise<ProbeConnection[]> => p.evaluate(() => (window as unknown as Win).__probe.connections());
const arrivals = (p: Page): Promise<Arrival[]> => p.evaluate(() => (window as unknown as Win).__probe.arrivals());
const open = (cs: ProbeConnection[]) => cs.filter((c) => c.connectionState === 'connected' && c.channels.some((ch) => ch.readyState === 'open')).length;

const relay = new RelayProcess();

test.beforeEach(async () => {
  await relay.start();
});
test.afterEach(async () => {
  await relay.kill();
});

async function device(browser: Browser, bundle: ProvisionBundle): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  await instrument(context);
  await context.route('**/api/voice/**', (route) =>
    route.request().method() === 'OPTIONS'
      ? route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } })
      : route.fulfill({ status: 503, headers: { 'access-control-allow-origin': '*' }, json: { live: false } }),
  );
  const page = await context.newPage();
  await page.goto(deviceLink(bundle));
  await expect(page.getByRole('heading', { level: 1, name: bundle.name })).toBeVisible({ timeout: 30_000 });
  return { context, page };
}

test('two separate browser contexts: signalling over the relay WebSocket, data peer to peer, relay killed, work continues', async ({ browser }) => {
  test.setTimeout(120_000);
  const bundles = provisionMission(`relay-${Date.now()}`);
  const a = await device(browser, bundles.medics!);
  const b = await device(browser, bundles.access!);
  const sockets = { a: 0, b: 0 };
  a.page.on('websocket', () => (sockets.a += 1));
  b.page.on('websocket', () => (sockets.b += 1));

  await test.step('they find each other through the relay and open a real peer connection', async () => {
    await expect.poll(async () => open(await conns(a.page)), { timeout: 30_000 }).toBe(1);
    await expect.poll(async () => open(await conns(b.page)), { timeout: 30_000 }).toBe(1);
    await expect(a.page.locator('.f-conn')).toHaveText(/Connected/, { timeout: 15_000 });
    await expect(b.page.locator('.f-conn')).toHaveText(/Connected/, { timeout: 15_000 });
  });

  await test.step('a tap in one context reaches the other over the data channel', async () => {
    await expect(a.page.getByRole('button', { name: 'Accept', exact: true })).toBeVisible({ timeout: 20_000 });
    await a.page.getByRole('button', { name: 'Accept', exact: true }).click();
    await expect.poll(async () => (await arrivals(b.page)).some((e) => e.type === 'task.accepted'), { timeout: 15_000 }).toBe(true);
  });

  let killedAt = 0;
  await test.step('the relay process dies and the devices say so', async () => {
    killedAt = Date.now();
    await relay.kill();
    expect(await relay.isUp()).toBe(false);
    await expect(a.page.locator('.f-conn')).toHaveText(/Team only/, { timeout: 15_000 });
    await expect(b.page.locator('.f-conn')).toHaveText(/Team only/, { timeout: 15_000 });
    expect(open(await conns(a.page))).toBe(1);
    expect(open(await conns(b.page))).toBe(1);
  });

  await test.step('work still crosses, with no server of any kind running', async () => {
    await a.page.getByRole('button', { name: 'Done', exact: true }).click();
    await expect
      .poll(async () => (await arrivals(b.page)).filter((e) => e.type === 'task.completed' && e.at > killedAt).length, {
        message: 'the completion must arrive over the data channel after the relay died',
        timeout: 15_000,
      })
      .toBeGreaterThan(0);
  });

  await test.step('the relay returns and the devices reconnect to it on their own', async () => {
    await relay.start();
    await expect(a.page.locator('.f-conn')).toHaveText(/Connected/, { timeout: 30_000 });
    await expect(b.page.locator('.f-conn')).toHaveText(/Connected/, { timeout: 30_000 });
    expect(open(await conns(a.page))).toBe(1);
  });

  await a.context.close();
  await b.context.close();
});

test('four separate browser contexts form the full mesh through the relay', async ({ browser }) => {
  const bundles = provisionMission(`relay4-${Date.now()}`);
  const devices = await Promise.all(Object.values(bundles).map((b) => device(browser, b)));
  await expect
    .poll(async () => (await Promise.all(devices.map(async (d) => open(await conns(d.page))))).reduce((n, c) => n + c, 0), { timeout: 40_000 })
    .toBe(12);
  await Promise.all(devices.map((d) => d.context.close()));
});

test('a phone reloaded while the relay is dead keeps its identity, rights and log, and its chain stays whole', async ({ browser }) => {
  test.setTimeout(120_000);
  const bundles = provisionMission(`reload-${Date.now()}`);
  const a = await device(browser, bundles.medics!);
  const b = await device(browser, bundles.access!);
  await expect.poll(async () => open(await conns(a.page)), { timeout: 30_000 }).toBe(1);

  const accept = a.page.getByRole('button', { name: 'Accept', exact: true });
  await expect(accept).toBeVisible({ timeout: 20_000 });
  await accept.click();
  await expect(a.page.getByRole('button', { name: 'Done', exact: true })).toBeVisible({ timeout: 10_000 });

  await relay.kill();
  await expect(a.page.locator('.f-conn')).toHaveText(/Team only/, { timeout: 15_000 });
  const before = await storedLog(a.page, bundles.medics!);
  expect(before.length).toBeGreaterThan(0);

  await a.page.reload();

  await test.step('it comes back as the same device with nothing lost', async () => {
    await expect(a.page.getByRole('heading', { level: 1, name: 'Medics' })).toBeVisible({ timeout: 20_000 });
    await expect(a.page.getByRole('list', { name: 'Rights you hold' })).toContainText('AED');
    const after = await storedLog(a.page, bundles.medics!);
    const ids = after.map((e) => e.id);
    expect(new Set(ids).size, 'no event stored twice').toBe(ids.length);
    for (const e of before) expect(ids).toContain(e.id);
    expect(chainFaults(after)).toEqual([]);
  });

  await test.step('with no signalling it says it is alone, and its peer sees the same', async () => {
    await expect(a.page.locator('.f-conn')).toHaveText(/Alone/, { timeout: 15_000 });
    await expect.poll(async () => open(await conns(b.page)), { timeout: 15_000 }).toBe(0);
    await expect(b.page.locator('.f-conn')).toHaveText(/Alone/, { timeout: 15_000 });
  });

  await test.step('it can still act alone, and the action is durable', async () => {
    const done = a.page.getByRole('button', { name: 'Done', exact: true });
    await expect(done).toBeVisible({ timeout: 10_000 });
    await done.click();
    await expect
      .poll(async () => (await storedLog(a.page, bundles.medics!)).filter((e) => e.type === 'task.completed').length, { timeout: 10_000 })
      .toBeGreaterThan(0);
  });

  await test.step('when the relay returns they reconnect and hold the same history, with no fork', async () => {
    await relay.start();
    await expect.poll(async () => open(await conns(a.page)), { timeout: 30_000 }).toBe(1);
    await expect(a.page.locator('.f-conn')).toHaveText(/Connected/, { timeout: 15_000 });
    await expect
      .poll(
        async () => {
          const [la, lb] = await Promise.all([storedLog(a.page, bundles.medics!), storedLog(b.page, bundles.access!)]);
          const key = (l: typeof la) => JSON.stringify(l.map((e) => e.id).sort());
          return key(la) === key(lb);
        },
        { message: 'both devices hold identical event sets', timeout: 20_000 },
      )
      .toBe(true);
    const final = await storedLog(b.page, bundles.access!);
    expect(chainFaults(final)).toEqual([]);
  });

  await a.context.close();
  await b.context.close();
});

test('a real phone keeps voice prefetch bounded across task changes when the relay cannot synthesise', async ({ browser }, info) => {
  test.setTimeout(120_000);
  const bundles = provisionMission(`voice-${Date.now()}`);
  const context = await browser.newContext();
  await instrument(context);
  const calls: string[] = [];
  await context.route('**/api/voice/brief', (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
    const body = req.postDataJSON() as { role: string; text: string };
    calls.push(`${body.role}|${body.text}`);
    return route.fulfill({ status: 503, headers: { 'access-control-allow-origin': '*' }, json: { live: false } });
  });
  const page = await context.newPage();
  await page.goto(deviceLink(bundles.medics!));
  const peer = await device(browser, bundles.access!);

  const perStage: { afterTask: number; calls: number; worstClip: number }[] = [];
  const measure = (afterTask: number) => {
    const perClip = new Map<string, number>();
    for (const c of calls) perClip.set(c, (perClip.get(c) ?? 0) + 1);
    perStage.push({ afterTask, calls: calls.length, worstClip: Math.max(0, ...perClip.values()) });
  };

  for (let task = 1; task <= 3; task += 1) {
    const accept = page.getByRole('button', { name: 'Accept', exact: true });
    await expect(accept).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(3_000);
    measure(task);
    await accept.click();
    const done = page.getByRole('button', { name: 'Done', exact: true });
    await expect(done).toBeVisible({ timeout: 10_000 });
    await done.click();
  }
  console.log(JSON.stringify({ project: info.project.name, voiceTraffic: perStage }));

  const last = perStage.at(-1)!;
  expect(last.calls, 'control: a phone device with a task does prefetch voice').toBeGreaterThan(0);
  expect(last.worstClip, 'moving to the next task must not ask for the same clips again').toBeLessThanOrEqual(1);
  await context.close();
  await peer.context.close();
});
