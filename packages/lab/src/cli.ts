import { fork } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { narrative, oneLineClaim } from './narrative.ts';
import { aggregate, headline, renderSummary, type ResultsFile } from './report.ts';
import { runScenario, runSeed, type RunRecord } from './run.ts';
import { FAMILIES, TIMING, generateScenario, type FamilyId } from './scenario.ts';
import { SYSTEMS, type SystemId } from './system.ts';

const self = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(self), '../../..');

interface Job {
  family: FamilyId;
  seed: number;
}

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function child(systems: SystemId[]): Promise<void> {
  process.on('message', async (job: Job | 'stop') => {
    if (job === 'stop') process.exit(0);
    try {
      const records = await runSeed(job.family, job.seed, systems);
      process.send?.({ ok: true, records });
    } catch (err) {
      process.send?.({ ok: false, job, error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
    }
  });
  process.send?.({ ready: true });
}

async function runAll(jobs: Job[], systems: SystemId[], workers: number): Promise<{ records: RunRecord[]; failures: string[] }> {
  const records: RunRecord[] = [];
  const failures: string[] = [];
  let next = 0;
  let done = 0;
  const started = Date.now();
  await Promise.all(
    Array.from({ length: workers }, () =>
      new Promise<void>((resolveWorker) => {
        const proc = fork(self, ['--child', '--systems', systems.join(',')], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
        const feed = () => {
          const job = jobs[next++];
          if (job) proc.send(job);
          else proc.send('stop');
        };
        proc.on('message', (m: { ready?: boolean; ok?: boolean; records?: RunRecord[]; job?: Job; error?: string }) => {
          if (!m.ready) {
            done++;
            if (m.ok && m.records) records.push(...m.records);
            else failures.push(`${m.job?.family}:${m.job?.seed}: ${m.error}`);
            if (done % 50 === 0 || done === jobs.length) {
              const elapsed = (Date.now() - started) / 1000;
              process.stderr.write(`${done}/${jobs.length} seeds, ${elapsed.toFixed(0)} s\n`);
            }
          }
          feed();
        });
        proc.on('exit', () => resolveWorker());
      }),
    ),
  );
  return { records, failures };
}

async function replay(spec: string): Promise<void> {
  const [family, seed, system] = spec.split(':') as [FamilyId, string, SystemId];
  const { trace, metrics } = await runScenario(generateScenario(family, Number(seed)), system);
  process.stdout.write(`${JSON.stringify({ metrics, trace }, null, 1)}\n`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const systems = (option(args, 'systems')?.split(',') as SystemId[] | undefined) ?? SYSTEMS;
  if (args.includes('--child')) return child(systems);

  const replayArg = option(args, 'replay');
  if (replayArg) return replay(replayArg);

  const runs = Number(option(args, 'runs') ?? 200);
  const baseSeed = Number(option(args, 'seed') ?? 1000);
  const families = (option(args, 'families')?.split(',') as FamilyId[] | undefined) ?? FAMILIES;
  const workers = Number(option(args, 'jobs') ?? Math.max(1, Math.min(6, cpus().length - 2)));
  const out = resolve(repoRoot, option(args, 'out') ?? 'docs/results');

  const jobs: Job[] = [];
  for (let i = 0; i < runs; i++) for (const family of families) jobs.push({ family, seed: baseSeed + i });

  const started = Date.now();
  const { records, failures } = await runAll(jobs, systems, workers);
  records.sort((a, b) => a.family.localeCompare(b.family) || a.seed - b.seed || a.system.localeCompare(b.system));

  const file: ResultsFile = {
    meta: {
      generatedAt: new Date().toISOString(),
      runsPerFamily: runs,
      baseSeed,
      families,
      systems,
      node: process.version,
      wallSeconds: Math.round((Date.now() - started) / 1000),
      timing: { ...TIMING },
    },
    summary: aggregate(records),
    runs: records,
  };
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'results.json'), JSON.stringify(file));
  writeFileSync(join(out, 'SUMMARY.md'), renderSummary(file, narrative(file)));
  writeFileSync(join(out, 'headline.json'), `${JSON.stringify(headline(file, oneLineClaim(file)), null, 2)}\n`);
  process.stderr.write(`${records.length} runs written to ${out}. Failed seeds: ${failures.length}\n`);
  for (const f of failures.slice(0, 10)) process.stderr.write(`${f}\n`);
  if (failures.length) process.exitCode = 1;
}

await main();
