import { readFileSync } from 'node:fs'

const base = (process.argv[2] ?? '').replace(/\/+$/, '')
if (!/^https?:\/\//.test(base)) {
  console.error('usage: node scripts/check-live.mjs https://host [--relay https://relay-host]')
  process.exit(2)
}
const ri = process.argv.indexOf('--relay')
const relay = (ri > 0 ? process.argv[ri + 1] : base).replace(/\/+$/, '')

let failed = 0
const report = (ok, name, detail = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}
const get = async (url, ms = 70000) => {
  const t = Date.now()
  const res = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { 'cache-control': 'no-cache' } })
  return { res, ms: Date.now() - t }
}

try {
  const { res, ms } = await get(base + '/')
  const html = await res.text()
  report(res.ok && /<div id=["']root["']|<script/i.test(html), 'page loads', `${res.status} in ${ms} ms`)
  const assets = [...html.matchAll(/(?:src|href)=["']([^"']*\/assets\/[^"']+)["']/g)].map((m) => m[1])
  for (const a of assets.slice(0, 4)) {
    const r = await get(new URL(a, base + '/').href)
    report(r.res.ok, `asset ${a}`, String(r.res.status))
  }
} catch (e) {
  report(false, 'page loads', e.message)
}

try {
  const remote = await (await get(base + '/build.json')).res.json()
  let local = null
  try { local = JSON.parse(readFileSync(new URL('../apps/web/dist/build.json', import.meta.url), 'utf8')) } catch {}
  if (!remote?.hash) report(false, 'build hash', 'build.json has no hash')
  else if (!local) report(true, 'build hash', `${remote.hash} (no local build to compare)`)
  else report(local.hash === remote.hash, 'build hash', `live ${remote.hash} local ${local.hash}`)
} catch (e) {
  report(false, 'build hash', e.message)
}

for (const path of ['/health', '/api/status']) {
  try {
    const { res, ms } = await get(relay + path)
    const body = await res.text()
    let parsed = null
    try { parsed = JSON.parse(body) } catch {}
    report(res.ok && parsed !== null, `relay ${path}`, `${res.status} in ${ms} ms`)
    if (path === '/api/status' && parsed) console.log('      ' + JSON.stringify(parsed))
  } catch (e) {
    report(false, `relay ${path}`, e.message)
  }
}

if (failed) {
  console.error(`check-live: ${failed} check(s) failed`)
  process.exit(1)
}
console.log('check-live: all checks passed')
