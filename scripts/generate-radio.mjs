// Generates the radio clips into apps/web/public/radio and writes manifest.json.
// Usage: node scripts/generate-radio.mjs [--relay http://localhost:8787] [--force]
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'apps/web/public/radio');
const lines = JSON.parse(readFileSync(join(root, 'apps/web/src/sound/lines.json'), 'utf8'));
const args = process.argv.slice(2);
const force = args.includes('--force');
const relay = args.includes('--relay') ? args[args.indexOf('--relay') + 1] : null;

const env = { ...process.env };
const envFile = join(root, '.env');
if (existsSync(envFile)) {
  for (const row of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = row.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in env)) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const VOICES = {
  medics: ['EXAVITQu4vr4xnSDxMaL', 0.65, 1],
  access: ['Xb7hH8MSUJpSbSDYk0k2', 0.55, 0.97],
  facilities: ['pNInz6obpgDQGcFmaJgB', 0.6, 1],
  supply: ['onwK4e9ZLuTAKqWW03F9', 0.55, 1],
  system: ['hpp4J3VqNfWAUOO0d1Us', 0.7, 1],
};

async function viaRelay(line) {
  const res = await fetch(`${relay}/api/voice/brief`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: line.text, role: line.team }),
  });
  if (!res.ok) throw new Error(`relay ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function direct(line) {
  const key = env.ELEVENLABS_API_KEY;
  if (!key) throw new Error('ELEVENLABS_API_KEY is not set');
  const [fallback, stability, speed] = VOICES[line.team] ?? VOICES.system;
  const id = env[`ELEVENLABS_VOICE_${line.team.toUpperCase()}`] || fallback;
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${id}?output_format=mp3_44100_64`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({
      text: line.text,
      model_id: 'eleven_flash_v2_5',
      voice_settings: { stability, similarity_boost: 0.75, style: 0, speed, use_speaker_boost: true },
    }),
  });
  if (!res.ok) throw new Error(`elevenlabs ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

mkdirSync(outDir, { recursive: true });
const manifest = [];
let made = 0;
for (const line of lines) {
  const file = `${line.id}.mp3`;
  const path = join(outDir, file);
  if (force || !existsSync(path) || statSync(path).size < 1000) {
    const bytes = await (relay ? viaRelay(line) : direct(line));
    if (bytes.length < 1000) throw new Error(`${line.id}: audio too small`);
    writeFileSync(path, bytes);
    made++;
  }
  manifest.push({ id: line.id, team: line.team, text: line.text, file, bytes: statSync(path).size });
  console.log(`${line.id}  ${statSync(path).size} bytes`);
}
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({ model: 'eleven_flash_v2_5', clips: manifest }, null, 2) + '\n');
console.log(`${manifest.length} clips, ${made} generated, ${lines.reduce((n, l) => n + l.text.length, 0)} characters`);
