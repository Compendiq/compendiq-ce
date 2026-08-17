/**
 * pgvector's index tiers, in one place (#1115).
 *
 * The rule is fixed by pgvector 0.8's HNSW limits, not by us:
 *
 *   ≤ 2000 dims  `vector(n)`  + HNSW `vector_cosine_ops`   — full float32
 *   ≤ 4000 dims  `halfvec(n)` + HNSW `halfvec_cosine_ops`  — float16, ~50% smaller
 *   > 4000 dims  `vector(n)`  + NO INDEX                    — correct, sequentially scanned
 *
 * It had three identical statements of that rule before this module existed —
 * `shadow-migration-service.ts`, `embedding-service.ts`'s destructive
 * `enqueueReembedAll` path and `eval/seed.ts` — and #1115's image index would
 * have been a fourth. They are now callers. A private copy is how the rule
 * drifts, and it drifts quietly: a `halfvec` column indexed with
 * `vector_cosine_ops` fails loudly at build time, but an index that is simply
 * never created shows up only as query latency on a large corpus.
 *
 * The unindexed tier is NAMED rather than implied by `opclass: null`, because
 * every caller owes the operator a warning in that case and "the opclass was
 * null" is not a thing to put in a log line or a settings panel.
 */

/** Which of the three tiers a width lands in. Mirrors `VectorIndexTierSchema`. */
export type VectorColumnTier = 'vector' | 'halfvec' | 'unindexed';

export interface VectorColumnPlan {
  /** The pgvector column type, ready to interpolate: `vector(2048)`. */
  columnType: string;
  /** HNSW opclass, or null when the width is above every indexable tier. */
  opclass: string | null;
  tier: VectorColumnTier;
}

/**
 * HNSW build parameters, matching migrations 011 and 048. Shared so a retune
 * cannot land on one index and miss another.
 */
export const HNSW_PARAMS = 'WITH (m = 16, ef_construction = 200)';

/** Largest width pgvector will build an HNSW index over `vector` for. */
export const HNSW_VECTOR_MAX_DIMS = 2000;
/** Largest width pgvector will build an HNSW index over `halfvec` for. */
export const HNSW_HALFVEC_MAX_DIMS = 4000;
/** pgvector's own ceiling on a declared column width. */
export const VECTOR_MAX_DIMS = 16_000;

/**
 * Plan the column type and index opclass for `dimensions`.
 *
 * Throws on anything that is not a plausible pgvector width. That guard is not
 * defensive decoration: pgvector type arguments cannot be bound as parameters,
 * so every caller interpolates `columnType` straight into DDL, and this is the
 * single point where a hostile or merely wrong number is stopped.
 */
export function columnTypeFor(dimensions: number): VectorColumnPlan {
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > VECTOR_MAX_DIMS) {
    throw new Error(
      `Refusing a non-integer or out-of-range vector dimension: ${dimensions} (expected 1..${VECTOR_MAX_DIMS})`,
    );
  }
  if (dimensions <= HNSW_VECTOR_MAX_DIMS) {
    return { columnType: `vector(${dimensions})`, opclass: 'vector_cosine_ops', tier: 'vector' };
  }
  if (dimensions <= HNSW_HALFVEC_MAX_DIMS) {
    return { columnType: `halfvec(${dimensions})`, opclass: 'halfvec_cosine_ops', tier: 'halfvec' };
  }
  return { columnType: `vector(${dimensions})`, opclass: null, tier: 'unindexed' };
}
