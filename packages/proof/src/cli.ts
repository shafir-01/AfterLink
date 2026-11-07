import { readFileSync } from 'node:fs';
import { verifySteps, type Verdict } from './verify.ts';

const MARK = { pass: 'ok  ', fail: 'FAIL', skip: '-   ', none: '-   ' };

const [path, flag, key] = process.argv.slice(2);
if (!path || (flag !== undefined && (flag !== '--issuer' || !key))) {
  console.error('Usage: tsx packages/proof/src/cli.ts <file.afterlink> [--issuer <public key>]');
  process.exit(2);
}

const steps = verifySteps(new Uint8Array(readFileSync(path)), key ? { issuer: key } : {});
let next = steps.next();
while (!next.done) {
  const step = next.value;
  if (step.kind === 'done') console.log(`${MARK[step.check.status]} ${step.check.label}: ${step.check.detail}`);
  next = steps.next();
}

const verdict: Verdict = next.value;
console.log(`\n${verdict.plain}`);
if (verdict.failure?.event) console.log(`Event ${verdict.failure.event}`);
if (verdict.root) console.log(`\nFingerprint ${verdict.root}\n${verdict.words?.join(' ')}`);
if (verdict.issuer) console.log(`Issuer key  ${verdict.issuer}`);
process.exit(verdict.ok ? 0 : 1);
