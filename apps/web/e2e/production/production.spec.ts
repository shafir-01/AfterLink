import { expect, test, type Page } from '@playwright/test';

/** Run with `E2E_PRODUCTION=1 npx playwright test --project=production`. See serve.mjs for what it stands in for. */

const ROOT = 'http://127.0.0.1:4194/AfterLink/';
const RELAY = '127.0.0.1:4195';

function watch(page: Page) {
  const problems: string[] = [];
  const relayCalls: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(m.text());
  });
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('request', (r) => {
    if (r.url().includes(RELAY)) relayCalls.push(r.url());
  });
  return { problems, relayCalls };
}

const ready = (page: Page) => expect(page.getByRole('button', { name: 'Break the network', exact: true })).toBeEnabled({ timeout: 45_000 });

test('head, manifest and build stamp resolve under the base path', async ({ page, request }) => {
  await page.goto(ROOT);
  await expect(page).toHaveTitle(/^AfterLink/);
  const meta = (selector: string) => page.locator(selector).getAttribute('content');
  expect(await meta('meta[name="description"]')).toBeTruthy();
  expect(await meta('meta[name="theme-color"]')).toBe('#0A0A0B');
  expect(await meta('meta[name="twitter:card"]')).toBe('summary_large_image');
  expect(await meta('meta[property="og:url"]')).toBe(ROOT);

  const image = await meta('meta[property="og:image"]');
  expect(image).toBe(`${ROOT}brand/og.png`);
  expect((await request.get(image!)).ok()).toBe(true);

  const hrefs = await page.locator('link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="manifest"]').evaluateAll((links) => links.map((l) => (l as HTMLLinkElement).href));
  expect(hrefs.length).toBeGreaterThanOrEqual(4);
  for (const href of hrefs) {
    expect(href.startsWith(ROOT), href).toBe(true);
    expect((await request.get(href)).ok(), href).toBe(true);
  }

  const manifest = await (await request.get(`${ROOT}manifest.webmanifest`)).json();
  expect(manifest).toMatchObject({ start_url: '/AfterLink/', scope: '/AfterLink/', id: '/AfterLink/' });
  expect(manifest.icons.map((i: { purpose?: string }) => i.purpose ?? 'any').sort()).toEqual(['any', 'any', 'maskable', 'maskable']);
  for (const icon of manifest.icons) expect((await request.get(ROOT + icon.src)).ok(), icon.src).toBe(true);

  expect((await (await request.get(`${ROOT}build.json`)).json()).hash).toBeTruthy();
});

test('the stage runs on a static host with no relay: base-path iframes and worker, nothing asked of the relay, a silent console', async ({ page }) => {
  const seen = watch(page);
  const workers: string[] = [];
  page.on('worker', (w) => workers.push(w.url()));
  await page.goto(ROOT);
  await ready(page);

  expect(page.frames().filter((f) => f.url().startsWith(`${ROOT}?device=`))).toHaveLength(4);
  expect(workers.some((url) => url.startsWith(`${ROOT}assets/`))).toBe(true);

  await page.getByRole('button', { name: 'Break the network', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Split the teams', exact: true })).toBeEnabled({ timeout: 30_000 });

  expect(seen.relayCalls).toEqual([]);
  expect(seen.problems).toEqual([]);
});

test('an asleep relay is reported in plain words, without an error in the console', async ({ page }) => {
  const seen = watch(page);
  await page.goto(`${ROOT}#/compose`);
  await page.getByLabel('Describe the mission').fill('Keep the festival safe');
  await page.getByRole('button', { name: 'Draft mission' }).click();
  await expect(page.getByText('The drafting service is unavailable.')).toBeVisible({ timeout: 10_000 });
  expect(seen.relayCalls.filter((url) => !url.endsWith('/api/status'))).toEqual([]);
  expect(seen.relayCalls.length).toBeLessThanOrEqual(1);
  expect(seen.problems).toEqual([]);
});

test('unknown paths and unknown routes say so and lead home', async ({ page }) => {
  const response = await page.goto(`${ROOT}no/such/page`);
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await page.getByRole('link', { name: 'Go to AfterLink' }).click();
  await ready(page);

  await page.goto(`${ROOT}#/no-such-route`);
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
});

test('a browser without WebRTC is told so', async ({ page }) => {
  await page.addInitScript(() => {
    delete (window as { RTCPeerConnection?: unknown }).RTCPeerConnection;
  });
  const seen = watch(page);
  await page.goto(ROOT);
  await expect(page.getByRole('heading', { name: "This browser can't run AfterLink" })).toBeVisible();
  await expect(page.getByText('It needs WebRTC.')).toBeVisible();
  expect(seen.problems).toEqual([]);
});

test('a view that fails to load offers a reload instead of a blank page', async ({ page }) => {
  await page.route('**/assets/ComposeRoute-*.js', (route) => route.abort());
  await page.goto(`${ROOT}#/compose`);
  await expect(page.getByRole('heading', { name: 'Compose unavailable' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reload' })).toBeVisible();
});

async function visitOnce(page: Page) {
  await page.goto(ROOT);
  await ready(page);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (navigator.serviceWorker.controller) return;
    await new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
  });
  expect(await page.evaluate(async () => (await navigator.serviceWorker.ready).scope)).toBe(ROOT);
}

test('after one visit, the browser offline: the app, all four devices and every route still load', async ({ page, context }) => {
  await visitOnce(page);
  await context.setOffline(true);
  const seen = watch(page);
  await page.reload();

  const devices = () => page.frames().filter((f) => f.url().startsWith(`${ROOT}?device=`));
  await expect.poll(() => devices().length, { timeout: 20_000 }).toBe(4);
  for (const frame of devices()) await expect(frame.locator('main, .field').first()).toBeVisible({ timeout: 20_000 });

  for (const route of ['verify', 'compose', 'debrief', 'lead']) {
    await page.goto(`${ROOT}#/${route}`);
    await page.reload();
    await expect(page.locator('main').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('unavailable')).toHaveCount(0);
  }
  expect(seen.problems).toEqual([]);
  await context.setOffline(false);
});

test('after one visit, the host gone but the Wi-Fi up: the mission runs peer to peer', async ({ page, request }) => {
  await visitOnce(page);
  await request.get(`${new URL(ROOT).origin}/outage?down=1`);
  const seen = watch(page);
  try {
    await page.reload();
    await ready(page);
    expect(page.frames().filter((f) => f.url().startsWith(`${ROOT}?device=`))).toHaveLength(4);
    await page.getByRole('button', { name: 'Break the network', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Split the teams', exact: true })).toBeEnabled({ timeout: 30_000 });
    expect(seen.problems).toEqual([]);
  } finally {
    await request.get(`${new URL(ROOT).origin}/outage?down=0`);
  }
});
