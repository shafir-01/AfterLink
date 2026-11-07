import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');
const base = process.env.BASE ?? 'http://127.0.0.1:5290';
const shots = resolve(root, '_internal/shots/a11y');
const axeSrc = readFileSync(resolve(root, 'node_modules/axe-core/axe.min.js'), 'utf8');
const res = { steps: [], announcements: [], axe: [], reduced: {}, focusLost: [] };

const browser = await chromium.launch();

async function story(scheme, reduced) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: scheme, reducedMotion: reduced });
  const page = await ctx.newPage();
  await page.goto(base + '/');
  await page.waitForTimeout(3000);
  await page.addInitScript(() => {});
  const watch = (f) => f.evaluate(() => {
    if (window.__w) return;
    window.__w = [];
    const sel = '[aria-live],[role=status],[role=alert]';
    const grab = (n) => {
      const el = (n.nodeType === 1 ? n : n.parentElement)?.closest?.(sel);
      if (el) window.__w.push({ t: Math.round(performance.now()), text: (el.textContent || '').trim().slice(0, 90), role: el.getAttribute('role') });
    };
    new MutationObserver((ms) => ms.forEach((m) => { grab(m.target); m.addedNodes.forEach(grab); })).observe(document.body, { subtree: true, childList: true, characterData: true });
  }).catch(() => {});
  const watchAll = async () => { for (const f of page.frames()) await watch(f); };
  await watchAll();

  const names = [];
  for (let step = 0; step < 9; step++) {
    const primary = page.locator('.st-primary');
    if (!(await primary.count())) { names.push('left stage: ' + page.url()); break; }
    const label = (await primary.textContent())?.trim();
    const disabled = await primary.isDisabled();
    names.push(label + (disabled ? ' (disabled)' : ''));
    if (disabled) { await page.waitForTimeout(3000); continue; }
    await primary.focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(3500);
    const active = await page.evaluate(() => document.activeElement?.className || document.activeElement?.tagName);
    if (!/st-primary/.test(active)) res.focusLost.push(`${scheme}/${reduced} after "${label}": focus on ${active}`);
    await watchAll();
    if (scheme === 'light' && reduced === 'no-preference') await page.screenshot({ path: `${shots}/story-step${step}-light.png` });
    if (scheme === 'dark' && reduced === 'no-preference') await page.screenshot({ path: `${shots}/story-step${step}-dark.png` });
    for (const f of page.frames()) {
      try {
        await f.evaluate(axeSrc);
        const r = await f.evaluate(() => axe.run(document, { runOnly: ['wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'] }));
        for (const v of r.violations) res.axe.push(`${scheme} step${step} ${f === page.mainFrame() ? 'main' : f.url().slice(-22)} ${v.id} (${v.impact}) x${v.nodes.length}: ${v.nodes[0].target.join(' ')} ${v.nodes[0].any[0]?.message?.slice(0, 120) ?? ''}`);
      } catch {}
    }
  }
  res.steps.push({ scheme, reduced, primaries: names });
  for (const f of page.frames()) {
    const w = await f.evaluate(() => window.__w || []).catch(() => []);
    for (const a of w) res.announcements.push(`${scheme}/${reduced} ${f === page.mainFrame() ? 'main' : f.url().slice(-18)} ${a.role ?? ''} "${a.text}"`);
  }
  if (reduced === 'reduce') {
    let running = 0;
    const set = new Set();
    for (const f of page.frames()) {
      const r = await f.evaluate(() => document.getAnimations().map((x) => (x.transitionProperty || x.animationName || '') + ':' + (x.effect?.target?.className || x.effect?.target?.tagName))).catch(() => []);
      running += r.length;
      r.forEach((x) => set.add(x));
    }
    res.reduced = { running, sample: [...set].slice(0, 8) };
  }
  await ctx.close();
}

await story('light', 'no-preference');
await story('dark', 'no-preference');
await story('light', 'reduce');
await browser.close();
const uniq = [...new Set(res.announcements)];
res.announcements = uniq;
res.axe = [...new Set(res.axe)];
writeFileSync(resolve(here, 'last-story.json'), JSON.stringify(res, null, 1));
console.log(JSON.stringify(res, null, 1));
