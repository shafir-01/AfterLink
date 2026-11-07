import { afterEach, describe, expect, it } from 'vitest';
import { Fleet } from './fleet.ts';
import { knowledgeState } from '@afterlink/planner';
import { leadReport } from '../../packages/planner/src/knowledge.ts';
import type { MissionCapsule, Observation } from '@afterlink/protocol';

const HOUR = 3_600_000;
let fleet: Fleet;
afterEach(() => fleet?.stop());

const tight = (base: (i: { publicKey: string; secretKey: string }) => MissionCapsule) => (i: { publicKey: string; secretKey: string }) => {
  const c = base(i);
  return { ...c, fallback: { ...c.fallback, coverAfterMs: 5000, coverMaxPriority: 2 } };
};

async function coverScenario(skew: Partial<Record<string, (t: number) => number>>) {
  const { festivalCapsule } = await import('@afterlink/mission');
  const f = await Fleet.start({ capsule: tight((i) => festivalCapsule(i, { now: 1_700_000_000_000 })), now: skew, autopilot: false });
  f.node('medics').submitTask(f.task('owned', { requires: ['haul'], priority: 1 }), { kind: 'human' });
  await f.run(3000);
  return f;
}

describe('a wall clock must not decide anything', () => {
  it('a peer whose clock runs an hour ahead can still be covered when it goes silent', async () => {
    fleet = await coverScenario({ facilities: (t) => t + HOUR, supply: (t) => t + HOUR });
    const task = fleet.state().tasks['owned']!;
    expect(task.owner).toBeTruthy();
    const owner = ['facilities', 'supply'].find((t) => fleet.id(t) === task.owner)!;
    const other = owner === 'facilities' ? 'supply' : 'facilities';
    const rest = ['medics', 'access', other];
    fleet.split([owner], rest);
    await fleet.run(20000);
    const view = fleet.node(other).view().state.tasks['owned']!;
    expect(view.coveredBy ?? []).toContain(fleet.id(other));
  });

  it('a ferry packet stamped in the future does not freeze cover for its sender', async () => {
    fleet = await coverScenario({});
    const task = fleet.state().tasks['owned']!;
    const owner = ['facilities', 'supply'].find((t) => fleet.id(t) === task.owner)!;
    const other = owner === 'facilities' ? 'supply' : 'facilities';
    fleet.split([owner], ['medics', 'access', other]);
    await fleet.run(1000);
    fleet.node(owner).observe('carried', 1);
    await fleet.run(200);
    const packet = fleet.node(owner).buildFerry();
    const forged = { ...packet, createdAt: fleet.clock.now() + 24 * HOUR };
    fleet.node(other).ingestFerry(forged);
    const heard = fleet.node(other).view().lastHeard[fleet.id(owner)]!;
    expect(heard).toBeLessThanOrEqual(fleet.clock.now());
  });

  it('a clock stepping backwards does not stop cover', async () => {
    let offset = 0;
    fleet = await coverScenario({ facilities: (t) => t + offset, supply: (t) => t + offset });
    const task = fleet.state().tasks['owned']!;
    const owner = ['facilities', 'supply'].find((t) => fleet.id(t) === task.owner)!;
    const other = owner === 'facilities' ? 'supply' : 'facilities';
    fleet.split([owner], ['medics', 'access', other]);
    offset = -HOUR;
    await fleet.run(20000);
    expect(fleet.node(other).view().state.tasks['owned']!.coveredBy ?? []).toContain(fleet.id(other));
  });
});

describe('observations with a bad clock', () => {
  const report = (value: string, observedAt: number, validForMs: number, source = 'a'): Observation => ({ key: 'gate', value, subject: 'gate', observedAt, validForMs, source });

  it('a report stamped in the future is not current knowledge', () => {
    const now = 1_000_000;
    expect(leadReport([report('closed', now + HOUR, 60_000)], now)?.value).not.toBe(undefined);
    expect(knowledgeState(report('closed', now + HOUR, 60_000), now, [])).toBe('pending');
  });

  it('a report stamped in the future cannot shadow a later true report', () => {
    const now = 1_000_000;
    const list = [report('closed', now + HOUR, 0), report('open', now + 5000, 0, 'b')];
    expect(leadReport(list, now + 6000)?.value).toBe('open');
  });

  it('a report from a clock an hour behind is stale at once, never fresh forever', () => {
    const now = 1_000_000 + HOUR;
    expect(knowledgeState(report('closed', now - HOUR, 60_000), now, [])).toBe('stale');
  });
});
