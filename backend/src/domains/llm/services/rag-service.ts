import { query, getVectorPool } from '../../../core/db/postgres.js';
import { resolveUsecase, resolveRerankUsecase } from './llm-provider-resolver.js';
import { generateEmbedding } from './openai-compatible-client.js';
import { rerank as rerankDocuments } from './rerank-client.js';
import { sanitizeLlmInput } from '../../../core/utils/sanitize-llm-input.js';
// Use the request-scoped memoised wrapper so a single hybrid request resolves
// the readable-space set once across vectorSearch + keywordSearch. See ADR-022.
import {
  getUserAccessibleSpacesMemoized as getUserAccessibleSpaces,
  filterAccessiblePages,
} from '../../../core/services/rbac-service.js';
import { CircuitBreakerOpenError } from '../../../core/services/circuit-breaker.js';
import { getFtsLanguage } from '../../../core/services/fts-language.js';
import { visiblePagesPredicate } from '../../../core/services/page-visibility.js';
import { isFeatureEnabled } from '../../../core/enterprise/loader.js';
import { ENTERPRISE_FEATURES } from '../../../core/enterprise/features.js';
import pgvector from 'pgvector';
import { logger } from '../../../core/utils/logger.js';
import {
  getRagFetchWidth,
  getRagRerankCandidates,
  RAG_FETCH_WIDTH_DEFAULT,
  RAG_FETCH_WIDTH_MAX,
} from '../../../core/services/admin-settings-service.js';
import { withSpan, recordHistogram } from '../../../telemetry.js';
import { MIN_EMBEDDABLE_TEXT_CHARS } from './embedding-service.js';

/**
 * Latency histogram for retrieval pipeline stages (#1117). `stage` is the one
 * attribute: 'vector_search' | 'keyword_search' | 'total' today; 'rerank'
 * joins when #1104 lands (this instrument existing first is what makes rerank
 * latency measurable before that stage ships). Per-leg stages record
 * successful runs only; 'total' records failures too — an error's latency is
 * still latency the caller waited out.
 */
export const RETRIEVAL_STAGE_DURATION_METRIC = 'compendiq.retrieval.stage.duration';

const STAGE_DURATION_OPTS = {
  unit: 'ms',
  description: 'Latency of retrieval pipeline stages (vector/keyword legs, rerank once #1104 lands, total)',
};

// Configurable ef_search: higher = better recall, slower query.
// Default 100 provides good recall/latency tradeoff for ~10K embeddings.
const parsed = parseInt(process.env.RAG_EF_SEARCH ?? '100', 10);
const RAG_EF_SEARCH = Number.isFinite(parsed) && parsed > 0 && parsed <= 10000 ? parsed : 100;

// The fetch-width knob itself (constants, clamp, 60s TTL cache, invalidation)
// lives in core/services/admin-settings-service.ts so the admin surface
// (routes/foundation — which the ESLint boundaries bar from importing this
// domain) can share one definition with retrieval. Re-exported here because
// this module is where the width is consumed and documented.
export { RAG_FETCH_WIDTH_DEFAULT, RAG_FETCH_WIDTH_MAX };

/**
 * Per-leg stage limit for one hybrid search. The width is a floor on ranking
 * headroom, never a cap on the caller: a `topK` above the configured width
 * (interactive search allows up to 20) must still be satisfiable. The EE ACL
 * post-filter keeps its 1.5x-of-topK compensation as an additional floor — it
 * may only ever ADD candidates. Its old form (`aclEnforced ? ceil(topK*1.5) :
 * default 10`) fetched 8/leg on the EE chat path vs CE's 10, a net
 * under-fetch filed as #1263.
 *
 * Two honest caveats, both deliberate:
 * - The unit is CHUNK rows on the vector leg but the caller's topK counts
 *   PAGES after dedup-by-page, so on a corpus of long multi-chunk pages a
 *   stage limit of N can still yield fewer than N distinct pages. Truly
 *   page-denominated fetching is #1106's page-merge work; the floor here
 *   makes the limit satisfiable when chunks-per-page is small, not always.
 * - The result can exceed RAG_FETCH_WIDTH_MAX: that constant caps the admin
 *   knob, while topK is the caller's own contract (Zod caps interactive
 *   search at 20; internal callers bound themselves).
 */
export function resolveStageLimit(topK: number, fetchWidth: number, aclEnforced: boolean): number {
  const base = Math.max(fetchWidth, topK);
  return aclEnforced ? Math.max(base, Math.ceil(topK * 1.5)) : base;
}

interface SearchResult {
  pageId: number;           // integer PK from pages table — used for dedup
  // NULL for locally-created (standalone) pages — they have no Confluence
  // counterpart. Consumers must navigate/cite by `pageId`, never by this (#1125).
  confluenceId: string | null;
  chunkText: string;
  pageTitle: string;
  sectionTitle: string;
  spaceKey: string | null;
  /**
   * Ranking quantity. **The unit depends on who produced it** — cosine
   * similarity from `vectorSearch`, raw `ts_rank` from `keywordSearch`, and an
   * RRF fusion score from `reciprocalRankFusion`. Use it to ORDER results.
   * Never display it, never threshold it, never compare it across producers.
   *
   * The fusion value is ~0.016 for a single rank in one leg and ~0.033 for the
   * common two-leg case, but it is **not** bounded there: the vector leg is
   * per-CHUNK, so one page occupying several of the top slots has its
   * contributions summed (that is why the best-chunk rule below exists). The
   * worst case is therefore a function of the per-stage limit — since #1103,
   * `resolveStageLimit` (fetch width, floored at topK and at 1.5x topK under
   * EE ACL). At the defaults that gives, via `rrfWorstCase` (a test pins the
   * figures rather than leaving them as prose):
   *
   * - chat path (`/llm/ask`, topK 5 → stage limit 10): at most ~0.17, which
   *   sat under ConfidenceBadge's old 0.4 cosine threshold — why reading this
   *   field as a cosine produced "Low confidence" every time (#1117 moved the
   *   badge onto `vectorScore`). **With a rerank provider ASSIGNED (#1104)
   *   the chat stage limit becomes the candidate pool (default 30), so the
   *   ceiling rises to ~0.42 — merely assigning rerank shifts this value's
   *   scale on analytics rows, reranked AND bypassed alike.**
   * - `/api/search` with `limit=20` → stage limit 20 (30 under EE ACL): up to
   *   ~0.30 / ~0.42. Do not restate the chat-path bound as a global one.
   * - an admin-raised `rag_fetch_width` raises the bound with it —
   *   `rrfWorstCase(width, true)` is the formula, and at the 200 cap it
   *   passes 1.0.
   *
   * Either way it is not a similarity — see `vectorScore`.
   */
  score: number;
  /**
   * Cosine similarity from the vector leg, or `null` when this page was found
   * only by keyword search. **This is the only score field with a stable unit**,
   * and the one a confidence display or threshold must read (#1117).
   *
   * Range is [-1,1], not [0,1]: it is `1 - (embedding <=> query)`, and pgvector's
   * cosine distance runs to 2, so a chunk pointing away from the query scores
   * negative. Normalised embeddings on real content make that rare, not
   * impossible — display sites must not assume a percentage in [0,100].
   */
  vectorScore: number | null;
  /**
   * Raw `ts_rank` from the keyword leg, or `null` when this page was found only
   * by vector search. Unbounded and corpus-dependent: comparable between rows of
   * one query, meaningless as an absolute figure.
   *
   * **Deliberately has no reader yet.** #1117's scope is to carry *both* per-leg
   * values rather than let fusion discard them, and this is the half nothing
   * consumes today: it is not exposed on the wire (only `vectorScore` is, as
   * `similarity`) and no ranking reads it. It exists so #1105's confidence
   * formula and #1106's page-merge can blend the legs without another change to
   * this shape. If those land without needing it, delete it — an unread number
   * is a maintenance cost, not an asset.
   */
  keywordRank: number | null;
  /**
   * Cross-encoder relevance in [0, 1] (#1104); null OR absent when this
   * result was never reranked — the stage is off, the pool bypassed, or this
   * row came from a non-reranked path. The confidence formula (#1105) is the
   * intended primary reader; analytics stores the returned set's max in
   * `search_analytics.rerank_score`.
   *
   * **Comparability caveat for any threshold (#1105 read this):** the value
   * is only comparable within one provider AND one normalisation regime. A
   * hosted reranker emits calibrated [0,1] (~0.9 for a strong match); a raw
   * local cross-encoder emits logits that arrive sigmoided per-set — the
   * same strong match measured live scored 0.14 after normalisation. Any
   * refuse-gate threshold must be a per-deployment tuning value, never a
   * universal constant.
   */
  rerankScore?: number | null;
}

/**
 * The rerank stage's latency budget. Reranking sits on the user-visible chat
 * path, so a slow provider must degrade to the un-reranked order rather than
 * stall the answer; on expiry the stage is BYPASSED honestly (no faked
 * score). The underlying queued request is left to settle — cancelling
 * through the queue is not worth the coupling for a bounded straggler.
 */
export const RERANK_TIMEOUT_MS = 5_000;

/**
 * Vector search: cosine similarity on page_embeddings.
 * Sets hnsw.ef_search for this transaction to improve recall.
 * Scoped to: Confluence pages in user's selected spaces + standalone articles
 * the user can access (shared, or private and owned by the user).
 *
 * Tradeoff: higher ef_search = better recall but slower query.
 * Default PostgreSQL ef_search is 40; we use 100 for better RAG recall.
 */
export async function vectorSearch(userId: string, questionEmbedding: number[], limit = RAG_FETCH_WIDTH_DEFAULT): Promise<SearchResult[]> {
  return withSpan(
    'rag.vector_search',
    async (span) => {
      const started = performance.now();
      const vecSpaces = await getUserAccessibleSpaces(userId);
      // Use the dedicated vector pool so long-running similarity queries
      // do not starve the main pool used by CRUD routes.
      const client = await getVectorPool().connect();
      try {
        await client.query('BEGIN');
        // ef_search must cover the requested LIMIT: HNSW returns at most
        // ef_search rows (verified against pgvector 0.8.5 — LIMIT 200 with
        // ef_search 100 yields 100 rows), so a #1103 fetch width above
        // RAG_EF_SEARCH would silently plateau while the keyword leg kept
        // widening. 2x, not 1x: ef_search == k is HNSW's worst recall
        // setting — the graph walk needs headroom beyond the return size.
        // Clamped to pgvector's [1, 1000] bound for future internal callers;
        // no HTTP path can exceed it today (Zod caps limit at 20, the width
        // knob at 200).
        await client.query(
          `SET LOCAL hnsw.ef_search = ${Math.min(1000, Math.max(Number(RAG_EF_SEARCH), 2 * Number(limit)))}`,
        );

        const result = await client.query<{
          page_id: number;
          confluence_id: string | null;
          chunk_text: string;
          // `space_key` is NULL for locally-created (standalone) pages, same as
          // `confluence_id` — `SearchResult.spaceKey` has always been nullable.
          metadata: { page_title: string; section_title: string; space_key: string | null };
          distance: number;
        }>(
          `SELECT cp.id AS page_id, cp.confluence_id, pe.chunk_text, pe.metadata,
                  pe.embedding <=> $2 AS distance
           FROM page_embeddings pe
           JOIN pages cp ON pe.page_id = cp.id
           WHERE ${visiblePagesPredicate(1, 4)}
           AND cp.deleted_at IS NULL
           ORDER BY pe.embedding <=> $2
           LIMIT $3`,
          [vecSpaces, pgvector.toSql(questionEmbedding), limit, userId],
        );

        await client.query('COMMIT');

        const mapped = result.rows.map((row) => ({
          pageId: row.page_id,
          confluenceId: row.confluence_id,
          chunkText: row.chunk_text,
          pageTitle: row.metadata.page_title,
          sectionTitle: row.metadata.section_title,
          spaceKey: row.metadata.space_key,
          score: 1 - row.distance, // Convert distance to similarity
          vectorScore: 1 - row.distance,
          keywordRank: null,
        }));
        span?.setAttribute('rag.hits', mapped.length);
        recordHistogram(
          RETRIEVAL_STAGE_DURATION_METRIC,
          performance.now() - started,
          { stage: 'vector_search' },
          STAGE_DURATION_OPTS,
        );
        return mapped;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    { 'rag.limit': limit },
  );
}

/**
 * Keyword search: PostgreSQL full-text search on pages.
 * Scoped to: Confluence pages in user's selected spaces + standalone articles
 * the user can access (shared, or private and owned by the user).
 */
export async function keywordSearch(userId: string, questionText: string, limit = RAG_FETCH_WIDTH_DEFAULT): Promise<SearchResult[]> {
  // Use plainto_tsquery which safely handles arbitrary user input
  // (no need to manually sanitize or construct tsquery syntax)
  const trimmed = questionText.trim();
  // Before the span on purpose: an empty query is not a retrieval, and a
  // 0ms sample for it would only pollute the stage histogram.
  if (!trimmed) return [];

  return withSpan(
    'rag.keyword_search',
    async (span) => {
      const started = performance.now();
      const ftsLang = await getFtsLanguage();

      const kwSpaces = await getUserAccessibleSpaces(userId);
      const result = await query<{
        page_id: number;
        confluence_id: string | null;
        title: string;
        space_key: string | null;
        body_text: string;
        rank: number;
      }>(
        `SELECT cp.id AS page_id, cp.confluence_id, cp.title, cp.space_key,
                substring(coalesce(cp.body_text, ''), 1, 500) as body_text,
                ts_rank(cp.tsv, plainto_tsquery('${ftsLang}', $2)) AS rank
         FROM pages cp
         WHERE cp.tsv @@ plainto_tsquery('${ftsLang}', $2)
           AND ${visiblePagesPredicate(1, 4)}
           AND cp.deleted_at IS NULL
         ORDER BY rank DESC
         LIMIT $3`,
        [kwSpaces, trimmed, limit, userId],
      );

      const mapped = result.rows.map((row) => ({
        pageId: row.page_id,
        confluenceId: row.confluence_id,
        chunkText: row.body_text,
        pageTitle: row.title,
        sectionTitle: row.title,
        spaceKey: row.space_key,
        score: row.rank,
        vectorScore: null,
        keywordRank: row.rank,
      }));
      span?.setAttribute('rag.hits', mapped.length);
      recordHistogram(
        RETRIEVAL_STAGE_DURATION_METRIC,
        performance.now() - started,
        { stage: 'keyword_search' },
        STAGE_DURATION_OPTS,
      );
      return mapped;
    },
    { 'rag.limit': limit },
  );
}

/**
 * Largest RRF score a single page can reach when it occupies every one of
 * `stageLimit` vector slots, optionally plus the top keyword slot.
 *
 * Exported for the test that pins `SearchResult.score`'s documented bounds. The
 * prose version of this has been wrong twice, in both directions, because the
 * per-CHUNK vector leg lets one page's contributions sum — so the numbers live
 * here where they can be asserted instead of in a comment.
 */
function rrfWorstCase(stageLimit: number, withKeywordHit = false, k = 60): number {
  let total = 0;
  for (let rank = 0; rank < stageLimit; rank++) total += 1 / (k + rank + 1);
  return withKeywordHit ? total + 1 / (k + 1) : total;
}

/**
 * Reciprocal Rank Fusion (RRF) - combines vector and keyword results.
 * RRF score = sum(1 / (k + rank_i)) for each ranking system
 */
function reciprocalRankFusion(
  vectorResults: SearchResult[],
  keywordResults: SearchResult[],
  k = 60,
): SearchResult[] {
  // The per-leg raw values are taken from WHICH ARGUMENT a result arrived in,
  // not from the fields already on it: `score` is the leg's own native unit
  // (cosine from the vector query, ts_rank from the FTS query), and reading it
  // positionally is what keeps a keyword-only hit from reporting a similarity
  // it never had (#1117).
  const scoreMap = new Map<
    string,
    { result: SearchResult; score: number; vectorScore: number | null; keywordRank: number | null }
  >();

  // Score from vector search
  vectorResults.forEach((result, rank) => {
    const key = String(result.pageId);
    const existing = scoreMap.get(key);
    const rrf = 1 / (k + rank + 1);
    if (existing) {
      existing.score += rrf;
      // Keep the result with the higher individual score (best chunk for context)
      if (result.score > existing.result.score) {
        existing.result = result;
      }
      // Report the best chunk's similarity — the same chunk the rule above
      // picks as representative, so the number describes the text that is
      // actually sent to the model.
      if (existing.vectorScore === null || result.score > existing.vectorScore) {
        existing.vectorScore = result.score;
      }
    } else {
      scoreMap.set(key, { result, score: rrf, vectorScore: result.score, keywordRank: null });
    }
  });

  // Score from keyword search
  keywordResults.forEach((result, rank) => {
    const key = String(result.pageId);
    const existing = scoreMap.get(key);
    const rrf = 1 / (k + rank + 1);
    if (existing) {
      existing.score += rrf;
      // Do NOT replace a vector chunk with a keyword body excerpt:
      // vector chunks are purpose-built for LLM context, body text is not.
      // The rank still travels, so a page found by both legs reports both.
      if (existing.keywordRank === null || result.score > existing.keywordRank) {
        existing.keywordRank = result.score;
      }
    } else {
      scoreMap.set(key, { result, score: rrf, vectorScore: null, keywordRank: result.score });
    }
  });

  // `score` stays the RRF fusion value: it is what the sort below consumes, and
  // what every caller's ordering already depends on. Only the two per-leg fields
  // are added — this function's output ORDER is unchanged.
  return Array.from(scoreMap.values())
    .sort((a, b) => b.score - a.score)
    .map((entry) => ({
      ...entry.result,
      score: entry.score,
      vectorScore: entry.vectorScore,
      keywordRank: entry.keywordRank,
    }));
}

/**
 * Fusion with a STABLE HEAD (#1103). When the stage limit exceeds the ranking
 * width — i.e. the caller's topK floored the fetch above the configured
 * width — plain RRF over the deep legs demonstrably dilutes the head: RRF's
 * k=60 is nearly flat across ranks, so a mediocre page appearing deep in BOTH
 * legs outranks a rank-1 single-leg hit. Measured at retrieval topK=20 on
 * #1102's fixture, wide fusion moved Recall@1 0.3889 → 0.2222 and MRR 0.5830
 * → 0.4566 while Recall@20 improved 0.9236 → 0.9514 — more right answers in
 * the set, drowned at the top.
 *
 * So the head takes its ORDER from fusion over the first `rankWidth` rows of
 * each leg — the same page sequence a narrower request returns — and the
 * extra candidates the deeper fetch surfaced are APPENDED, ranked by fusion
 * over the full legs. Asking for more results yields the same first results,
 * plus more; it never reorders the top. When the legs are within `rankWidth`
 * this is plain RRF.
 *
 * The head's ENTRIES, though, come from the wide fusion: the deeper fetch may
 * have retrieved better evidence for a head page (its best vector chunk at a
 * leg rank beyond `rankWidth`, say), and discarding that would hand the LLM a
 * keyword body-excerpt where a purpose-built vector chunk exists, and the
 * wire a `similarity: null` for a page the vector leg did retrieve. Order
 * from the narrow fusion, objects from the wide one.
 *
 * `rankWidth` is the configured fetch width alone — BOTH floors on the stage
 * limit (the caller's topK, and the EE ACL post-filter's 1.5x compensation)
 * are pool padding for satisfiability/filtering, never ranking decisions, so
 * the stable head applies identically in CE and under EE ACL.
 *
 * Note the array is ordered by the pipeline, not by `score`; `score` remains
 * an opaque ordering byproduct (see its JSDoc) — consumers must never re-sort
 * by it.
 */
export function fuseWithStableHead(
  vectorResults: SearchResult[],
  keywordResults: SearchResult[],
  rankWidth: number,
): SearchResult[] {
  if (vectorResults.length <= rankWidth && keywordResults.length <= rankWidth) {
    return reciprocalRankFusion(vectorResults, keywordResults);
  }
  const head = reciprocalRankFusion(
    vectorResults.slice(0, rankWidth),
    keywordResults.slice(0, rankWidth),
  );
  const wide = reciprocalRankFusion(vectorResults, keywordResults);
  // Head pages are found from prefixes of the same legs, so head ⊆ wide.
  const wideById = new Map(wide.map((r) => [r.pageId, r]));
  const headIds = new Set(head.map((r) => r.pageId));
  return [
    ...head.map((r) => wideById.get(r.pageId)!),
    ...wide.filter((r) => !headIds.has(r.pageId)),
  ];
}

/**
 * The de-facto unit tag for `search_analytics.max_score` — each value has ONE
 * documented score unit (#1117): `hybrid` and `keyword_fallback` store the RRF
 * fusion value, `semantic` the cosine, `keyword` the raw ts_rank, `faceted`
 * NULL. Future retrieval stages add members here TOGETHER with their writers
 * (reranked paths in #1104, MMR in #1109, multi-query expansion in #1112) —
 * never pass a value this union does not carry, and never repoint an existing
 * value at a different unit: rows are only comparable within one value.
 *
 * `hybrid_rerank` (#1104): a hybrid search whose candidate pool the
 * cross-encoder actually re-scored. `max_score` still stores the RRF fusion
 * value (the returned rows keep their fusion `score`); the rerank scale
 * lives in migration 088's `rerank_score` column, which this writer is the
 * first to fill. A bypassed rerank records plain `hybrid` — the type says
 * what HAPPENED, never what was merely attempted.
 */
export type SearchAnalyticsType =
  | 'hybrid'
  | 'hybrid_rerank'
  | 'keyword_fallback'
  | 'semantic'
  | 'keyword'
  | 'faceted';

/**
 * Why the vector leg under-delivered on this search. NULL on a healthy row —
 * and on every row written before migration 088, where NULL means
 * "not recorded", not "healthy".
 */
export type DegradedReason = 'no_embeddings' | 'partial_embeddings' | 'embedding_failed';

/** Observability fields added by migration 088 (#1117 stage 2). */
export interface SearchAnalyticsExtras {
  /**
   * Max rerank score of the returned set, [0,1]. Written on `hybrid_rerank`
   * rows since #1104 (hybridSearch is the writer); NULL on bypassed and
   * non-reranked rows. Its own column so rerank scores keep their own unit
   * instead of overloading `max_score`.
   */
  rerankScore?: number | null;
  degradedReason?: DegradedReason | null;
  /** Measured coverage at query time, [0,1] — recorded degraded or not. */
  embeddingCoverage?: number | null;
}

/**
 * How much of the caller-visible embeddable corpus actually has embeddings.
 *
 * Ground truth from `page_embeddings`, deliberately NOT `pages.embedding_status`
 * — a failed or interrupted run can leave the status column stale, and the
 * destructive re-embed window (TRUNCATE → gradual refill) is exactly when this
 * number must not lie. The denominator approximates what embedPage will
 * embed: non-deleted, non-folder pages with content, visible to the caller,
 * and at least MIN_EMBEDDABLE_TEXT_CHARS of extracted text. Since #1265
 * embedPage's own skip check runs on the MARKDOWN form first and falls back
 * to the text form, so the relationship is one-way by construction: every
 * page this denominator counts (text form ≥ floor) will embed, while a page
 * whose Markdown clears the floor on syntax alone (an image-only page's
 * `![alt](url)`) may embed without being counted — which cannot depress
 * coverage, since such pages join neither the numerator's filter nor the
 * denominator. Without the length filter a corpus with a few structural
 * stub pages would read "degraded" forever.
 */
export interface EmbeddingCoverage {
  embeddedPages: number;
  totalPages: number;
  /** `embeddedPages / totalPages`; 1 when there is nothing to embed. */
  coverage: number;
}

/**
 * Coverage below this fraction marks retrieval as degraded
 * (`degraded_reason = 'partial_embeddings'`). The boundary is `<`, not `<=`:
 * a few transiently-dirty pages (fresh edits awaiting the embedding worker)
 * must not raise a corpus-level alarm, while a re-embed in progress — which
 * starts from zero and climbs — must. Pinned by test; changing it is an
 * observability decision, not a tuning knob.
 */
export const DEGRADED_COVERAGE_THRESHOLD = 0.95;

export async function getEmbeddingCoverage(userId: string): Promise<EmbeddingCoverage> {
  const covSpaces = await getUserAccessibleSpaces(userId);
  const result = await query<{ embedded: number; total: number }>(
    `SELECT
       COUNT(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM page_embeddings pe WHERE pe.page_id = cp.id
       ))::int AS embedded,
       COUNT(*)::int AS total
     FROM pages cp
     WHERE ${visiblePagesPredicate(1, 2)}
       AND cp.deleted_at IS NULL
       AND COALESCE(cp.page_type, 'page') != 'folder'
       AND cp.body_html IS NOT NULL
       AND char_length(cp.body_text) >= ${Number(MIN_EMBEDDABLE_TEXT_CHARS)}`,
    [covSpaces, userId],
  );
  const embedded = result.rows[0]?.embedded ?? 0;
  const total = result.rows[0]?.total ?? 0;
  return {
    embeddedPages: embedded,
    totalPages: total,
    coverage: total === 0 ? 1 : embedded / total,
  };
}

/**
 * Derive the degraded-retrieval verdict for one search. Precedence: a failed
 * embedding call beats the coverage-derived reasons — the vector leg is
 * missing *entirely*, whatever the corpus looks like — and the measured
 * coverage still travels separately on the analytics row.
 */
export function deriveDegradedReason(
  embeddingFailed: boolean,
  coverage: EmbeddingCoverage | null,
): DegradedReason | null {
  if (embeddingFailed) return 'embedding_failed';
  if (!coverage) return null;
  if (coverage.totalPages > 0 && coverage.embeddedPages === 0) return 'no_embeddings';
  if (coverage.coverage < DEGRADED_COVERAGE_THRESHOLD) return 'partial_embeddings';
  return null;
}

/**
 * Record a search analytics event.
 */
export async function recordSearchAnalytics(
  userId: string,
  queryText: string,
  resultCount: number,
  maxScore: number | null,
  searchType: SearchAnalyticsType,
  extras: SearchAnalyticsExtras = {},
): Promise<void> {
  try {
    await query(
      `INSERT INTO search_analytics
         (user_id, query, result_count, max_score, search_type,
          rerank_score, degraded_reason, embedding_coverage)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        userId,
        queryText,
        resultCount,
        maxScore,
        searchType,
        extras.rerankScore ?? null,
        extras.degradedReason ?? null,
        extras.embeddingCoverage ?? null,
      ],
    );
  } catch (err) {
    // Never let analytics tracking break the search flow
    logger.error({ err }, 'Failed to record search analytics');
  }
}

// In-flight fire-and-forget analytics writes. recordSearchAnalytics is invoked
// WITHOUT await from the search path so it never adds latency to a user search —
// but the INSERT can still be running after the caller returns. Track the
// promises so callers that need a quiet point (graceful shutdown; DB reset in
// integration tests) can drain them; otherwise a late INSERT (RowShareLock for
// the users FK) deadlocks a concurrent TRUNCATE (AccessExclusiveLock). See #805.
const inFlightAnalytics = new Set<Promise<void>>();

/** Fire-and-forget a search-analytics write while tracking it for {@link flushSearchAnalytics}. */
export function trackSearchAnalytics(
  userId: string,
  queryText: string,
  resultCount: number,
  maxScore: number | null,
  searchType: SearchAnalyticsType,
  extras: SearchAnalyticsExtras = {},
): void {
  const p = recordSearchAnalytics(userId, queryText, resultCount, maxScore, searchType, extras)
    .catch(() => {})
    .finally(() => {
      inFlightAnalytics.delete(p);
    });
  inFlightAnalytics.add(p);
}

/**
 * Await all in-flight fire-and-forget search-analytics writes. Use before
 * resetting/tearing down the database (integration tests) and during graceful
 * shutdown, so a late INSERT never races a TRUNCATE. See #805.
 */
export async function flushSearchAnalytics(): Promise<void> {
  await Promise.allSettled([...inFlightAnalytics]);
}

/**
 * Hybrid RAG search: combines vector search + keyword search using RRF.
 * Returns top results with source metadata for citations.
 * Scoped to: Confluence pages in user's selected spaces + accessible standalone articles.
 */
/**
 * Per-call options. `rerank: true` REQUESTS the #1104 rerank stage — it runs
 * only when an admin has assigned a provider+model to the `rerank` use case
 * (resolveRerankUsecase returns null otherwise, and the request is a no-op).
 * The chat path requests it; `/api/search` deliberately does not — its
 * results paginate, and reranking page 2 independently of page 1 breaks the
 * global ordering the pages share.
 */
export interface HybridSearchOptions {
  rerank?: boolean;
}

export async function hybridSearch(
  userId: string,
  question: string,
  topK = 5,
  precomputedCoverage?: EmbeddingCoverage | null,
  opts?: HybridSearchOptions,
): Promise<SearchResult[]> {
  return withSpan(
    'rag.hybrid_search',
    async (span) => {
      const started = performance.now();
      try {
        return await hybridSearchInner(userId, question, topK, span, precomputedCoverage, opts);
      } finally {
        // 'total' records failed retrievals too — an error's latency is still
        // latency the caller waited out. The per-leg stages record successful
        // runs only (see RETRIEVAL_STAGE_DURATION_METRIC).
        recordHistogram(
          RETRIEVAL_STAGE_DURATION_METRIC,
          performance.now() - started,
          { stage: 'total' },
          STAGE_DURATION_OPTS,
        );
      }
    },
    { 'rag.top_k': topK },
  );
}

async function hybridSearchInner(
  userId: string,
  question: string,
  topK: number,
  span?: import('@opentelemetry/api').Span,
  precomputedCoverage?: EmbeddingCoverage | null,
  opts?: HybridSearchOptions,
): Promise<SearchResult[]> {
  logger.info({ userId, question: question.slice(0, 100) }, 'Running hybrid RAG search');

  // Per-page ACL post-filter (EE `rag_permission_enforcement` flag): when
  // Confluence page-level restrictions have been mirrored to
  // `access_control_entries` by the sync service (issue #112, Phase C), the
  // RAG hybrid retrieval must gate candidates through `userCanAccessPage`
  // before returning them. Resolve the flag once up front so both the
  // overfetch-compensation call below and the post-filter at the bottom of
  // this function see a consistent value for this request.
  const aclEnforced = isFeatureEnabled(ENTERPRISE_FEATURES.RAG_PERMISSION_ENFORCEMENT);

  // Decouple fetch width from return width (#1103): both legs pull the
  // configured candidate budget (`rag_fetch_width` in admin_settings;
  // default 10 — deliberately the legacy per-leg limit, see
  // RAG_FETCH_WIDTH_DEFAULT for the measured regression a wide fetch causes
  // without a reranker), then the pipeline slices to `topK` after ranking.
  // The EE ACL post-filter's 1.5x compensation survives as an additional
  // floor inside resolveStageLimit — headroom only ever adds (#1263).
  // The width read is TTL-cached (admin-settings-service), so this is a DB
  // round-trip at most once a minute — and it is chained, not awaited, so the
  // cache-miss case overlaps the embedding call and the coverage probe below
  // instead of serialising in front of them.
  const fetchWidthPromise = getRagFetchWidth();
  // Rerank stage inputs (#1104), resolved in parallel with everything else.
  // The stage only exists when the caller REQUESTED it and an admin has
  // ASSIGNED a rerank provider — either absence resolves to null and the
  // pipeline below is byte-identical to the non-reranked path.
  const rerankCfgPromise = opts?.rerank
    ? resolveRerankUsecase().catch((err) => {
        logger.warn({ err }, 'rerank use-case resolution failed — stage disabled for this request');
        return null;
      })
    : Promise.resolve(null);
  const rerankCandidatesPromise = opts?.rerank ? getRagRerankCandidates() : Promise.resolve(0);
  // With an active rerank stage the legs widen to the candidate pool — this
  // is the deliberate spend of #1103's over-fetch headroom, paired with the
  // stage that consumes it (plain-RRF wide fetch measured as a regression).
  const stageLimitPromise = Promise.all([
    fetchWidthPromise,
    rerankCfgPromise,
    rerankCandidatesPromise,
  ]).then(([fetchWidth, rerankCfg, rerankCandidates]) =>
    resolveStageLimit(topK, rerankCfg ? Math.max(fetchWidth, rerankCandidates) : fetchWidth, aclEnforced),
  );

  let vectorResults: SearchResult[] = [];
  let embeddingFailed = false;

  // Start keyword search outside the try block so DB errors in keyword
  // search are not silently caught as "embedding failures".
  const keywordPromise = stageLimitPromise.then((stageLimit) =>
    keywordSearch(userId, question, stageLimit),
  );
  // Observe the promise so a rejection can never go unhandled if the embedding
  // path short-circuits (e.g. rethrowing CircuitBreakerOpenError) before the
  // `await keywordPromise` below runs. This no-op observer does not consume the
  // result — the await at the end still throws/propagates in the normal path.
  keywordPromise.catch(() => {});

  // Coverage probe for the degraded-retrieval signal (#1117), in parallel with
  // both legs. Best-effort: a probe failure degrades the *signal* to
  // "unmeasured" (null), never the search itself. `/api/search` hands its own
  // reading over (`null` = its probe already failed — don't retry) so a hybrid
  // request never counts twice; `undefined` (the chat path) means self-probe.
  const coveragePromise: Promise<EmbeddingCoverage | null> =
    precomputedCoverage !== undefined
      ? Promise.resolve(precomputedCoverage)
      : getEmbeddingCoverage(userId).catch((err) => {
          logger.warn({ err }, 'Embedding-coverage probe failed');
          return null;
        });

  try {
    // Resolve the `embedding` use-case to the provider+model that generated
    // the stored embeddings, so query-time embedding stays compatible.
    const { config, model } = await resolveUsecase('embedding');
    const embeddings = await generateEmbedding(config, model, question);
    const questionEmbedding = embeddings[0]!;
    vectorResults = await vectorSearch(userId, questionEmbedding, await stageLimitPromise);
  } catch (err) {
    // Let circuit breaker errors propagate for proper 503 handling
    if (err instanceof CircuitBreakerOpenError) {
      throw err;
    }
    embeddingFailed = true;
    logger.warn({ err }, 'Embedding failed, falling back to keyword-only');
  }

  const keywordResults = await keywordPromise;
  const coverage = await coveragePromise;
  const degradedReason = deriveDegradedReason(embeddingFailed, coverage);
  const analyticsExtras: SearchAnalyticsExtras = {
    degradedReason,
    embeddingCoverage: coverage?.coverage ?? null,
  };
  // Distinguish keyword-fallback (vector leg contributed nothing) from true
  // hybrid; `degraded_reason` in the extras records WHY (#1117). Derived once
  // so the two ACL branches below can never disagree.
  const searchType: SearchAnalyticsType =
    vectorResults.length === 0 && keywordResults.length > 0 ? 'keyword_fallback' : 'hybrid';

  span?.setAttribute('rag.vector_hits', vectorResults.length);
  span?.setAttribute('rag.keyword_hits', keywordResults.length);
  span?.setAttribute('rag.search_type', searchType);
  // The one retrieval input that varies at runtime (admin knob + floors) —
  // without it, traces cannot be partitioned by width after a tuning change.
  span?.setAttribute('rag.stage_limit', await stageLimitPromise);
  if (coverage) {
    span?.setAttribute('rag.embedding_coverage', coverage.coverage);
  }
  // Absence is the healthy signal — no attribute rather than a null-ish value.
  if (degradedReason) {
    span?.setAttribute('rag.degraded_reason', degradedReason);
  }

  logger.debug({
    vectorHits: vectorResults.length,
    keywordHits: keywordResults.length,
  }, 'Search results');

  // Rank width = the configured width alone. Both floors on the stage limit
  // — the caller's topK and the EE ACL 1.5x compensation — are pool padding
  // for satisfiability/filtering; they must widen the POOL, never re-rank
  // the HEAD (see fuseWithStableHead). This deliberately CHANGES pre-#1103
  // EE ordering at topK >= 7, which fused over the full 1.5x pool: that was
  // the same head dilution measured on CE, worst exactly where the pool was
  // widest, and the stable head now applies identically in both editions.
  const merged = fuseWithStableHead(vectorResults, keywordResults, await fetchWidthPromise);

  // Per-page ACL post-filter: when enabled, drop candidates the caller can
  // no longer read (Confluence restriction added between sync and query,
  // ACE synced for a page whose space the user lost access to, etc.). The
  // filter preserves RRF rank order.
  // Since #1104 it is ONE set-based query (filterAccessiblePages) over the
  // whole merged set — no early stop, no per-candidate round-trips; do not
  // re-add a topK stop here, it would starve the rerank pool the stage
  // below slices from.
  const rerankCfg = await rerankCfgPromise;

  let candidates: SearchResult[];
  if (aclEnforced) {
    // Per-page ACL post-filter, batched into ONE set-based query (#1104 —
    // the "required work for the PR that actually raises the width" from
    // ADR-023's amendment). filterAccessiblePages is spec-matched to
    // userCanAccessPage; order is preserved because the merged array is
    // filtered in place against the returned set. `candidatesKept` is the
    // TRUE accessible count again — the early-stop that saturated it at
    // topK went with the sequential walk.
    const accessible = await filterAccessiblePages(
      userId,
      merged.map((r) => r.pageId),
    );
    candidates = merged.filter((r) => accessible.has(r.pageId));
    logger.debug(
      {
        userId,
        candidatesBeforeFilter: merged.length,
        candidatesKept: candidates.length,
      },
      'RAG per-page ACL post-filter applied',
    );
  } else {
    candidates = merged;
  }

  // ── Rerank stage (#1104) ───────────────────────────────────────────────
  // Runs only for a true hybrid result (a keyword-fallback set is already a
  // degraded state whose analytics value IS the degradation — rescoring it
  // would relabel the row and hide that). Bypass is HONEST: any failure or
  // timeout keeps the fused order and records plain 'hybrid' — no faked
  // scores, no renormalisation of partial results.
  let searchTypeFinal: SearchAnalyticsType = searchType;
  let rerankMax: number | null = null;
  let topResults: SearchResult[];
  if (rerankCfg && searchType === 'hybrid' && candidates.length > 1) {
    const poolTarget = Math.max(await rerankCandidatesPromise, Math.max(0, topK));
    const pool = candidates.slice(0, poolTarget);
    const rerankStarted = performance.now();
    try {
      // KB chunk text goes to the assigned rerank provider — same
      // prompt-injection guard the chat context gets (issue #1104's PII
      // note; the ADR-021 amendment records the egress decision).
      const docs = pool.map((r) => sanitizeLlmInput(r.chunkText).sanitized);
      const queryText = sanitizeLlmInput(question).sanitized;
      // The budget is enforced INSIDE the client via an AbortSignal that
      // spans queue wait + request (#1267 review B3): a raced-and-abandoned
      // promise held a global LLM_CONCURRENCY slot for up to the queue's own
      // 300s timeout, and repeated timeouts never taught the breaker
      // anything. An abort releases the slot immediately and counts as a
      // breaker failure — a persistently slow reranker now trips the breaker
      // and the stage self-disables for the cool-down instead of billing
      // full cost for bypassed results.
      const scored = await rerankDocuments(rerankCfg.config, rerankCfg.model, queryText, docs, {
        timeoutMs: RERANK_TIMEOUT_MS,
      });
      // An empty scored set means the provider answered 200 with nothing this
      // client could use (unrecognised keys, out-of-range indices, an empty
      // results array). That is a NON-FUNCTIONING stage, not a successful
      // rescore — falling through would label the untouched fused order
      // 'hybrid_rerank' and make a dead provider indistinguishable from a
      // working one in every signal (#1267 verification, 1).
      if (scored.length === 0) {
        throw new Error('rerank returned no scoreable results — provider answered but nothing mapped');
      }
      // Rebuild the pool in relevance order; anything the provider did not
      // score keeps its fused position after the scored entries.
      const byIndex = new Map(scored.map((s) => [s.index, s.relevanceScore]));
      const scoredEntries = scored.map((s) => ({ ...pool[s.index]!, rerankScore: s.relevanceScore }));
      const unscored = pool.filter((_, i) => !byIndex.has(i));
      topResults = [...scoredEntries, ...unscored].slice(0, Math.max(0, topK));
      rerankMax = topResults.reduce<number | null>(
        (max, r) => (r.rerankScore != null && (max === null || r.rerankScore > max) ? r.rerankScore : max),
        null,
      );
      searchTypeFinal = 'hybrid_rerank';
      // Overwrite the pre-stage value so trace and analytics agree (#1267 m4).
      span?.setAttribute('rag.search_type', searchTypeFinal);
      span?.setAttribute('rag.rerank', 'scored');
      span?.setAttribute('rag.rerank_pool', pool.length);
      recordHistogram(
        RETRIEVAL_STAGE_DURATION_METRIC,
        performance.now() - rerankStarted,
        { stage: 'rerank' },
        STAGE_DURATION_OPTS,
      );
    } catch (err) {
      logger.warn({ err }, 'Rerank stage bypassed — serving the fused order');
      span?.setAttribute('rag.rerank', 'bypassed');
      topResults = candidates.slice(0, Math.max(0, topK));
    }
  } else {
    // Math.max guards a non-positive topK (unreachable from HTTP — Zod
    // floors limit at 1 — but slice(0, -1) would return all-but-last).
    topResults = candidates.slice(0, Math.max(0, topK));
  }

  // Record search analytics (non-blocking)
  // `maxScore` is deliberately still the RRF fusion value, NOT `vectorScore`
  // and NOT the rerank relevance. Repointing it would silently make new rows
  // incomparable with every historical one — migration 088 added
  // `rerank_score` for the #1104 stage precisely so each scale keeps its own
  // column; `rerankScore` below is that column's first writer. See the
  // score-semantics note in docs/architecture/09-flow-rag-chat.md. One
  // caveat since #1103: the fusion value's SCALE tracks the stage limit
  // (rrfWorstCase rises with the fetch width), so rows straddling a
  // `rag_fetch_width` change are only loosely comparable — the same caveat
  // RAG_EF_SEARCH always carried.
  const maxScore = topResults.length > 0 ? Math.max(...topResults.map((r) => r.score)) : null;
  trackSearchAnalytics(userId, question, topResults.length, maxScore, searchTypeFinal, {
    ...analyticsExtras,
    rerankScore: rerankMax,
  });

  return topResults;
}

/**
 * Retrieval confidence for the #1105 refuse gate — computed from RETRIEVAL
 * signals only, never from LLM self-report (the guide's "confident liar"
 * rule). Two bases, never blended (their scales are unrelated):
 *
 * - `rerank`: the #1104 stage ran — max rerank relevance is the best
 *   evidence available. Deployment-specific scale (see
 *   SearchResult.rerankScore's comparability caveat).
 * - `similarity`: no rerank — max cosine over the returned set.
 *   Embedding-model-specific scale.
 * - `none`: keyword-only results carry NO measurable signal — score is
 *   null, and the gate must not refuse what it cannot measure (refusing
 *   every keyword-fallback would turn the degraded mode into an outage).
 *
 * An empty result set scores 0 with basis 'none' — the one unmeasured case
 * that DOES refuse when the gate is on, because "no grounding at all" is
 * exactly what the gate exists to say honestly.
 */
export interface RetrievalConfidence {
  score: number | null;
  basis: 'rerank' | 'similarity' | 'none';
}

export function computeRetrievalConfidence(results: SearchResult[]): RetrievalConfidence {
  if (results.length === 0) return { score: 0, basis: 'none' };
  let maxRerank: number | null = null;
  let maxSim: number | null = null;
  for (const r of results) {
    if (r.rerankScore != null && (maxRerank === null || r.rerankScore > maxRerank)) {
      maxRerank = r.rerankScore;
    }
    if (r.vectorScore !== null && (maxSim === null || r.vectorScore > maxSim)) {
      maxSim = r.vectorScore;
    }
  }
  if (maxRerank !== null) return { score: maxRerank, basis: 'rerank' };
  // Clamp: cosine can run negative (see vectorScore's JSDoc); a threshold in
  // [0,1) must still catch it, so floor at 0.
  if (maxSim !== null) return { score: Math.max(0, maxSim), basis: 'similarity' };
  return { score: null, basis: 'none' };
}

/**
 * Build a RAG context prompt from search results.
 */
export function buildRagContext(results: SearchResult[]): string {
  if (results.length === 0) {
    return 'No relevant context found in the knowledge base.';
  }

  return results
    .map((r, i) => {
      return `[Source ${i + 1}: "${r.pageTitle}" (Space: ${r.spaceKey || 'Local'}, Section: ${r.sectionTitle})]\n${r.chunkText}`;
    })
    .join('\n\n---\n\n');
}

export { RAG_EF_SEARCH, reciprocalRankFusion, rrfWorstCase };
export type { SearchResult };
