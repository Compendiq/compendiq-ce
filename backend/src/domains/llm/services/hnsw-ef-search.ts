/**
 * The one `hnsw.ef_search` setting shared by every pgvector kNN probe.
 *
 * `ef_search` is a recall ceiling, not a hint: an HNSW scan visits at most
 * `ef_search` candidates and returns at most that many rows regardless of the
 * query's LIMIT. PostgreSQL's default is 40. Every probe in this app runs at a
 * 100 floor instead, and any probe whose own LIMIT approaches that floor
 * raises it (see `efSearchFor`).
 *
 * This lives in its own module rather than in `rag-service.ts` because
 * `embedding-service.ts` needs it too (the `page_avg_embedding` kNN behind
 * `page_relationships`) and `rag-service.ts` already imports
 * `embedding-service.ts` — importing back the other way would close an ESM
 * cycle. `rag-service.ts` re-exports `RAG_EF_SEARCH` so existing callers and
 * tests keep their import path.
 */

// Configurable ef_search: higher = better recall, slower query.
// Default 100 provides good recall/latency tradeoff for ~10K embeddings.
const parsed = parseInt(process.env.RAG_EF_SEARCH ?? '100', 10);
export const RAG_EF_SEARCH =
  Number.isFinite(parsed) && parsed > 0 && parsed <= 10000 ? parsed : 100;

/** pgvector's own upper bound on `hnsw.ef_search`. */
const HNSW_EF_SEARCH_MAX = 1000;

/**
 * The `ef_search` to run a probe that returns `k` rows at.
 *
 * Two rules, both load-bearing. (1) `RAG_EF_SEARCH` is a FLOOR — a probe never
 * runs below the configured recall setting. (2) A probe whose own LIMIT is
 * large gets 2x headroom over it, not 1x: `ef_search == k` is HNSW's worst
 * recall setting, because the graph walk has no room to explore beyond the
 * rows it must return. Clamped to pgvector's ceiling.
 *
 * Callers must pass the RAW row count the SQL asks for, not a post-filter
 * count — rows discarded after the index scan were still returned by it.
 */
export function efSearchFor(k: number): number {
  return Math.min(HNSW_EF_SEARCH_MAX, Math.max(Number(RAG_EF_SEARCH), 2 * k));
}
