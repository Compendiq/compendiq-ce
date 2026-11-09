/**
 * #1825 — formatting significance lines for embedding variant comparisons.
 *
 * The compare-embedding-variants.mts script iterates canonical variant pairs,
 * but the ONLY_VARIANTS filter may exclude some variants from execution.
 * This module exports a pure function that emits significance comparisons.
 */

import type { PairedSignificance, QueryRun } from './metrics.js';

export interface ModelCfg {
  id: string;
  label: string;
  model: string;
  dimensions?: number;
  prefix: boolean;
}

/** Canonical variant pair order (V1→V2, V1→V3, V1→V4, V3→V4). */
const CANONICAL_PAIRS: Array<[string, string, string]> = [
  ['V1', 'V2', 'title prefix @500'],
  ['V1', 'V3', 'bigger chunk, no prefix'],
  ['V1', 'V4', 'both'],
  ['V3', 'V4', 'title prefix @667'],
];

/**
 * Format significance lines for embedding variant pairs.
 *
 * @param models — array of model configurations
 * @param results — keyed by "modelId/Vx" (e.g., "bge-m3/V1"), values have runs array
 * @param deps — { pairedSignificance, score } functions
 * @returns array of formatted lines, one per pair
 */
export function significanceLines(
  models: ModelCfg[],
  results: Record<string, { runs: QueryRun[] }>,
  deps: {
    pairedSignificance: (baseline: QueryRun[], candidate: QueryRun[], scoreOne: (r: QueryRun) => number) => PairedSignificance;
    score: (r: QueryRun) => number;
  },
): string[] {
  const lines: string[] = [];

  for (const model of models) {
    for (const [from, to, what] of CANONICAL_PAIRS) {
      const v = deps.pairedSignificance(
        results[`${model.id}/${from}`]!.runs,
        results[`${model.id}/${to}`]!.runs,
        deps.score,
      );

      const direction = v.significant ? v.direction.toUpperCase() : 'no credible change';
      lines.push(
        `${model.id.padEnd(5)} ${from}→${to} (${what}): ${v.wins}W/${v.losses}L · p=${v.pValue?.toFixed(4)} · ${direction}`,
      );
    }
  }

  return lines;
}
