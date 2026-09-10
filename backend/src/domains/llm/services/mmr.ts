/**
 * #1109 — Maximal Marginal Relevance: a diversity narrow applied AFTER the
 * ranking stages, so it re-orders results that are already relevant rather
 * than competing with relevance.
 *
 * WHAT THIS IS FOR, measured rather than assumed. The issue's Corrections
 * required re-checking that the change still had a target after #1104
 * (rerank) and #1106 (page-merge), and the honest answer is that **it cannot
 * improve recall** — not on the vendored corpus, and not even on a corpus
 * authored specifically to crowd results with near-duplicates:
 *
 * - Vendored corpus: near-duplicates are 1.1% of result pairs, and ZERO
 *   queries both miss at rank 5 and contain a near-duplicate pair. There is
 *   no query where evicting a redundant result frees a slot the right answer
 *   would take.
 * - Duplicative corpus (`eval/corpus-synthetic`, six copied runbooks and four
 *   annual re-issues): every diversity query STILL ranks its expected page
 *   first on both axes. Retrieval finds the authoritative page even when six
 *   near-identical pages compete for the same topic.
 *
 * What it does buy is context. On those same queries **53% of the returned
 * slots (16 of 30) are near-duplicates of a higher-ranked result** — the
 * model is handed the same runbook five times in slightly different clothing,
 * and every copy costs budget that #1106 would otherwise spend on a distinct
 * page. Corpus-wide the figure is 3.8% of slots across 16 of 158 queries.
 *
 * So this stage is a CONTEXT-BUDGET optimisation, and it should be judged on
 * redundant-slot share, not on Recall@K. It is not free even so: measured
 * live, MRR falls 0.8123 -> 0.8087 at lambda 0.7 while Recall@5 holds
 * exactly, because the narrow reorders within the returned set. Recall is the thing it must not
 * break: the fixture's `diversity-negative` queries exist because the correct
 * answer is sometimes itself a member of a duplicate family, and an
 * over-eager narrow would evict it.
 *
 * Similarity is deterministic trigram Jaccard over the retrieved text — no
 * network, no model, no ordering instability. It is the same cheap measure
 * the issue proposed, and it is computed over `contextText ?? chunkText` so
 * the comparison sees what the model will actually be shown.
 */
import type { SearchResult } from './rag-service.js';

/** Lambda: 1.0 = pure relevance (no-op), 0.0 = pure diversity. */
export const MMR_LAMBDA_DEFAULT = 0.7;

/**
 * Character trigrams of a normalised string. Lower-cased and
 * whitespace-collapsed so formatting differences between copies of the same
 * page do not read as genuine difference.
 */
export function trigrams(text: string): Set<string> {
  const normalised = ` ${text.toLowerCase().replace(/\s+/g, ' ').trim()} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= normalised.length; i += 1) out.add(normalised.slice(i, i + 3));
  return out;
}

/** Jaccard overlap of two trigram sets: |A ∩ B| / |A ∪ B|, in [0,1]. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  // Iterate the smaller set: the union is derived arithmetically, so this
  // stays O(min) rather than materialising a third set per pair.
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const g of small) if (large.has(g)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** The text MMR compares — what the model will be shown, not the raw chunk. */
function comparableText(r: SearchResult): string {
  return `${r.pageTitle ?? ''} ${r.contextText ?? r.chunkText ?? ''}`;
}

/**
 * Greedy MMR selection. Returns `k` results in selection order.
 *
 * The first pick is always the top-ranked result, so **the head is never
 * diversified away** — whatever the ranking stages decided is the best answer
 * stays the best answer. Each subsequent pick maximises
 * `λ·relevance − (1−λ)·maxSimilarityToAlreadySelected`, where relevance is
 * the candidate's position in the incoming order rather than any raw score:
 * the scores reaching this stage carry three different units (#1117), so
 * comparing them numerically would be meaningless. Position is the one
 * comparable signal every producer agrees on.
 */
export function selectDiverse(
  results: readonly SearchResult[],
  opts: { lambda?: number; k: number },
): SearchResult[] {
  const lambda = opts.lambda ?? MMR_LAMBDA_DEFAULT;
  const k = Math.max(0, opts.k);
  if (k === 0) return [];
  if (results.length <= 1 || results.length <= k) return [...results];

  // Rank-derived relevance in [0,1], highest for the incoming leader. Using
  // position keeps this stage unit-free and stable across producers.
  const relevance = results.map((_, i) => 1 - i / results.length);
  const grams = results.map((r) => trigrams(comparableText(r)));

  const selected: number[] = [0];
  const remaining = new Set(results.map((_, i) => i));
  remaining.delete(0);

  while (selected.length < k && remaining.size > 0) {
    let bestIndex = -1;
    let bestScore = -Infinity;
    for (const i of remaining) {
      let maxSim = 0;
      for (const s of selected) {
        const sim = jaccard(grams[i]!, grams[s]!);
        if (sim > maxSim) maxSim = sim;
      }
      const score = lambda * relevance[i]! - (1 - lambda) * maxSim;
      // Ties break toward the better-ranked candidate: `remaining` iterates in
      // insertion order, so a strict `>` keeps the earlier one.
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    if (bestIndex === -1) break;
    selected.push(bestIndex);
    remaining.delete(bestIndex);
  }

  return selected.map((i) => results[i]!);
}
