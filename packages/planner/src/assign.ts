/** Dearer than any set of real pairings, so a row idles only when it has no work left to take. */
const IDLE_COST = 1e10;
const BLOCKED_COST = 1e12;

/**
 * Exact minimum-cost assignment by the Hungarian method with potentials, O(rows^2 * columns).
 * `cost[row][col]` is the price of pairing a row with a column; Infinity forbids the pair.
 * Returns the chosen column for each row, or -1 when the row stays idle. Every row owns a
 * private idle column, so the most work gets done first and cost decides the rest.
 * Costs must be integers, which keeps the result identical on every device.
 */
export function minCostAssignment(cost: readonly (readonly number[])[]): number[] {
  const rows = cost.length;
  if (!rows) return [];
  const real = cost[0]!.length;
  const width = real + rows;
  const price = (row: number, col: number): number => {
    if (col >= real) return col - real === row ? IDLE_COST : BLOCKED_COST;
    const c = cost[row]![col]!;
    return c === Infinity ? BLOCKED_COST : c;
  };

  const rowPotential = new Float64Array(rows + 1);
  const colPotential = new Float64Array(width + 1);
  const rowOfCol = new Int32Array(width + 1);
  const previous = new Int32Array(width + 1);
  const slack = new Float64Array(width + 1);
  const visited = new Uint8Array(width + 1);

  for (let row = 1; row <= rows; row++) {
    rowOfCol[0] = row;
    let col = 0;
    slack.fill(Infinity);
    visited.fill(0);
    do {
      visited[col] = 1;
      const from = rowOfCol[col]!;
      let delta = Infinity;
      let next = 0;
      for (let j = 1; j <= width; j++) {
        if (visited[j]) continue;
        const reduced = price(from - 1, j - 1) - rowPotential[from]! - colPotential[j]!;
        if (reduced < slack[j]!) {
          slack[j] = reduced;
          previous[j] = col;
        }
        if (slack[j]! < delta) {
          delta = slack[j]!;
          next = j;
        }
      }
      for (let j = 0; j <= width; j++) {
        if (visited[j]) {
          rowPotential[rowOfCol[j]!]! += delta;
          colPotential[j]! -= delta;
        } else {
          slack[j]! -= delta;
        }
      }
      col = next;
    } while (rowOfCol[col] !== 0);
    do {
      const prior = previous[col]!;
      rowOfCol[col] = rowOfCol[prior]!;
      col = prior;
    } while (col !== 0);
  }

  const picks = new Array<number>(rows).fill(-1);
  for (let j = 1; j <= real; j++) {
    const row = rowOfCol[j]!;
    if (row && price(row - 1, j - 1) < BLOCKED_COST) picks[row - 1] = j - 1;
  }
  return picks;
}
