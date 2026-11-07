import { describe, expect, it } from 'vitest';
import { generateScenario } from '../src/scenario.ts';
import { runScenario } from '../src/run.ts';

describe('AfterLink in the lab', () => {
  it('runs the connected workload on real actors', async () => {
    const s = generateScenario('connected', 1);
    const { metrics, trace, wallMs } = await runScenario(s, 'afterlink');
    console.log(JSON.stringify(metrics), trace.length, wallMs);
    expect(metrics.tasksCompleted).toBeGreaterThan(0);
  }, 60000);
});
