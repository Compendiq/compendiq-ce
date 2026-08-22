/**
 * The one `hnsw.ef_search` resolver shared by every pgvector kNN probe.
 *
 * `ef_search` is a recall ceiling, not a hint: an HNSW scan visits at most
 * `ef_search` candidates and returns at most that many rows regardless of the
 * query's LIMIT. PostgreSQL's default is 40. Every probe in this app runs at
 * the configured FLOOR instead (`admin_settings.rag_ef_search`, default 100),
 * and any probe whose own LIMIT approaches that floor raises it.
 *
 * **One exported form for callsites: `await efSearchFor(rawRowCount)`.** A
 * fifth kNN probe needs nothing else — it reads the same knob, gets the same
 * headroom and the same ceiling, and must interpolate the result into a
 * `SET LOCAL hnsw.ef_search = …` **inside the transaction it already owns**
 * (a session-level `SET` would leak the value to every other user of that
 * pooled connection). `clampEfSearch` is the pure arithmetic behind it,
 * exported for tests and for a caller that already holds a floor.
 *
 * **Resolve it BEFORE checking a client out, not between `BEGIN` and the
 * `SET LOCAL`** (review r1). On a cache miss this issues a `SELECT` on the
 * MAIN pool; awaited inside an open transaction, a probe holding a main-pool
 * client is asking that same pool for a second connection while it holds one,
 * so under saturation it waits out `connectionTimeoutMillis` (5s), soft-fails
 * to the default floor, caches THAT for a TTL — and holds its own client for
 * the whole stall, feeding the saturation that caused it. The value is not
 * transaction-scoped, so hoisting the await changes nothing else: the
 * `SET LOCAL` still runs first inside the transaction.
 *
 * **The floor is a setting, not an environment variable (#1285).** It used to
 * be `process.env.RAG_EF_SEARCH`, read once at module load: it could not
 * change without a restart, ADR-021 forbids new env-driven retrieval config,
 * and it was invisible on the panel that owns `rag_fetch_width` — the knob it
 * is genuinely coupled to, since a fetch wider than the floor silently
 * plateaus. `getRagEfSearch` owns the whole cascade (row → the deprecated
 * `RAG_EF_SEARCH` bootstrap → 100), its 60-second cache and its soft-fail, so
 * these four probes pay no per-query round-trip and a failed read degrades the
 * tuning rather than the search.
 *
 * This lives in its own module rather than in `rag-service.ts` because
 * `embedding-service.ts` needs it too (the `page_avg_embedding` kNN behind
 * `page_relationships`) and `rag-service.ts` already imports
 * `embedding-service.ts` — importing back the other way would close an ESM
 * cycle.
 */

import { getRagEfSearch } from '../../../core/services/admin-settings-service.js';

/** pgvector's own upper bound on `hnsw.ef_search`. */
export const HNSW_EF_SEARCH_MAX = 1000;

/**
 * The `ef_search` to run a probe returning `k` rows at, given a floor.
 *
 * Two rules, both load-bearing. (1) The configured value is a FLOOR — a probe
 * never runs below the deployment's recall setting. (2) A probe whose own
 * LIMIT is large gets 2x headroom over it, not 1x: `ef_search == k` is HNSW's
 * worst recall setting, because the graph walk has no room to explore beyond
 * the rows it must return. Clamped to pgvector's ceiling.
 *
 * Callers must pass the RAW row count the SQL asks for, not a post-filter
 * count — rows discarded after the index scan were still returned by it.
 */
export function clampEfSearch(k: number, floor: number): number {
  return Math.min(HNSW_EF_SEARCH_MAX, Math.max(Number(floor), 2 * k));
}

/**
 * The callsite form: resolve the configured floor and apply
 * {@link clampEfSearch}. Await it **before** the probe checks its client out
 * (see the nested-acquire note at the top of this module), then interpolate
 * the result into a `SET LOCAL` inside the transaction.
 */
export async function efSearchFor(k: number): Promise<number> {
  return clampEfSearch(k, await getRagEfSearch());
}
