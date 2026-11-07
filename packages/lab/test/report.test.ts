import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { aggregate, attackTable, headline, renderSummary, unfavourable, type ResultsFile } from '../src/report.ts';
import type { RunRecord } from '../src/run.ts';
import type { RunMetrics } from '../src/score.ts';
import { emptyReport } from '../src/system.ts';
import { score } from '../src/score.ts';
import { generateScenario } from '../src/scenario.ts';

const blank: RunMetrics = score({
  scenario: generateScenario('connected', 1),
  trace: [],
  report: emptyReport(),
  reconcileMs: null,
  bytesToReconcile: null,
  observerBytesToReconcile: null,
  bytesTotal: 0,
});

function run(system: RunRecord['system'], seed: number, metrics: Partial<RunMetrics>): RunRecord {
  return { family: 'hub-death', seed, system, metrics: { ...blank, ...metrics }, wallMs: 1 };
}

function file(runs: RunRecord[]): ResultsFile {
  return {
    meta: {
      generatedAt: '2026-11-07T00:00:00.000Z',
      sourceDigest: 'test',
      failedSeeds: [],
      runsPerFamily: 3,
      baseSeed: 0,
      families: ['hub-death'],
      systems: ['central', 'board', 'afterlink'],
      node: 'v0',
      wallSeconds: 1,
      timing: {},
    },
    summary: aggregate(runs),
    runs,
  };
}

const sample = [0, 1, 2].flatMap((seed) => [
  run('central', seed, { completedDuringOutage: 2 + seed, bytesTotal: 100, firstDecisionMs: null }),
  run('board', seed, { completedDuringOutage: 10 + seed, bytesTotal: 500, firstDecisionMs: 3000 }),
  run('afterlink', seed, { completedDuringOutage: 9 + seed, bytesTotal: 9000 + seed, firstDecisionMs: 3000 }),
]);

describe('aggregate', () => {
  it('computes each metric per family and system from the raw runs', () => {
    const summary = aggregate(sample);
    expect(summary['hub-death']?.central?.completedDuringOutage?.mean).toBe(3);
    expect(summary['hub-death']?.afterlink?.completedDuringOutage?.mean).toBe(10);
    expect(summary['hub-death']?.central?.firstDecisionMs).toMatchObject({ n: 0, missing: 3, mean: null });
  });
});

describe('unfavourable', () => {
  it('lists a metric where AfterLink is clearly worse', () => {
    const rows = unfavourable(aggregate(sample), ['hub-death']);
    expect(rows.some((r) => r.metric === 'bytesTotal' && r.baseline === 'central')).toBe(true);
  });

  it('stays quiet when intervals overlap', () => {
    const rows = unfavourable(aggregate(sample), ['hub-death']);
    expect(rows.some((r) => r.metric === 'completedDuringOutage' && r.baseline === 'board')).toBe(false);
  });
});

describe('outputs', () => {
  it('states no-decision runs instead of a number', () => {
    const md = renderSummary(file(sample), 'text');
    expect(md).toContain('none in 3 of 3 runs');
    expect(md).toContain('Where AfterLink lost');
  });

  it('counts attack outcomes from the raw runs', () => {
    const runs = [
      { ...run('board', 0, {}), attacks: [{ attack: 'forged-packet', outcome: 'accepted' as const }] },
      { ...run('board', 1, {}), attacks: [{ attack: 'forged-packet', outcome: 'accepted' as const }] },
    ];
    expect(attackTable(runs)['forged-packet']?.board).toEqual({ accepted: 2 });
  });
});

describe('published results', () => {
  const dir = resolve(__dirname, '../../../docs/results');
  const path = resolve(dir, 'results.json');
  it.skipIf(!existsSync(path))('every summary figure recomputes from the raw runs', () => {
    const results = JSON.parse(readFileSync(path, 'utf8')) as ResultsFile;
    expect(JSON.parse(JSON.stringify(aggregate(results.runs)))).toEqual(results.summary);
  });

  it.skipIf(!existsSync(path))('headline numbers match the raw runs', () => {
    const results = JSON.parse(readFileSync(path, 'utf8')) as ResultsFile;
    const published = JSON.parse(readFileSync(resolve(dir, 'headline.json'), 'utf8')) as ReturnType<typeof headline>;
    for (const card of published.cards) {
      for (const [system, value] of Object.entries(card.values)) {
        const raw = results.runs
          .filter((r) => r.family === card.family && r.system === system)
          .map((r) => r.metrics[card.metric])
          .filter((v): v is number => typeof v === 'number');
        if (raw.length === 0) expect(value?.mean).toBeNull();
        else expect(value?.mean).toBeCloseTo(raw.reduce((a, b) => a + b, 0) / raw.length, 9);
      }
    }
  });
});
