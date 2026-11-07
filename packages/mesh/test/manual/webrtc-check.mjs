// Runs the mesh over real RTCPeerConnections in headless Chromium.
// Usage from the repo root: node packages/mesh/test/manual/webrtc-check.mjs
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));

const bundle = await build({
  entryPoints: [join(here, 'browser-check.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  write: false,
});
const script = bundle.outputFiles[0].text;

const server = createServer((req, res) => {
  if (req.url === '/check.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end(script);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><title>mesh check</title><script src="/check.js"></script>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

const browser = await chromium.launch({ headless: true });
let failed = false;
try {
  const page = await browser.newPage();
  page.on('pageerror', (error) => {
    failed = true;
    console.error('page error:', error.message);
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const results = await page.evaluate(() => window.runChecks());
  console.log(JSON.stringify({ chromium: browser.version(), ...results }, null, 2));
} catch (error) {
  failed = true;
  console.error(error.message);
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
