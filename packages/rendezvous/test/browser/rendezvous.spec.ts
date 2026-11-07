import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { build } from 'esbuild';
import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import type { Rv } from './harness.ts';

declare global {
  interface Window {
    rv: Rv;
  }
}

type Keys = { publicKey: string; secretKey: string };

const mission = 'festival-day';
const HTML = '<!doctype html><title>rendezvous</title><canvas id="qr" width="480" height="480"></canvas><script src="/rv.js"></script>';

let bundle = '';

test.beforeAll(async () => {
  const out = await build({
    entryPoints: [fileURLToPath(new URL('./harness.ts', import.meta.url))],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    logLevel: 'silent',
  });
  bundle = out.outputFiles[0]!.text;
});

/** Serves the app shell once. Stopping it leaves the pages with nothing to reach. */
function startServer(): Promise<{ url: string; stop(): Promise<void>; hits(): number }> {
  let hits = 0;
  const server: Server = createServer((req, res) => {
    hits++;
    if (req.url === '/rv.js') res.writeHead(200, { 'content-type': 'text/javascript' }).end(bundle);
    else if (req.url === '/') res.writeHead(200, { 'content-type': 'text/html' }).end(HTML);
    else res.writeHead(404).end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
        hits: () => hits,
        stop: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

async function openDevices(browser: Browser, n: number): Promise<{ pages: Page[]; keys: Keys[]; requests: () => number; online: () => void }> {
  const server = await startServer();
  const context = await browser.newContext();
  const pages: Page[] = [];
  for (let i = 0; i < n; i++) {
    const page = await context.newPage();
    await page.goto(server.url);
    pages.push(page);
  }
  const keys: Keys[] = [];
  for (let i = 0; i < n; i++) keys.push(await pages[0]!.evaluate(() => window.rv.keys()));
  await server.stop();
  await expect(pages[0]!.request.get(server.url, { timeout: 1000 })).rejects.toThrow();
  let requests = 0;
  context.on('request', (r) => {
    if (!r.url().startsWith('data:')) requests++;
  });
  return { pages, keys, requests: () => requests, online: () => undefined };
}

const boot = (page: Page, o: { keys: Keys; roster: string[]; relay?: boolean; unreachable?: boolean; connectMs?: number }) =>
  page.evaluate((a) => window.rv.boot(a), { mission, ...o });

/** A person: photographs one screen and shows it to the other device's scanner. */
async function carry(from: Page, to: Page, frames: number): Promise<void> {
  for (let i = 0; i < frames; i++) {
    await from.evaluate((n) => window.rv.showFrame(n), i);
    const png = (await from.locator('#qr').screenshot()).toString('base64');
    const read = await to.evaluate((p) => window.rv.scan(p), png);
    expect(read.read, 'QR decoded from pixels').toBe(true);
  }
}

async function reconnect(a: Page, b: Page, to?: string) {
  const offer = await a.evaluate((t) => window.rv.showOffer(t), to);
  expect(offer.ok).toBe(true);
  await carry(a, b, offer.frames as number);
  const reply = await b.evaluate(() => window.rv.answer());
  expect(reply.ok).toBe(true);
  await carry(b, a, reply.frames as number);
  const done = await a.evaluate(() => window.rv.complete());
  return { offer, reply, done };
}

const openTo = (page: Page, peer: string) =>
  page.evaluate((p) => window.rv.links().find((l) => l.peer === p)?.state, peer);

test('two pages reconnect by QR with no server, and anti-entropy runs on the new link', async ({ browser }) => {
  const { pages, keys, requests } = await openDevices(browser, 2);
  const [a, b] = pages as [Page, Page];
  const [ka, kb] = keys as [Keys, Keys];
  const roster = keys.map((k) => k.publicKey);
  await boot(a, { keys: ka, roster });
  await boot(b, { keys: kb, roster });
  await a.evaluate(() => window.rv.emit(30, 'a'));
  await b.evaluate(() => window.rv.emit(20, 'b'));

  const { offer, reply, done } = await reconnect(a, b);
  console.log('measured', JSON.stringify({ offer: { bytes: offer.bytes, sdp: offer.sdpBytes, frames: offer.frames }, reply: { bytes: reply.bytes, sdp: reply.sdpBytes, frames: reply.frames }, done }));
  expect(done).toMatchObject({ ok: true, peer: kb.publicKey, limits: { requiresSharedNetwork: true } });
  expect(offer.frames).toBe(1);
  expect(reply.frames).toBe(1);
  expect(offer.bytes as number).toBeLessThan((offer.sdpBytes as number) / 2);

  await expect.poll(() => openTo(b, ka.publicKey)).toBe('open');
  await expect.poll(() => a.evaluate(() => window.rv.size())).toBe(50);
  await expect.poll(() => b.evaluate(() => window.rv.size())).toBe(50);

  await a.evaluate(() => window.rv.emit(5, 'later'));
  await expect.poll(() => b.evaluate(() => window.rv.size())).toBe(55);
  expect(requests()).toBe(0);
});

test("a stranger's QR cannot join, and a replayed code is refused", async ({ browser }) => {
  const { pages, keys } = await openDevices(browser, 3);
  const [a, b, intruder] = pages as [Page, Page, Page];
  const [ka, kb, ki] = keys as [Keys, Keys, Keys];
  const roster = [ka.publicKey, kb.publicKey];
  await boot(a, { keys: ka, roster });
  await boot(b, { keys: kb, roster });
  await boot(intruder, { keys: ki, roster: [...roster, ki.publicKey] });

  const hostile = await intruder.evaluate(() => window.rv.showOffer());
  await carry(intruder, b, 1);
  expect(await b.evaluate(() => window.rv.answer())).toMatchObject({ ok: false, reason: 'not-on-roster' });

  const offer = await a.evaluate(() => window.rv.showOffer());
  await carry(a, intruder, 1);
  const forged = await intruder.evaluate(() => window.rv.answer());
  expect(forged.ok).toBe(true);
  await carry(intruder, a, 1);
  expect(await a.evaluate(() => window.rv.complete())).toMatchObject({ ok: false, reason: 'not-on-roster' });

  await carry(a, b, offer.frames as number);
  expect((await b.evaluate(() => window.rv.answer())).ok).toBe(true);
  await carry(b, a, 1);
  expect(await a.evaluate(() => window.rv.complete())).toMatchObject({ ok: true, peer: kb.publicKey });
  expect(await b.evaluate((t) => window.rv.answerText(t), offer.text as string)).toMatchObject({ ok: false, reason: 'replayed' });
  expect(hostile.ok).toBe(true);
});

test('a slow carry does not stall the link: it opens as soon as the reply is scanned', async ({ browser }) => {
  const { pages, keys } = await openDevices(browser, 2);
  const [a, b] = pages as [Page, Page];
  const roster = keys.map((k) => k.publicKey);
  await boot(a, { keys: keys[0]!, roster });
  await boot(b, { keys: keys[1]!, roster });

  const offer = await a.evaluate(() => window.rv.showOffer());
  await carry(a, b, offer.frames as number);
  const reply = await b.evaluate(() => window.rv.answer());
  await new Promise((r) => setTimeout(r, 25_000));
  await carry(b, a, reply.frames as number);
  const done = await a.evaluate(() => window.rv.complete());
  console.log('slow carry ms', done.ms);
  expect(done).toMatchObject({ ok: true });
  expect(done.ms).toBeLessThan(2000);
});

test('no shared path fails honestly and points at the ferry', async ({ browser }) => {
  const { pages, keys } = await openDevices(browser, 2);
  const [a, b] = pages as [Page, Page];
  const roster = keys.map((k) => k.publicKey);
  await boot(a, { keys: keys[0]!, roster, unreachable: true, connectMs: 40_000 });
  await boot(b, { keys: keys[1]!, roster, unreachable: true });

  const offer = await a.evaluate(() => window.rv.showOffer());
  await carry(a, b, offer.frames as number);
  const reply = await b.evaluate(() => window.rv.answer());
  await carry(b, a, reply.frames as number);
  const done = await a.evaluate(() => window.rv.complete());
  console.log('no path', JSON.stringify(done));
  expect(done).toMatchObject({ ok: false, next: 'CARRY_UPDATE', limits: { requiresSharedNetwork: true } });
  expect(['no-shared-network', 'timeout']).toContain((done as unknown as { reason: string }).reason);
});

test('two QR scans introduce three devices, and the third link forms through a peer with no server', async ({ browser }) => {
  const { pages, keys, requests } = await openDevices(browser, 3);
  const [a, b, c] = pages as [Page, Page, Page];
  const [ka, kb, kc] = keys as [Keys, Keys, Keys];
  const roster = keys.map((k) => k.publicKey);
  for (const [page, k] of [[a, ka], [b, kb], [c, kc]] as const) await boot(page, { keys: k, roster, relay: true });

  expect((await reconnect(c, a)).done).toMatchObject({ ok: true });
  expect((await reconnect(c, b)).done).toMatchObject({ ok: true });

  const started = Date.now();
  await expect.poll(() => openTo(a, kb.publicKey), { timeout: 30_000 }).toBe('open');
  await expect.poll(() => openTo(b, ka.publicKey), { timeout: 30_000 }).toBe('open');
  console.log('relay healed in ms', Date.now() - started);

  await c.close();
  await expect.poll(() => openTo(a, kc.publicKey)).not.toBe('open');
  await a.evaluate(() => window.rv.emit(10, 'after-relay-left'));
  await expect.poll(() => b.evaluate(() => window.rv.size())).toBe(10);
  expect(requests()).toBe(0);
});

test('a link lost between two devices heals through the third', async ({ browser }) => {
  const { pages, keys } = await openDevices(browser, 3);
  const [a, b, c] = pages as [Page, Page, Page];
  const [ka, kb, kc] = keys as [Keys, Keys, Keys];
  const roster = keys.map((k) => k.publicKey);
  for (const [page, k] of [[a, ka], [b, kb], [c, kc]] as const) await boot(page, { keys: k, roster, relay: true });
  await reconnect(c, a);
  await reconnect(c, b);
  await expect.poll(() => openTo(a, kb.publicKey), { timeout: 30_000 }).toBe('open');

  await a.evaluate((p) => window.rv.stopPeer(p), kb.publicKey);
  await expect.poll(() => a.evaluate((p) => window.rv.links().find((l) => l.peer === p)?.opens, kb.publicKey), { timeout: 30_000 }).toBe(2);
  await expect.poll(() => openTo(b, ka.publicKey), { timeout: 30_000 }).toBe('open');
  await a.evaluate(() => window.rv.emit(3, 'healed'));
  await expect.poll(() => b.evaluate(() => window.rv.size())).toBe(3);
  await expect.poll(() => c.evaluate(() => window.rv.size())).toBe(3);
});

for (const scanner of [false, true]) {
  test(`two separate browser processes reconnect, ${scanner ? 'after camera permission' : 'with hidden LAN addresses'}`, async () => {
    const server = await startServer();
    const args = scanner ? ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] : [];
    const browsers = await Promise.all([chromium.launch({ args }), chromium.launch({ args })]);
    try {
      const pages = await Promise.all(
        browsers.map(async (b) => {
          const context = await b.newContext({ permissions: scanner ? ['camera'] : [] });
          const page = await context.newPage();
          await page.goto(server.url);
          return page;
        }),
      );
      await server.stop();
      const [a, b] = pages as [Page, Page];
      const keys = [await a.evaluate(() => window.rv.keys()), await b.evaluate(() => window.rv.keys())];
      const roster = keys.map((k) => k.publicKey);
      await boot(a, { keys: keys[0]!, roster, connectMs: 15_000 });
      await boot(b, { keys: keys[1]!, roster });
      if (scanner) {
        await a.evaluate(() => window.rv.camera());
        await b.evaluate(() => window.rv.camera());
      }
      await a.evaluate(() => window.rv.emit(12, 'a'));
      const { offer, reply, done } = await reconnect(a, b);
      console.log('separate', scanner, JSON.stringify({ offer: offer.bytes, reply: reply.bytes, frames: [offer.frames, reply.frames], done: { ...done, limits: undefined } }));
      console.log('candidates', JSON.stringify(await a.evaluate(() => window.rv.candidates())));
      expect(done).toMatchObject({ ok: true });
      await expect.poll(() => b.evaluate(() => window.rv.size())).toBe(12);
    } finally {
      await Promise.all(browsers.map((b) => b.close()));
    }
  });
}
