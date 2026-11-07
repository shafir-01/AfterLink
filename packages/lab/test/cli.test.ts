import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { aggregate, type ResultsFile } from '../src/report.ts';
import { runScenario } from '../src/run.ts';
import { generateScenario } from '../src/scenario.ts';

const root = resolve(__dirname, '../../..');
const out = mkdtempSync(join(tmpdir(), 'afterlink-lab-'));

afterAll(() => rmSync(out, { recursive: true, force: true }));

describe('cli', { timeout: 120_000 }, () => {
  it('writes raw results, a summary and a headline, reproducible from any single seed', async () => {
    execFileSync(process.execPath, ['--import', 'tsx', 'packages/lab/src/cli.ts', '--runs', '2', '--seed', '50', '--families', 'hub-death,exclusive-race', '--jobs', '2', '--out', out], { cwd: root, stdio: 'pipe' });

    const results = JSON.parse(readFileSync(join(out, 'results.json'), 'utf8')) as ResultsFile;
    expect(results.runs).toHaveLength(2 * 2 * 3);
    expect(results.meta.failedSeeds).toEqual([]);
    expect(JSON.parse(JSON.stringify(aggregate(results.runs)))).toEqual(results.summary);

    const summary = readFileSync(join(out, 'SUMMARY.md'), 'utf8');
    expect(summary).toContain('Where AfterLink lost');
    expect(summary).toContain('`hub-death`');

    const headline = JSON.parse(readFileSync(join(out, 'headline.json'), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(headline)[0]).toBe('Seeded runs');
    expect(headline.source).toBe('docs/results/results.json');

    const record = results.runs.find((r) => r.family === 'exclusive-race' && r.seed === 51 && r.system === 'afterlink');
    const again = await runScenario(generateScenario('exclusive-race', 51), 'afterlink');
    expect(again.metrics).toEqual(record?.metrics);
  });
});
