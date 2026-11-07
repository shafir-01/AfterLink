import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Observation } from '@afterlink/protocol';
import { knowledgeState } from '../src/index.ts';
import { NOW, report, shuffled } from './world.ts';

const KEY = 'gate.north';

describe('knowledgeState', () => {
  it('holds a single in-date report as local', () => {
    const o = report(KEY, true, 'a', 1_000, 60_000);
    expect(knowledgeState(o, NOW, [])).toBe('local');
  });

  it('confirms when a second source agrees in date', () => {
    const o = report(KEY, true, 'a', 1_000, 60_000);
    expect(knowledgeState(o, NOW, [report(KEY, true, 'b', 2_000, 60_000)])).toBe('confirmed');
  });

  it('does not count one source twice', () => {
    const o = report(KEY, true, 'a', 1_000, 60_000);
    expect(knowledgeState(o, NOW, [report(KEY, true, 'a', 2_000, 60_000)])).toBe('local');
  });

  it('goes stale past its window, and a re-report from the source refreshes it', () => {
    const old = report(KEY, true, 'a', 120_000, 60_000);
    expect(knowledgeState(old, NOW, [])).toBe('stale');
    expect(knowledgeState(old, NOW, [report(KEY, true, 'a', 1_000, 60_000)])).toBe('local');
  });

  it('keeps durable facts in date however old they are', () => {
    expect(knowledgeState(report(KEY, true, 'a', 10 * 86_400_000, 0), NOW, [])).toBe('local');
  });

  it('marks a stale fact unreachable when its source cannot be asked', () => {
    const old = report(KEY, true, 'a', 120_000, 60_000);
    expect(knowledgeState(old, NOW, [], ['b'])).toBe('unreachable');
    expect(knowledgeState(old, NOW, [], ['a', 'b'])).toBe('stale');
  });

  it('leaves an in-date fact standing while its source is out of contact', () => {
    expect(knowledgeState(report(KEY, true, 'a', 1_000, 60_000), NOW, [], ['b'])).toBe('local');
    expect(knowledgeState(report(KEY, true, 'a', 1_000, 0), NOW, [], ['b'])).toBe('local');
  });

  it('is contradicted by a disagreeing source in date, whichever is newer', () => {
    const left = report(KEY, true, 'a', 5_000, 60_000);
    const right = report(KEY, false, 'b', 1_000, 60_000);
    expect(knowledgeState(left, NOW, [right])).toBe('contradicted');
    expect(knowledgeState(right, NOW, [left])).toBe('contradicted');
  });

  it('is contradicted when its own source has moved on', () => {
    const old = report(KEY, true, 'a', 5_000);
    expect(knowledgeState(old, NOW, [report(KEY, false, 'a', 1_000)])).toBe('contradicted');
  });

  it('settles once the disagreeing source comes round', () => {
    const left = report(KEY, false, 'a', 3_000);
    const others = [report(KEY, true, 'b', 5_000), report(KEY, false, 'b', 1_000)];
    expect(knowledgeState(left, NOW, others)).toBe('confirmed');
  });

  it('ignores a dissenting report that has expired', () => {
    const left = report(KEY, true, 'a', 1_000, 60_000);
    expect(knowledgeState(left, NOW, [report(KEY, false, 'b', 120_000, 60_000)])).toBe('local');
  });

  it('ignores reports on other keys', () => {
    const left = report(KEY, true, 'a', 1_000);
    expect(knowledgeState(left, NOW, [report('gate.west', false, 'b', 1_000)])).toBe('local');
  });

  it('compares structured values by content, not key order', () => {
    const left = report(KEY, { a: 1, b: [2] }, 'a', 1_000);
    expect(knowledgeState(left, NOW, [report(KEY, { b: [2], a: 1 }, 'b', 1_000)])).toBe('confirmed');
  });

  it('holds a report stamped in the future as pending, allowing for clock drift', () => {
    expect(knowledgeState(report(KEY, true, 'a', -60_000), NOW, [])).toBe('pending');
    expect(knowledgeState(report(KEY, true, 'a', -1_000), NOW, [])).toBe('local');
  });

  const anyReport: fc.Arbitrary<Observation> = fc
    .record({
      value: fc.boolean(),
      source: fc.constantFrom('a', 'b', 'c'),
      ageMs: fc.integer({ min: -5_000, max: 200_000 }),
      validForMs: fc.constantFrom(0, 60_000),
    })
    .map((r) => report(KEY, r.value, r.source, r.ageMs, r.validForMs));

  it('does not depend on the order reports arrived in', () => {
    fc.assert(
      fc.property(anyReport, fc.array(anyReport, { maxLength: 8 }), fc.integer(), (obs, others, seed) => {
        expect(knowledgeState(obs, NOW, shuffled(others, seed))).toBe(knowledgeState(obs, NOW, others));
      }),
    );
  });

  it('is unchanged by seeing the same report twice', () => {
    fc.assert(
      fc.property(anyReport, fc.array(anyReport, { maxLength: 8 }), (obs, others) => {
        expect(knowledgeState(obs, NOW, [...others, ...others, obs])).toBe(knowledgeState(obs, NOW, others));
      }),
    );
  });
});
