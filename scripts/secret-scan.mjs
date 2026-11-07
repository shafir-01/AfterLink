import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = process.cwd()
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', 'test-results', 'playwright-report', '.vercel', '_internal'])
const SKIP_EXT = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|pdf|zip|mp3|mp4|wasm|lock)$/i
const patterns = [
  ['Anthropic key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI-style key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/],
  ['ElevenLabs key', /\bsk_[a-f0-9]{40,}\b/],
  ['GitHub token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|github_pat_[A-Za-z0-9_]{50,}/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['Vercel token', /\bvercel_[A-Za-z0-9]{24,}/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/],
  ['Private key block', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/],
  ['Assigned secret', /\b(?:ANTHROPIC_API_KEY|ELEVENLABS_API_KEY|N8N_API_KEY|AFTERLINK_ADMIN_TOKEN|[A-Z_]*(?:SECRET|PASSWORD|TOKEN))\s*[:=]\s*["']?[A-Za-z0-9_\-./+=]{16,}["']?/],
]

function tracked() {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 })
    return out.split('\0').filter(Boolean)
  } catch {
    const files = []
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        if (SKIP_DIRS.has(name)) continue
        const p = join(dir, name)
        statSync(p).isDirectory() ? walk(p) : files.push(relative(root, p))
      }
    }
    walk(root)
    return files
  }
}

const hits = []
for (const file of tracked()) {
  const norm = file.replace(/\\/g, '/')
  if (SKIP_EXT.test(norm) || norm.split('/').some((s) => SKIP_DIRS.has(s))) continue
  if (/(^|\/)\.env(\.|$)/.test(norm) && !norm.endsWith('.env.example')) {
    hits.push(`${norm}: env file is tracked`)
    continue
  }
  let text
  try { text = readFileSync(join(root, file), 'utf8') } catch { continue }
  if (text.includes('\0')) continue
  text.split(/\r?\n/).forEach((line, i) => {
    for (const [label, re] of patterns) {
      if (re.test(line)) hits.push(`${norm}:${i + 1}: ${label}`)
    }
  })
}

if (hits.length) {
  console.error(`secret-scan: ${hits.length} finding(s)`)
  for (const h of hits) console.error('  ' + h)
  process.exit(1)
}
console.log('secret-scan: clean')
