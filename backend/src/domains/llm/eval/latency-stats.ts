/**
 * The latency arithmetic every measurement in this directory reports through.
 *
 * `production-benchmark.ts` and `query-latency.ts` each carried a private,
 * byte-identical copy of these two functions, in the same directory, under a
 * comment claiming the copy is what makes two latency figures in this repo
 * mean the same thing (#1114 review r2). A duplicate is exactly what cannot
 * guarantee that: retuning the definition — nearest-rank to interpolated, two
 * decimals to three — moves one report and silently leaves the other on the
 * old one, and a reader comparing the two has no way to tell.
 */

/** Two decimals: enough to read a millisecond figure, few enough to diff. */
export function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Nearest-rank percentile: the smallest sample at or above the given fraction
 * of the sorted set, never an interpolation between two.
 *
 * A latency percentile is meant to name a request that really happened — an
 * interpolated p95 is a number no caller waited. Sorts a copy, because samples
 * arrive in completion order and the caller may still want that order.
 */
export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
}
