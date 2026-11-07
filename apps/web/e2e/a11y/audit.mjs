import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');
const base = process.env.BASE ?? 'http://127.0.0.1:5290';
const shots = resolve(root, '_internal/shots/a11y');
mkdirSync(shots, { recursive: true });
const axeSrc = readFileSync(resolve(root, 'node_modules/axe-core/axe.min.js'), 'utf8');
const routes = [['stage', '/'], ['device', '/#/device'], ['debrief', '/#/debrief'], ['verify', '/#/verify'], ['compose', '/#/compose']];
const widths = [320, 390, 768, 1280, 1920];
const out = { axe: [], overflow: [], keyboard: {}, motion: {}, legibility: {}, live: {}, errors: [] };

const browser = await chromium.launch();

async function open(route, { width, height = 900, scheme = 'light', reduced = 'no-preference' }) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, reducedMotion: reduced });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => out.errors.push(`${route} pageerror ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') out.errors.push(`${route} console ${m.text().slice(0, 160)}`); });
  await page.goto(base + route);
  await page.waitForTimeout(2500);
  return { ctx, page };
}

async function runAxe(page) {
  const all = [];
  for (const f of page.frames()) {
    try {
      await f.evaluate(axeSrc);
      const r = await f.evaluate(() => axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] }));
      for (const v of r.violations) all.push({ id: v.id, impact: v.impact, frame: f === page.mainFrame() ? 'main' : f.url().slice(-30), count: v.nodes.length, nodes: v.nodes.slice(0, 4).map((n) => n.target.join(' ') + (n.any[0]?.message ? ' :: ' + n.any[0].message.slice(0, 110) : '')) });
    } catch (e) { all.push({ id: 'axe-failed', impact: 'n/a', frame: f.url(), count: 0, nodes: [String(e).slice(0, 100)] }); }
  }
  return all;
}

const overflow = (page) => page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));

for (const [name, route] of routes) {
  for (const scheme of ['light', 'dark']) {
    const { ctx, page } = await open(route, { width: 1280, scheme });
    out.axe.push({ route: name, scheme, violations: await runAxe(page) });
    await page.screenshot({ path: `${shots}/${name}-1280-${scheme}.png` });
    await ctx.close();
  }
  for (const width of widths) {
    const { ctx, page } = await open(route, { width, height: width === 1920 ? 1080 : 900 });
    await page.screenshot({ path: `${shots}/${name}-${width}.png` });
    const ov = await overflow(page);
    if (ov.sw > ov.cw + 1) out.overflow.push(`${name}@${width}: scrollWidth ${ov.sw} > ${ov.cw}`);
    await ctx.close();
  }
  {
    const { ctx, page } = await open(route, { width: 640, height: 450 });
    await page.screenshot({ path: `${shots}/${name}-zoom200.png` });
    const ov = await overflow(page);
    if (ov.sw > ov.cw + 1) out.overflow.push(`${name}@zoom200 (640x450): scrollWidth ${ov.sw} > ${ov.cw}`);
    await ctx.close();
  }
  {
    const { ctx, page } = await open(route, { width: 1280, reduced: 'reduce' });
    let running = 0;
    const names = new Set();
    for (const f of page.frames()) {
      const r = await f.evaluate(() => document.getAnimations().filter((x) => x.playState === 'running').map((x) => x.animationName || x.constructor.name)).catch(() => []);
      running += r.length;
      r.forEach((n) => names.add(n));
    }
    out.motion[name] = { running, names: [...names].slice(0, 6) };
    await ctx.close();
  }
  {
    const { ctx, page } = await open(route, { width: 1920, height: 1080 });
    const small = {};
    for (const f of page.frames()) {
      const r = await f.evaluate(() => {
        const s = {};
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = walker.nextNode())) {
          const t = n.textContent.trim();
          if (!t) continue;
          const el = n.parentElement;
          const rc = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          if (!rc.width || !rc.height || cs.visibility === 'hidden') continue;
          const px = parseFloat(cs.fontSize);
          if (px < 20) (s[px + 'px'] ??= []).push(t.slice(0, 28));
        }
        return s;
      }).catch(() => ({}));
      for (const [k, v] of Object.entries(r)) (small[k] ??= []).push(...v);
    }
    out.legibility[name] = Object.fromEntries(Object.entries(small).map(([k, v]) => [k, { count: v.length, sample: v.slice(0, 4) }]));
    await ctx.close();
  }
  {
    const { ctx, page } = await open(route, { width: 1280 });
    const seq = [];
    await page.keyboard.press('Tab');
    for (let i = 0; i < 70; i++) {
      const info = await page.evaluate(() => {
        let el = document.activeElement;
        while (el?.tagName === 'IFRAME') { try { el = el.contentDocument.activeElement; } catch { break; } }
        if (!el || el === document.body) return null;
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== 'none';
        const label = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || '').trim().replace(/\s+/g, ' ').slice(0, 30);
        return { tag: el.tagName.toLowerCase(), label, ring, size: [Math.round(r.width), Math.round(r.height)] };
      });
      seq.push(info);
      await page.keyboard.press('Tab');
    }
    const clean = seq.filter(Boolean);
    const uniq = new Set(clean.map((x) => x.tag + ':' + x.label));
    out.keyboard[name] = {
      stops: clean.length,
      unique: uniq.size,
      noRing: [...new Set(clean.filter((x) => !x.ring).map((x) => `${x.tag}:${x.label}`))].slice(0, 8),
      small: [...new Set(clean.filter((x) => x.size[0] < 24 || x.size[1] < 24).map((x) => `${x.tag}:${x.label} ${x.size}`))].slice(0, 8),
      order: [...uniq].slice(0, 25),
      unlabeled: clean.filter((x) => !x.label).length,
    };
    out.live[name] = await page.evaluate(() => [...document.querySelectorAll('[aria-live],[role=status],[role=alert],[role=log]')].map((e) => `${e.tagName.toLowerCase()}[${e.getAttribute('role') ?? ''}/${e.getAttribute('aria-live') ?? ''}] "${(e.textContent || '').trim().slice(0, 40)}"`));
    await ctx.close();
  }
}
await browser.close();
writeFileSync(resolve(here, 'last-run.json'), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
