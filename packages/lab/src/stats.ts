export interface Interval {
  lo: number;
  hi: number;
}

export interface MetricSummary {
  /** Runs with a defined value. Runs with no value are counted in `missing`, never as zero. */
  n: number;
  missing: number;
  mean: number | null;
  sd: number | null;
  /** 95% interval on the mean, Student t. */
  ci95: Interval | null;
  min: number | null;
  max: number | null;
  /** Runs with a non-zero value. */
  nonZeroRuns: number;
  /** Wilson 95% interval on the share of runs with a non-zero value. Stays informative when a count is zero in every run. */
  nonZeroShare95: Interval | null;
}

const T95: [number, number][] = [
  [1, 12.706], [2, 4.303], [3, 3.182], [4, 2.776], [5, 2.571], [6, 2.447], [7, 2.365], [8, 2.306], [9, 2.262],
  [10, 2.228], [15, 2.131], [20, 2.086], [30, 2.042], [40, 2.021], [60, 2.0], [120, 1.98],
];

function tCritical(df: number): number {
  for (const [d, t] of T95) if (df <= d) return t;
  return 1.96;
}

export function wilson(successes: number, n: number): Interval | null {
  if (n <= 0) return null;
  const z = 1.959964;
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { lo: successes === 0 ? 0 : centre - half, hi: successes === n ? 1 : centre + half };
}

export function summarize(values: (number | null | undefined)[]): MetricSummary {
  const xs = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const n = xs.length;
  const missing = values.length - n;
  if (n === 0) {
    return { n, missing, mean: null, sd: null, ci95: null, min: null, max: null, nonZeroRuns: 0, nonZeroShare95: null };
  }
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  const half = n > 1 ? (tCritical(n - 1) * sd) / Math.sqrt(n) : 0;
  const nonZeroRuns = xs.filter((x) => x !== 0).length;
  return {
    n,
    missing,
    mean,
    sd,
    ci95: { lo: mean - half, hi: mean + half },
    min: Math.min(...xs),
    max: Math.max(...xs),
    nonZeroRuns,
    nonZeroShare95: wilson(nonZeroRuns, n),
  };
}
