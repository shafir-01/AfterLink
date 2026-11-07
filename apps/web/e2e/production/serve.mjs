/**
 * Builds the site the way the Pages workflow does and serves it the way GitHub Pages does: only under
 * /AfterLink/, static files only, 404.html with a 404 status for anything else, POST refused.
 * A second port stands in for a relay that is asleep: it accepts connections and never answers.
 */
import { spawnSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { extname, join, normalize, resolve } from 'node:path';

const port = Number(process.env.PAGES_PORT ?? 4194);
const asleepPort = Number(process.env.ASLEEP_RELAY_PORT ?? 4195);
const base = '/AfterLink/';
const dist = resolve('test-results/pages-dist');

const built = spawnSync('npx', ['vite', 'build', '--outDir', dist, '--emptyOutDir'], {
  cwd: 'apps/web',
  shell: true,
  stdio: 'inherit',
  env: { ...process.env, VITE_BASE: base, VITE_RELAY_URL: `http://127.0.0.1:${asleepPort}`, VITE_SITE_URL: `http://127.0.0.1:${port}${base}` },
});
if (built.status !== 0) process.exit(built.status ?? 1);

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
};

async function file(path) {
  try {
    const abs = join(dist, normalize(path));
    const target = (await stat(abs)).isDirectory() ? join(abs, 'index.html') : abs;
    return { body: await readFile(target), type: types[extname(target)] ?? 'application/octet-stream' };
  } catch {
    return null;
  }
}

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://pages');
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.writeHead(405).end();
  const found = pathname.startsWith(base) ? await file(pathname.slice(base.length)) : null;
  const page = found ?? (await file('404.html'));
  res.writeHead(found ? 200 : 404, { 'content-type': page.type, 'cache-control': 'no-cache' });
  res.end(page.body);
}).listen(port, '127.0.0.1');

createTcpServer(() => {}).listen(asleepPort, '127.0.0.1');
