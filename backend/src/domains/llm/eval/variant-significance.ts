/**
 * #1825 — formatting significance lines for embedding variant comparisons.
 *
 * The compare-embedding-variants.mts script iterates canonical variant pairs,
 * but the ONLY_VARIANTS filter may exclude some variants from execution.
 * This module exports a pure function that emits significance comparisons
 * only for pairs where both variants were actually executed (both in results).
 */

import type { PairedSignificance, QueryRun } from './metrics.js';

export interface ModelCfg {
  readonly id: string;
}

/** Canonical variant pair order (V1→V2, V1→V3, V1→V4, V3→V4). */
const CANONICAL_PAIRS = [
  ['V1', 'V2', 'title prefix @500'],
  ['V1', 'V3', 'bigger chunk, no prefix'],
  ['V1', 'V4', 'both'],
  ['V3', 'V4', 'title prefix @667'],
] as const;

/**
 * Format significance lines for executed variant pairs only.
 * Emits comparisons in canonical order, skipping pairs where one or both
 * variants have no results (e.g., filtered via ONLY_VARIANTS).
 *
 * @param models — array of model configurations
 * @param results — keyed by "modelId/Vx" (e.g., "bge-m3/V1"), values have runs array
 * @param deps — { pairedSignificance, score } functions
 * @returns array of formatted lines, one per executable pair
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
      const baselineKey = `${model.id}/${from}`;
      const candidateKey = `${model.id}/${to}`;

      // Skip pair if either variant was not executed
      if (!results[baselineKey] || !results[candidateKey]) {
        continue;
      }

      const v = deps.pairedSignificance(
        results[baselineKey].runs,
        results[candidateKey].runs,
        deps.score,
      );

      const direction = v.significant ? v.direction.toUpperCase() : 'no credible change';
      lines.push(
        `${model.id.padEnd(5)} ${from}→${to} (${what}): ${v.wins}W/${v.losses}L · p=${v.pValue?.toFixed(4)} · ${direction}`,
      );
    }
  }

  if (lines.length === 0 && models.length > 0) {
    lines.push('(no comparable variant pair executed)');
  }

  return lines;
}
