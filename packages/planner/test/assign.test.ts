import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { minCostAssignment } from '../src/index.ts';

/** Every way to give each row at most one distinct column, scored by most work done, then least cost. */
function bruteForce(cost: number[][]): { done: number; total: number } {
  const rows = cost.length;
  const columns = cost[0]?.length ?? 0;
  let best = { done: 0, total: 0 };
  const walk = (row: number, used: Set<number>, done: number, total: number): void => {
    if (row === rows) {
      if (done > best.done || (done === best.done && total < best.total)) best = { done, total };
      return;
    }
    walk(row + 1, used, done, total);
    for (let c = 0; c < columns; c++) {
      const price = cost[row]![c]!;
      if (used.has(c) || price === Infinity) continue;
      used.add(c);
      walk(row + 1, used, done + 1, total + price);
      used.delete(c);
    }
  };
  walk(0, new Set(), 0, 0);
  return best;
}

function score(cost: number[][], picks: number[]): { done: number; total: number } {
  let done = 0;
  let total = 0;
  picks.forEach((column, row) => {
    if (column < 0) return;
    done++;
    total += cost[row]![column]!;
  });
  return { done, total };
}

const matrix = fc
  .tuple(fc.integer({ min: 1, max: 5 }), fc.integer({ min: 0, max: 6 }))
  .chain(([rows, columns]) =>
    fc.array(
      fc.array(
        fc.oneof(
          { weight: 4, arbitrary: fc.integer({ min: 0, max: 5_000_000 }) },
          { weight: 4, arbitrary: fc.integer({ min: 0, max: 6 }) },
          { weight: 1, arbitrary: fc.constant(Infinity) },
        ),
        { minLength: columns, maxLength: columns },
      ),
      { minLength: rows, maxLength: rows },
    ),
  );

describe('minCostAssignment', () => {
  it('handles the empty cases', () => {
    expect(minCostAssignment([])).toEqual([]);
    expect(minCostAssignment([[], []])).toEqual([-1, -1]);
  });

  it('finds the global optimum where greedy fails', () => {
    expect(
      minCostAssignment([
        [1, 2],
        [1, 100],
      ]),
    ).toEqual([1, 0]);
  });

  it('leaves a row idle rather than give it forbidden work', () => {
    expect(minCostAssignment([[Infinity], [3]])).toEqual([-1, 0]);
  });

  it('prefers doing more work over spending less', () => {
    expect(
      minCostAssignment([
        [1, 1_000_000],
        [2, Infinity],
      ]),
    ).toEqual([1, 0]);
  });

  it('matches brute force on every small instance', () => {
    fc.assert(
      fc.property(matrix, (cost) => {
        const picks = minCostAssignment(cost);
        const taken = picks.filter((c) => c >= 0);
        expect(new Set(taken).size).toBe(taken.length);
        picks.forEach((column, row) => {
          if (column >= 0) expect(cost[row]![column]).not.toBe(Infinity);
        });
        expect(score(cost, picks)).toEqual(bruteForce(cost));
      }),
      { numRuns: 1000 },
    );
  });
});
