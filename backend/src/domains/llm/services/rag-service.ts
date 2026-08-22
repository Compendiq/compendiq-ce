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
import { chooseLexicalParser } from '../../../core/utils/lexical-query.js';
import { visiblePagesPredicate } from '../../../core/services/page-visibility.js';
import { isFeatureEnabled } from '../../../core/enterprise/loader.js';
import { ENTERPRISE_FEATURES } from '../../../core/enterprise/features.js';
import pgvector from 'pgvector';
import { logger } from '../../../core/utils/logger.js';
import {
  getRagContextCharsPerPage,
  getRagFetchWidth,
  getRagPinIdentifiersEnabled,
  getRagMmrConfig,
  getRagRankingPriorWeight,
  RAG_MMR_LAMBDA_DEFAULT,
  getRagRerankCandidates,
  RAG_RERANK_CANDIDATES_MAX,
  RAG_RERANK_CANDIDATES_MIN,
  RAG_FETCH_WIDTH_DEFAULT,
  RAG_FETCH_WIDTH_MAX,
} from '../../../core/services/admin-settings-service.js';
import { withSpan, recordHistogram } from '../../../telemetry.js';
import { MIN_EMBEDDABLE_TEXT_CHARS } from './embedding-service.js';
import { efSearchFor } from './hnsw-ef-search.js';
import { formatQueryForEmbedding } from './query-instruction.js';
import {
  searchImageLeg,
  imageRawLimit,
  type ImageHit,
  type ImageLegOutcome,
  type ImageLegPage,
} from './image-leg-search.js';

/**
 * Latency histogram for retrieval pipeline stages (#1117). `stage` is the one
 * attribute: 'vector_search' | 'keyword_search' | 'rerank' (#1104) |
 * 'page_merge' (#1106 PR 2) | 'total'. Per-leg stages record
 * successful runs only; 'total' records failures too — an error's latency is
 * still latency the caller waited out.
 */
export const RETRIEVAL_STAGE_DURATION_METRIC = 'compendiq.retrieval.stage.duration';

const STAGE_DURATION_OPTS = {
  unit: 'ms',
  description: 'Latency of retrieval pipeline stages (vector/keyword legs, rerank, page_merge, total)',
};

// The ef_search resolver and its 2x-headroom arithmetic live in
// hnsw-ef-search.ts, so the page_avg_embedding kNN in embedding-service.ts can
// share ONE definition with retrieval instead of running at PostgreSQL's
// default 40 (#1113's folded-in scope item). See that module for why it is not
// declared here. Since #1285 the FLOOR is `admin_settings.rag_ef_search` rather
// than a module-load env read, so there is no constant left to re-export from
// here — `efSearchFor` is async and reads the same cached getter every other
// Retrieval-panel knob reads.

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
 * - Since #1106 the vector leg IS page-denominated: `limit` counts distinct
 *   pages, and vectorSearch over-fetches raw chunk rows (PAGE_FANOUT x,
 *   capped) to satisfy it, so a stage limit of N yields N distinct pages
 *   whenever the corpus has them inside the raw fetch. The shortfall case
 *   (fewer distinct pages than N inside min(4N, 500) raw rows) passes
 *   everything through — pre-#1106 yield is the floor.
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
   * The fusion value is ~0.016 for a single rank in one leg and ~0.033 for
   * the common two-leg case — and since #1106's best-chunk-only rule that
   * two-leg figure IS the ceiling wherever the two TEXT legs are all there
   * is: a page's vector contribution is its best chunk's reciprocal rank only
   * (per-chunk summing measurably crushed the head — see
   * reciprocalRankFusion), so `rrfWorstCase(true)` ≈ 0.0328 bounds those paths
   * at every fetch width, rerank pool and raw chunk window alike. Where
   * #1115 P3's image leg also runs — a deployment with an `image_embedding`
   * assignment and a non-empty index — the bound is one leg higher,
   * `rrfWorstCase(true, 60, true)` = 3/61 ≈ 0.0492, and it is still
   * width-invariant. A test pins both figures rather than leaving them as
   * prose.
   *
   * The straddle caveat runs the other way now: `max_score` analytics rows
   * written BEFORE the #1106 deploy carry the old summed scale — up to
   * ~0.17 on the chat path, ~0.42 with a rerank pool assigned, more at a
   * raised width — and are only loosely comparable with new bounded rows,
   * the same class of caveat #1103's width change carried.
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
   * The best chunk's `chunk_index` (document position) when this record's
   * representative text came from the vector leg; absent for keyword-only
   * rows. #1106 PR 2's sibling assembly anchors its contiguous window here.
   * Document order but NOT contiguous — embedding batches skipped on a
   * context-length 400 leave holes, so consumers order by it, never do
   * arithmetic on it.
   */
  chunkIndex?: number;
  /**
   * #1106 PR 2 — the assembled sibling window for the LLM context, present
   * only when `assembleContext` ran and this page had fetchable siblings.
   * Read EXCLUSIVELY by buildRagContext (`contextText ?? chunkText`);
   * `chunkText` stays the best chunk because /api/search snippets and the
   * rerank docs must keep the matching passage, not a page prefix — the
   * design-round's unanimous never-mutate-chunkText fatal. Never serialized
   * to the wire (every consumer maps fields explicitly).
   */
  contextText?: string;
  /**
   * How many sibling chunks `contextText` spans.
   */
  mergedChunkCount?: number;
  /**
   * True when the assembled window's chunks carry more than one distinct
   * section_title (#1270 review F4 — window SIZE was a false proxy: every
   * chunk of one oversized section shares its title, and dropping the
   * header there removed an exactly-truthful label). buildRagContext and
   * the sources map both key the Section claim on THIS.
   */
  contextSpansSections?: boolean;
  /**
   * #1107 — this record was pinned by a VERIFIED exact-identifier match,
   * ahead of the fused ranking. `vectorScore` stays null (nothing was
   * measured), which deliberately means a pinned head keeps the #1105
   * confidence gate unmeasurable — a verified exact match must never be
   * auto-refused.
   */
  pinned?: true;
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
  /**
   * #1115 P3 — the images on THIS page that the image leg matched, best-first
   * and capped at `MAX_IMAGE_HITS_PER_PAGE`. Absent when the leg did not reach
   * this page (which is every page when the leg is off).
   *
   * Present on a page the text legs found too: the leg contributes a rank to
   * the fusion, and the hits ride along on whichever row won the merge, so
   * `/llm/ask` can list the pictures and P4 can choose which bytes to send.
   * The per-hit `similarity` is a CROSS-MODAL cosine and orders images within
   * this leg only — it never becomes `vectorScore`, never reaches
   * `computeRetrievalConfidence`, and is never put on the wire (ADR-025 §8's
   * calibration warning).
   */
  imageHits?: ImageHit[];
  /**
   * #1115 P3 — this page was reached ONLY by the image leg, so its
   * `chunkText` is a stand-in rather than something retrieval matched: chunk 0
   * of the page, or (see {@link SearchResult.imageTextSynthesized}) its title.
   *
   * Read by `computeRetrievalConfidence`, which excludes these rows from the
   * confidence SAMPLE entirely — see the argument there.
   */
  imageOnly?: true;
  /**
   * #1115 P3 — set with `imageOnly` when the page had no `chunk_index 0` row
   * at all (an image-only page below `MIN_EMBEDDABLE_TEXT_CHARS`, which is
   * invisible to both text legs today) and `chunkText` is therefore the page
   * TITLE, synthesised here.
   *
   * Its own flag rather than an inference, because "the row came from chunk 0"
   * and "the row is a title we made up" are different claims about the text a
   * cross-encoder is about to score, and only the second one is text the page
   * does not contain.
   */
  imageTextSynthesized?: true;
  /**
   * #1115 P3 — where this page's best image sat in the image leg's RAW row
   * stream ({@link ImageLegPage.bestRawIndex}). Internal to fusion: it is read
   * only by {@link fuseWithStableHead}'s narrow reconstruction and never
   * reaches a wire shape (`/api/search` and `/llm/ask` both map explicitly).
   *
   * Absent on every row the two text legs produced, and absent on an image row
   * a test builds by hand — the reconstruction then falls back to the row's
   * array position, which is what an uncrowded raw window would give.
   */
  imageRawIndex?: number;
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
 * #1106 PR 1 — page-denominated vector fetch. `limit` counts DISTINCT PAGES;
 * the leg over-fetches `PAGE_FANOUT x limit` raw CHUNK rows (multi-chunk
 * pages are real since #1265 and were crowding distinct pages out of the
 * stage limit — the measured Recall@5 0.8819→0.8542 / @10 0.9236→0.9028
 * fan-out regression) and truncates the ordered stream where the limit-th
 * distinct page first appears. Shortfall passes everything through, so the
 * pre-#1106 yield is a floor, never a ceiling.
 *
 * PAGE_FANOUT 4 is a code constant, not a knob, derived from the observed
 * chunk-per-page density near the top of the post-#1265 ranking; the eval
 * rig arbitrates any retune. VECTOR_RAW_LIMIT_CAP is exact arithmetic, not
 * taste: 2 x 500 = 1000 is pgvector's ef_search ceiling, so the 2x ef
 * headroom rule (see vectorSearch) survives at the width-200 knob cap —
 * without the cap, width 200 would want ef 1600 and silently clamp below
 * coverage, the exact failure class the headroom rule exists to prevent.
 */
export const PAGE_FANOUT = 4;
export const VECTOR_RAW_LIMIT_CAP = 500;

/**
 * How many chunk_index positions EACH SIDE of the anchor the sibling fetch
 * covers (#1270 review F2 — the fetch must be bounded). 32 x the ~1500-char
 * typical chunk is ~48 KB per side, far beyond any reachable budget
 * (24000-char knob cap); a page of pathologically tiny chunks may hit the
 * range edge and assemble a smaller window — graceful, and the budget was
 * the binding constraint anyway.
 */
export const SIBLING_FETCH_SPAN = 32;

/**
 * The raw CHUNK-row fetch that backs a request for `limit` distinct pages.
 * One definition, two consumers — vectorSearch's SQL LIMIT and
 * fuseWithStableHead's head-window reconstruction — because the #1103
 * append-only invariant depends on them agreeing exactly (#1269 review B1).
 * Math.max(limit, …): see the m16 note at the vectorSearch call site.
 */
export function vectorRawLimit(limit: number): number {
  return Math.max(Number(limit), Math.min(PAGE_FANOUT * Number(limit), VECTOR_RAW_LIMIT_CAP));
}

/**
 * Cut an ordered row stream at the first appearance of the `maxPages`-th
 * distinct page — a PREFIX operation (result at w1 is a prefix of result at
 * w2 for w1 < w2), which is what lets fuseWithStableHead's page-denominated
 * rank window inherit the append-only widening property. Chunks of
 * already-seen pages ABOVE the cut survive — under best-chunk-only fusion
 * they contribute no score (see reciprocalRankFusion), but they still
 * compete for the representative text (and thereby pick the assembly
 * ANCHOR — the assembly stage fetches its own sibling window from the DB
 * and does not otherwise read these rows); everything below the cut is
 * dropped.
 */
export function truncateAtDistinctPages<T extends { pageId: number }>(rows: T[], maxPages: number): T[] {
  if (maxPages <= 0) return [];
  const seen = new Set<number>();
  for (let i = 0; i < rows.length; i++) {
    if (!seen.has(rows[i]!.pageId)) {
      seen.add(rows[i]!.pageId);
      // >= not ===: a fractional budget must cut at the ceiling, never fail
      // open into "no truncation at all" (#1269 review m15 — unreachable
      // from today's integer-only callers, but this function's whole
      // contract is "cut here").
      if (seen.size >= maxPages) return rows.slice(0, i + 1);
    }
  }
  return rows;
}

/**
 * Vector search: cosine similarity on page_embeddings. `limit` counts
 * DISTINCT PAGES since #1106 (see PAGE_FANOUT above for the raw fetch and
 * truncation mechanics). Sets hnsw.ef_search for this transaction to cover
 * the raw fetch. Scoped to: Confluence pages in user's selected spaces +
 * standalone articles the user can access (shared, or private and owned by
 * the user).
 *
 * Tradeoff: higher ef_search = better recall but slower query.
 * Default PostgreSQL ef_search is 40; the floor here is 100.
 *
 * `opts.spaceKey` (#1351) narrows the scan to one Confluence space, applied
 * as an additional predicate ALONGSIDE `visiblePagesPredicate` — it can only
 * ever shrink the ACL-visible set, never widen it. Standalone pages carry no
 * `space_key` (NULL), so scoping excludes them, matching the keyword-mode
 * filter `routes/knowledge/search.ts` has always applied. Optional and
 * defaults to undefined/no-op, so every unscoped caller (RAG chat, deep
 * search, the eval/benchmark harness) is byte-identical.
 */
export async function vectorSearch(
  userId: string,
  questionEmbedding: number[],
  limit = RAG_FETCH_WIDTH_DEFAULT,
  opts?: { spaceKey?: string },
): Promise<SearchResult[]> {
  return withSpan(
    'rag.vector_search',
    async (span) => {
      const started = performance.now();
      const spaceKey = opts?.spaceKey;
      const vecSpaces = await getUserAccessibleSpaces(userId);
      // Use the dedicated vector pool so long-running similarity queries
      // do not starve the main pool used by CRUD routes.
      const client = await getVectorPool().connect();
      try {
        await client.query('BEGIN');
        // The RAW fetch is chunk-denominated (#1106): PAGE_FANOUT x the
        // requested page count, capped so the ef arithmetic below stays
        // inside pgvector's ceiling.
        // Math.max(limit, …): above limit 500 the fan-out cap would make the
        // raw fetch NARROWER than the requested page count, inverting the
        // "pre-#1106 yield is the floor" guarantee (#1269 review m16 —
        // unreachable at today's 200 stage-limit ceiling, but the JSDoc
        // explicitly anticipates internal callers with a large topK; past
        // 500 the ef headroom relaxes from 2x toward 1x under the 1000
        // clamp, still covering the LIMIT).
        const rawLimit = vectorRawLimit(limit);
        // ef_search must cover the RAW LIMIT: HNSW returns at most
        // ef_search rows (verified against pgvector 0.8.5 — LIMIT 200 with
        // ef_search 100 yields 100 rows), so a fetch above the configured
        // `rag_ef_search` floor would silently plateau while the keyword leg
        // kept widening. Since #1106 the covered quantity is the raw CHUNK fetch, not the page
        // count — covering only `limit` would starve the truncation of the
        // very rows it needs. 2x, not 1x: ef_search == k is HNSW's worst
        // recall setting — the graph walk needs headroom beyond the return
        // size. Clamped to pgvector's [1, 1000] bound; the raw cap keeps
        // 2 x rawLimit <= 1000 at every reachable width.
        await client.query(`SET LOCAL hnsw.ef_search = ${await efSearchFor(rawLimit)}`);

        const result = await client.query<{
          page_id: number;
          confluence_id: string | null;
          chunk_text: string;
          chunk_index: number;
          // `space_key` is NULL for locally-created (standalone) pages, same as
          // `confluence_id` — `SearchResult.spaceKey` has always been nullable.
          metadata: { page_title: string; section_title: string; space_key: string | null };
          distance: number;
        }>(
          `SELECT cp.id AS page_id, cp.confluence_id, pe.chunk_text, pe.chunk_index, pe.metadata,
                  pe.embedding <=> $2 AS distance
           FROM page_embeddings pe
           JOIN pages cp ON pe.page_id = cp.id
           WHERE ${visiblePagesPredicate(1, 4)}
           AND cp.deleted_at IS NULL${spaceKey ? ' AND cp.space_key = $5' : ''}
           ORDER BY pe.embedding <=> $2
           LIMIT $3`,
          spaceKey
            ? [vecSpaces, pgvector.toSql(questionEmbedding), rawLimit, userId, spaceKey]
            : [vecSpaces, pgvector.toSql(questionEmbedding), rawLimit, userId],
        );

        await client.query('COMMIT');

        // Truncate AFTER mapping so the helper works on the same shape its
        // unit tests pin. `limit` distinct pages, fan-out bounded to chunks
        // ranking above the last admitted page's entry.
        const mapped = truncateAtDistinctPages(
          result.rows.map((row) => ({
            pageId: row.page_id,
            confluenceId: row.confluence_id,
            chunkText: row.chunk_text,
            chunkIndex: row.chunk_index,
            pageTitle: row.metadata.page_title,
            sectionTitle: row.metadata.section_title,
            spaceKey: row.metadata.space_key,
            score: 1 - row.distance, // Convert distance to similarity
            vectorScore: 1 - row.distance,
            keywordRank: null,
          })),
          Number(limit),
        );
        // `rag.hits` counts kept CHUNK rows (post-truncation, up to ~fanout x
        // limit); `rag.pages` is the distinct-page yield — the one signal
        // that answers "did the page-denominated fetch actually deliver N
        // pages" in production (#1269 review m12).
        span?.setAttribute('rag.hits', mapped.length);
        span?.setAttribute('rag.pages', new Set(mapped.map((r) => r.pageId)).size);
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
 *
 * `opts.spaceKey` (#1351): see the matching note on `vectorSearch` — same
 * narrow-only semantics, same standalone-page exclusion, same no-op default.
 */
export async function keywordSearch(
  userId: string,
  questionText: string,
  limit = RAG_FETCH_WIDTH_DEFAULT,
  opts?: { spaceKey?: string },
): Promise<SearchResult[]> {
  // The lexical parser is CHOSEN per query (#1110, see lexical-query.ts).
  // Normally websearch_to_tsquery, so users get "quoted phrases" as real
  // phrase matches and `-term` as a genuine exclusion — the latter was
  // previously INVERTED, since plainto parsed a leading `-` as an ordinary
  // term and so REQUIRED the word the user asked to exclude.
  //
  // A pathological query falls back to plainto_tsquery instead of being
  // rewritten. websearch nests NOTs and right-nests punctuation-joined
  // tokens, so it errors where plainto merely flattens; rewriting the string
  // to dodge that destroyed hyphenated identifiers, which is why the guard
  // switches parser rather than editing the query. The measurements and the
  // three rejected alternatives are recorded in lexical-query.ts.
  //
  // KNOWN SEMANTIC CHANGE, measured and accepted: a bare `or` is the OR
  // operator, so a question splits into a disjunction rather than an all-AND
  // conjunction. 7 of the 152 eval-fixture queries carry one; across both
  // axes one improved (rank 8 -> 7) and none regressed. `and` matches the
  // previous implicit conjunction, so it is a no-op.
  const trimmed = questionText.trim();
  // Before the span on purpose: an empty query is not a retrieval, and a
  // 0ms sample for it would only pollute the stage histogram.
  if (!trimmed) return [];

  return withSpan(
    'rag.keyword_search',
    async (span) => {
      const started = performance.now();
      // A closed union of two literals from lexical-query.ts, never user
      // input, so interpolating it is safe. A pathological query falls back
      // to the parser this product used before #1110 rather than being
      // rewritten — plainto keeps hyphens, so identifiers survive.
      const parser = chooseLexicalParser(trimmed);
      const ftsLang = await getFtsLanguage();
      const spaceKey = opts?.spaceKey;

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
                ts_rank(cp.tsv, ${parser}('${ftsLang}', $2)) AS rank
         FROM pages cp
         WHERE cp.tsv @@ ${parser}('${ftsLang}', $2)
           AND ${visiblePagesPredicate(1, 4)}
           AND cp.deleted_at IS NULL${spaceKey ? ' AND cp.space_key = $5' : ''}
         ORDER BY rank DESC
         LIMIT $3`,
        spaceKey ? [kwSpaces, trimmed, limit, userId, spaceKey] : [kwSpaces, trimmed, limit, userId],
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
 * Largest RRF score a single page can reach: its best vector chunk at leg
 * rank 1, optionally plus the top keyword slot and (#1115 P3) the top image
 * slot — 1/(k+1) per leg. So **2/61 ≈ 0.0328 with the two text legs, and
 * 3/61 ≈ 0.0492 where the image leg also participates**.
 *
 * The ceiling is WIDTH-INVARIANT either way, which is the property #1106's
 * best-chunk-only rule bought: per-chunk summing is gone (see
 * reciprocalRankFusion) and the image leg is page-denominated from the start,
 * so neither the fetch width, the rerank pool, nor the raw chunk window moves
 * it. What moves it is the LEG COUNT, and only that.
 *
 * Exported for the test that pins `SearchResult.score`'s documented bounds.
 * The prose version of this has been wrong three times, in both directions,
 * while the per-CHUNK vector leg let one page's contributions sum — the
 * history matters for analytics: `max_score` rows written before the #1106
 * deploy carry the old SUMMED scale (up to ~0.17 chat / ~0.42 with a rerank
 * pool assigned) and are only loosely comparable with new bounded ones. Rows
 * straddling the moment a VL model is first assigned are the same loose class
 * one band lower, between the 2/61 and 3/61 ceilings.
 */
function rrfWorstCase(withKeywordHit = false, k = 60, withImageHit = false): number {
  // #1115 P3 added the third term. It is OPTIONAL and defaults false so every
  // existing caller (and the test that pins the two-leg figure) is unchanged:
  // the image leg does not exist on a deployment with no `image_embedding`
  // assignment.
  return (1 + (withKeywordHit ? 1 : 0) + (withImageHit ? 1 : 0)) / (k + 1);
}

/**
 * Reciprocal Rank Fusion (RRF) — combines the vector, keyword and (#1115 P3)
 * image legs. RRF score = sum(1 / (k + rank_i)) over the legs a page appears
 * in.
 */
function reciprocalRankFusion(
  vectorResults: SearchResult[],
  keywordResults: SearchResult[],
  imageResults: SearchResult[] = [],
  k = 60,
): SearchResult[] {
  // The per-leg raw values are taken from WHICH ARGUMENT a result arrived in,
  // not from the fields already on it: `score` is the leg's own native unit
  // (cosine from the vector query, ts_rank from the FTS query), and reading it
  // positionally is what keeps a keyword-only hit from reporting a similarity
  // it never had (#1117).
  const scoreMap = new Map<
    string,
    {
      result: SearchResult;
      score: number;
      vectorScore: number | null;
      keywordRank: number | null;
      imageHits: ImageHit[] | undefined;
    }
  >();

  // Score from vector search. A page's fusion contribution is its BEST
  // chunk's reciprocal rank ONLY (#1106 measured decision): per-chunk
  // summing over the page-denominated raw window let chunk COUNT dominate
  // chunk QUALITY under RRF k=60 flatness — candidate-v1 on the #1102 rig
  // recovered Recall@10 (+2 queries) but paid Recall@1 0.4028→0.3333 and
  // MRR 0.6016→0.5503, the head-dilution failure class #1103 measured. The
  // rows arrive distance-ordered, so the first occurrence IS the best chunk
  // and later siblings add no score; they still compete for representative
  // text below. Cross-LEG summing stays — a page found by both legs earns
  // both contributions (that dilution axis is what fuseWithStableHead
  // bounds, and it is unchanged by this cap).
  // Vector-leg RANK is page-denominated too (#1269 review m2): with the raw
  // window 4x wider, a row-index rank would put the Nth distinct vector page
  // near row 4N against the Nth keyword page's rank N — a systematic
  // ~30-40% de-weighting of the vector tail that the row-symmetric pre-#1106
  // legs never had. A page's rank is the number of distinct pages ranked
  // above its best chunk, restoring cross-leg symmetry.
  let vectorPagesSeen = 0;
  vectorResults.forEach((result) => {
    const key = String(result.pageId);
    const existing = scoreMap.get(key);
    const rrf = 1 / (k + vectorPagesSeen + 1);
    if (existing) {
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
      scoreMap.set(key, {
        result, score: rrf, vectorScore: result.score, keywordRank: null,
        imageHits: result.imageHits,
      });
      vectorPagesSeen++;
    }
  });

  // Ordering note (#1269 review m14): a vector-rank-1 page and a
  // keyword-only rank-1 page tie exactly at 1/(k+1) under best-chunk-only
  // scoring. The vector page wins ONLY because this Map is populated by the
  // vector loop first and the sort below is stable — which is what keeps
  // `results[0]` vector-led for #1105's confidence basis whenever the
  // vector leg is non-empty. Do not reorder these two loops or replace the
  // stable sort without re-deriving that property.
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
      scoreMap.set(key, {
        result, score: rrf, vectorScore: null, keywordRank: result.score,
        imageHits: result.imageHits,
      });
    }
  });

  // Score from the image leg (#1115 P3). It arrives already PAGE-DENOMINATED
  // and rank-ordered (`groupByPage`), so the array index IS the rank and one
  // page can only ever contribute once — the third leg's version of the
  // best-chunk-only rule, and the reason a page carrying five near-identical
  // screenshots cannot out-score a page whose single image matches better.
  //
  // It runs LAST of the three, which decides the tie-break the same way the
  // keyword loop's position does: at equal scores the Map's insertion order
  // plus the stable sort keep a vector-led page ahead of a keyword-led one and
  // both ahead of an image-only one. That ordering is load-bearing for #1105 —
  // `computeRetrievalConfidence` reads the SIMILARITY basis off `results[0]`,
  // and an image-only row must not be able to displace a measured vector row
  // from the head and turn a measurable set into an unmeasurable one.
  //
  // The row OBJECT is never replaced: a page found by both legs keeps the
  // vector chunk (purpose-built for LLM context) and only GAINS its hits.
  imageResults.forEach((result, rank) => {
    const key = String(result.pageId);
    const existing = scoreMap.get(key);
    const rrf = 1 / (k + rank + 1);
    if (existing) {
      existing.score += rrf;
      existing.imageHits = result.imageHits;
    } else {
      scoreMap.set(key, {
        result, score: rrf, vectorScore: null, keywordRank: null,
        imageHits: result.imageHits,
      });
    }
  });

  // `score` stays the RRF fusion value: it is what the sort below consumes, and
  // what every caller's ordering already depends on. Only the per-leg fields
  // are added — this function's output ORDER is unchanged.
  return Array.from(scoreMap.values())
    .sort((a, b) => b.score - a.score)
    .map((entry) => ({
      ...entry.result,
      score: entry.score,
      vectorScore: entry.vectorScore,
      keywordRank: entry.keywordRank,
      ...(entry.imageHits ? { imageHits: entry.imageHits } : {}),
    }));
}

function countDistinctPages(rows: SearchResult[]): number {
  const seen = new Set<number>();
  for (const r of rows) seen.add(r.pageId);
  return seen.size;
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
 * So the head takes its ORDER from fusion over the rows spanning the first
 * `rankWidth` DISTINCT PAGES of each leg (#1106 — the vector leg is
 * chunk-denominated, see truncateAtDistinctPages) — the same page sequence a
 * narrower request returns — and the
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
  imageResults: SearchResult[] = [],
): SearchResult[] {
  // ONE construction (#1269 re-verification): the head is ALWAYS what a
  // narrower request (stage limit = rankWidth) would have fetched, built by
  // exact reconstruction from the wide legs — truncateAtDistinctPages over
  // the wide leg's own narrow raw window, one shared vectorRawLimit with
  // vectorSearch. The fast path below is a pure OPTIMIZATION, taken only
  // when the reconstruction is the identity (each leg already equals its
  // own narrow reconstruction), in which case head == wide and extras are
  // empty — verified equivalent to always-construct over randomized
  // configurations. The previous distinct-page-count fast path was a second
  // POLICY, and it reopened the reconstruction's own hole one branch over:
  // a wide raw window can surface a page the narrow window never reached
  // while both legs still total <= rankWidth distinct pages (very heavy
  // fan-out corpora), and fusing the wide legs then reorders the top.
  //
  // The guarantee is: EXACT GIVEN THE SAME ef_search. ef varies with the
  // raw limit (constant only for stage limits <= 12), so the narrow and
  // wide REQUESTS can explore different amounts of the HNSW graph and see
  // slightly different raw streams — the reconstruction removes all
  // ALGORITHMIC divergence, which is what the pre-#1106 slice gave, and the
  // residual is graph-walk noise, not a reordering rule.
  const narrowV = truncateAtDistinctPages(vectorResults.slice(0, vectorRawLimit(rankWidth)), rankWidth);
  const narrowK = truncateAtDistinctPages(keywordResults, rankWidth);
  // #1115 P3: the image leg arrives one row per page, but it was DENOMINATED
  // that way from a raw stream of image rows — so a plain prefix is NOT what a
  // narrow request would have had, for exactly the reason the vector leg redoes
  // its own raw-window arithmetic one line above. A narrow request reads
  // `imageRawLimit(rankWidth)` raw rows (40 at the default width), and two
  // pages carrying `rag_images_per_page_max` pictures each fill that window
  // between them — so its leg would report two pages where `slice(0, rankWidth)`
  // reports ten, and the eight extras dilute the head #1103 measured. The page
  // cap is reapplied after the window, because `groupByPage(rows, rankWidth)`
  // applies both.
  const imageNarrowRaw = imageRawLimit(rankWidth);
  const narrowI = imageResults
    .filter((r, i) => (r.imageRawIndex ?? i) < imageNarrowRaw)
    .slice(0, rankWidth);
  if (
    narrowV.length === vectorResults.length
    && narrowK.length === keywordResults.length
    && narrowI.length === imageResults.length
  ) {
    return reciprocalRankFusion(vectorResults, keywordResults, imageResults);
  }
  const head = reciprocalRankFusion(narrowV, narrowK, narrowI);
  const wide = reciprocalRankFusion(vectorResults, keywordResults, imageResults);
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
 *
 * `hybrid_multi_query` (#1112): a deep search whose expansion actually
 * produced at least one paraphrase leg — written by `multiQuerySearch`, not
 * by this module, and it is the ONLY row that search recorded (the legs run
 * with `recordAnalytics: false`, so the paraphrases a model invented never
 * enter the table as if a user had typed them). Its `max_score` unit is its
 * own again: the WEIGHTED SUM of per-leg RRF contributions, bounded by
 * (1 + 0.6 + 0.6)/(k+1) ≈ 0.036 at k=60 — close enough to the single-query
 * fusion ceiling to be mistaken for it, which is exactly why it needs its own
 * value here. A deep search whose expansion was skipped or soft-failed ran
 * one ordinary leg and records what that leg records: the type says what
 * HAPPENED, never what was requested.
 */
export type SearchAnalyticsType =
  | 'hybrid'
  | 'hybrid_rerank'
  | 'hybrid_multi_query'
  | 'keyword_fallback'
  | 'semantic'
  | 'keyword'
  | 'faceted';

/**
 * Why a retrieval leg under-delivered on this search. NULL on a healthy row —
 * and on every row written before migration 088, where NULL means
 * "not recorded", not "healthy".
 *
 * `image_leg_unavailable` (#1115 P3) is the odd one out and deliberately so:
 * the other three are all facts about the VECTOR leg, which is the one that
 * decides whether an answer is grounded at all. An image-leg bypass changes
 * which pages come back — which is why it is recorded rather than left silent
 * like a rerank bypass — but a text-side reason always describes a worse
 * outage, and there is one column. See `deriveDegradedReason` for the
 * precedence and why it is not a second column.
 */
export type DegradedReason =
  | 'no_embeddings'
  | 'partial_embeddings'
  | 'embedding_failed'
  | 'image_leg_unavailable';

import { computeRetrievalConfidence, type RetrievalHealthCaveat } from './retrieval-confidence.js';
import { assembleSiblingWindow } from './sibling-assembly.js';
import { detectIdentifiers, type DetectedIdentifier } from './identifier-shortcircuit.js';
import { selectDiverse } from './mmr.js';
import { applyRankingPrior } from './ranking-prior.js';

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
 *
 * #1115 P3 adds `image_leg_unavailable` at the BOTTOM of that ladder: it is
 * recorded only when the text side is healthy. `search_analytics` has one
 * `degraded_reason` column and the value that belongs in it is the one that
 * hurt the answer most — during an embedding outage an operator needs to see
 * `embedding_failed`, and an image leg that also fell over in the same second
 * is a footnote to it, not a competing headline. The alternative (a second
 * column, or a comma-joined value) buys a fact nobody has asked a question
 * about at the cost of every existing reader's `=` predicate.
 */
export function deriveDegradedReason(
  embeddingFailed: boolean,
  coverage: EmbeddingCoverage | null,
  imageLegFailed = false,
): DegradedReason | null {
  if (embeddingFailed) return 'embedding_failed';
  if (coverage) {
    if (coverage.totalPages > 0 && coverage.embeddedPages === 0) return 'no_embeddings';
    if (coverage.coverage < DEGRADED_COVERAGE_THRESHOLD) return 'partial_embeddings';
  }
  return imageLegFailed ? 'image_leg_unavailable' : null;
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
/**
 * Retrieval-health verdict handed to `HybridSearchOptions.onRetrievalMeta`
 * at the END of the pipeline (#1268 review — it used to fire mid-pipeline,
 * before the ACL post-filter and the rerank stage, so it could neither
 * report 'hybrid_rerank' nor see an ACL-emptied set). The #1105 gate reads
 * health from here, not from analytics.
 */
export interface RetrievalMeta {
  degradedReason: DegradedReason | null;
  /** `degradedReason`, or 'coverage_unknown' when the probe itself failed. */
  healthCaveat: RetrievalHealthCaveat | null;
  /**
   * The FINAL label, 'hybrid_rerank' included. Caveat: 'hybrid' also covers
   * "both legs empty" — it means "not a keyword fallback", not "both legs
   * produced rows".
   */
  searchType: SearchAnalyticsType;
  embeddingCoverage: number | null;
  /** A non-empty fused set the EE ACL post-filter emptied — the one
   * zero-result shape that is a visibility fact, not a corpus fact.
   * Logged by the route so threshold tuning can exclude these; the refusal
   * wording deliberately does NOT distinguish them (no existence leak). */
  aclEmptied: boolean;
}

export interface HybridSearchOptions {
  rerank?: boolean;
  /**
   * Invoked once per search with the retrieval health verdict (#1105 B1).
   * The confidence gate must distinguish "healthy retrieval genuinely found
   * nothing" (refusable) from "the vector leg is down / the corpus is not
   * embedded" (unmeasurable — refusing there would claim coverage facts
   * during an outage, at outage scale). The callback keeps the return type
   * unchanged for every existing caller.
   */
  onRetrievalMeta?: (meta: RetrievalMeta) => void;
  /**
   * #1106 PR 2 — assemble each returned page's sibling chunks into a
   * contiguous, budget-bounded context window (`contextText`), anchored at
   * the retrieval representative. Chat-path only by design: /api/search
   * renders per-chunk snippets and must not receive merged text, and the
   * eval runner requests it so the rig measures the shipped chat
   * configuration (pageIds are provably unaffected — assembly runs after
   * the topK slice and touches no ranking field). Soft-fail: any error
   * degrades to chunk-level rows, never the search.
   */
  assembleContext?: boolean;
  /**
   * #1107 — detect literal identifiers in the query (page id, INC-style
   * key, quoted title; see identifier-shortcircuit.ts for the shapes and
   * guards), VERIFY each with a cheap indexed lookup under the same
   * visibility rules as retrieval, and PIN at most two verified records
   * ahead of the fused output. Natural-language queries are structurally
   * unaffected (the detector's token limits and cue guards). Soft-fail:
   * any lookup error skips the pin, never the search.
   */
  pinIdentifiers?: boolean;
  /** #1109: force the diversity narrow on/off for an A/B, bypassing
   * admin_settings so the stage is measurable within one tree. */
  mmr?: { enabled: boolean; lambda?: number };
  /**
   * #1112 — the rerank candidate pool for THIS request, replacing the
   * operator's `rag_rerank_candidates`: the effective pool is
   * `min(max(override, RAG_RERANK_CANDIDATES_MIN), RAG_RERANK_CANDIDATES_MAX)`,
   * i.e. the caller's number put through the operator's own clamp, and then
   * floored at `topK` by the stage itself (a pool narrower than the result
   * would truncate the result).
   *
   * It was a FLOOR when introduced, on the reasoning that the rerank stage
   * DROPS everything past the pool (`reranked` is built from `pool` alone), so
   * deep search's wider legs needed a wider funnel. That reasoning was right
   * about the mechanism and wrong about the budget: `rag_rerank_candidates`
   * bounds ONE retrieval's rerank cost, and deep search runs three of them
   * concurrently against a single `RERANK_TIMEOUT_MS`, so a floor MULTIPLIED
   * the operator's ceiling by the leg count (measured: 3 x 60 = 180 documents
   * took 14.9s against a 5s budget, timed out, and tripped the breaker).
   * Replacing rather than raising lets a multi-leg caller DIVIDE that budget,
   * which is the only direction that keeps one gesture's cost comparable to
   * one search's. Raising is still reachable — the clamp is the operator's
   * ceiling, not their configured value — but no caller does it today.
   *
   * Ignored unless `rerank` is also requested.
   */
  rerankCandidatesOverride?: number;
  /**
   * Write a `search_analytics` row for this search (default TRUE — every
   * pre-#1112 caller). Deep search's PARAPHRASE legs pass false: their query
   * text was invented by a model, and recorded as ordinary rows they would
   * show up in "top searches" and in the knowledge-gap predicate as questions
   * a user never asked. The wrapper records ONE `hybrid_multi_query` row for
   * the merged set instead.
   */
  recordAnalytics?: boolean;
  /**
   * #1351 — scope retrieval to one Confluence space: both fused legs
   * (vector + keyword, threaded straight through to
   * `vectorSearch`/`keywordSearch` — see their matching notes for the
   * narrow-only, standalone-excluding semantics) AND the exact-identifier
   * pin stage below (post-filtered there rather than in SQL — see its own
   * `inScope` note). Optional and undefined by default, so RAG chat, deep
   * search (`multi-query-search.ts`) and the eval/benchmark harness — none
   * of which pass it — see byte-identical behaviour. `/api/search`'s hybrid
   * branch is the only caller today.
   */
  spaceKey?: string;
  /**
   * #1115 P3 — force the image leg on or off for THIS request, bypassing
   * `admin_settings.rag_image_leg_enabled`. `undefined` (every caller today
   * except the two below) follows the setting.
   *
   * `false` is the meaningful direction and has two users: deep search's
   * PARAPHRASE legs (the original question's image hits are the only ones
   * worth having — see `multi-query-search.ts` for why feeding them to all
   * three legs would multiply the image evidence by the leg weights), and
   * P5b's paired eval, which measures leg-on against leg-off inside one
   * process. Flipping the admin setting for that measurement would change
   * what every other request on the instance retrieves for the duration of
   * the run.
   *
   * `true` forces past the SETTING only. It cannot conjure a leg that has no
   * assigned model or no rows to search — those are facts about the
   * deployment, not preferences.
   */
  imageLeg?: boolean;
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

/**
 * #1107 — how many rows each identifier lookup returns. It is not 1
 * (#1273 fork F5): EE page-level ACL filtering runs in the caller, AFTER
 * the query, so a single-row lookup that happened to select a restricted
 * page suppressed the pin an ACCESSIBLE page would have received —
 * "Deployment Runbook" existing in both HR (restricted) and ENG (readable)
 * pinned nothing at all. A short ordered candidate list lets the caller
 * pick the first row the user may actually read, and every branch's
 * ORDER BY already makes that list deterministic.
 */
export const IDENTIFIER_LOOKUP_CANDIDATES = 5;

/** Excerpt length for a pinned row when `rag_context_chars_per_page` is off. */
const PIN_EXCERPT_FALLBACK_CHARS = 500;

/**
 * #1107 — a TITLE pin requires an EXACT match, normalised for case and
 * whitespace. Not a similarity threshold, at any value.
 *
 * A threshold cannot work here, and that is measurable rather than a
 * matter of taste. On Postgres 17 / pg_trgm 1.6, a TYPO of the page the
 * user meant and a DIFFERENT page are not separable in EITHER direction:
 *
 *   similarity('Deployment Runbok',      'Deployment Runbook')      = 0.850
 *   similarity('Deployment Runbook 2023','Deployment Runbook 2024') = 0.846
 *   similarity('Onbaording',             'Onboarding')              = 0.467
 *   similarity('Offboarding',            'Onboarding')              = 0.533
 *
 * The last pair is the one that settles it: a semantically OPPOSITE page
 * scores HIGHER than a misspelling of the right one. So no floor admits
 * typos without also admitting the wrong year, quarter, region — or the
 * inverse concept — which this stage would then lead the results with,
 * label a verified exact match, and suppress the #1105 refusal gate for.
 * (Same family: 'Q1'/'Q2 Roadmap' 0.692, 'EMEA'/'APAC' 0.630, 'v1.2'/
 * 'v1.3' 0.810.) Trigram similarity is also length-blind, so one constant
 * cannot serve a 3-character acronym and a 40-character title at once.
 *
 * Fuzzy tolerance was never in the issue's contract; it arrived with the
 * trigram operator. A missed pin is a silent fallback to ordinary
 * retrieval with the refusal gate intact — the safe side of an
 * inseparable boundary. The `%` operator stays as the index-driven
 * candidate generator, and equality is the verification.
 */
/**
 * The Unicode spaces BOTH halves of the comparison must collapse, listed
 * once and used to build both halves — because the two drifting apart is
 * the failure mode, not any particular character.
 *
 * JavaScript's `\s` matches all of these; Postgres's `\s` matches only the
 * ASCII set. So a title carrying a non-breaking space — which Confluence
 * and Word paste routinely — normalised to something the JS side could
 * never produce, and the equality silently never matched: the page became
 * permanently unpinnable, with no signal anywhere. `translate()` maps them
 * to plain spaces in SQL before the collapse, so both sides agree.
 */
// Escapes, never literals: these characters are invisible in an editor, so
// a literal list cannot be reviewed and a stray copy-paste cannot be seen.
const UNICODE_SPACES = [
  '\u00A0', // no-break space — the one Confluence and Word actually emit
  '\u1680', // ogham space mark
  '\u2000', '\u2001', '\u2002', '\u2003', '\u2004', '\u2005',
  '\u2006', '\u2007', '\u2008', '\u2009', '\u200A', // en/em/thin/hair spaces
  '\u202F', // narrow no-break space
  '\u205F', // medium mathematical space
  '\u3000', // ideographic space
  '\uFEFF', // zero-width no-break space (BOM)
].join('');
const UNICODE_SPACES_AS_PLAIN = ' '.repeat(UNICODE_SPACES.length);

/**
 * Both sides of the title equality are normalised by THIS expression and
 * nothing else — there is deliberately no JavaScript counterpart.
 *
 * An earlier version normalised the query in JS and the column in SQL, and
 * kept the two in step by hand. They were not in step, in three separate
 * ways: JS `\s` matches U+00A0 and Postgres's does not; `lower()` and
 * `toLowerCase()` disagree on U+0130 (Turkish dotted capital İ — Postgres
 * yields `i`, JS yields `i` plus a combining dot) and on U+1C89; and JS
 * lowercases a word-final Σ to `ς` while Postgres yields `σ`. Each one
 * made a whole class of titles impossible to pin — Turkish, uppercase
 * Greek, anything pasted from Word — silently and forever, because the
 * unreachable value was the STORED one, so no phrasing of the query could
 * reach it.
 *
 * Two normalisers that must agree is the defect. One is the fix: applying
 * the same SQL to the column and the parameter cannot diverge, and it
 * takes Postgres's `lower()` as the single lowercaser in the path.
 */
const NORMALIZED_TITLE = (expr: string, spacesParam: string, plainParam: string): string =>
  `lower(btrim(regexp_replace(translate(${expr}, ${spacesParam}, ${plainParam}), '\\s+', ' ', 'g')))`;

/**
 * #1107 — verify one detected identifier under the caller's space
 * visibility. Returns up to IDENTIFIER_LOOKUP_CANDIDATES keyword-style
 * SearchResults (body-text excerpt, no measured scores, `pinned: true`) in
 * confidence order, or an empty array.
 *
 * The #1273 review's root-cause rule governs every branch: a lookup that
 * returns A row must never be treated as a lookup that returned THE row.
 * - pageId: the confluence_id namespace (what a user means by "page id")
 *   is preferred over the internal SERIAL PK via ORDER BY, and the PK arm
 *   only participates when the value fits int4 (B1/M2 — a 10-digit id
 *   used to throw 22003 and soft-fail the whole lookup).
 * - issueKey: TITLE ONLY, with a deterministic ORDER BY (title starting
 *   with the key beats containing it, shorter beats longer). The old
 *   single OR query returned heap order, pinning the oldest page that
 *   mentioned the key ahead of its own postmortem (B2), and the
 *   disjunction defeated both indexes into a seq scan (M1). The ranked tsv
 *   BODY tier that replaced it is gone too (#1273 fork F1): the issue-key
 *   shape is indistinguishable from ubiquitous technical compounds —
 *   SHA-256, UTF-8, ISO-8601, AES-256 — and a body-MENTION verification
 *   pinned an arbitrary mentioning page at rank 1 for any short query
 *   carrying one. No structural test separates INC-2203 from SHA-256, and
 *   a prefix denylist would be exactly the probabilistic guard this
 *   feature was designed to avoid. A title match means the page is NAMED
 *   by the key; a body match means someone mentioned it. Only the first
 *   earns rank 1, so a key living solely in body text now rides normal
 *   retrieval — recall this stage never promised, traded for the
 *   precision it did.
 * - title: the pg_trgm path, explicitly kind-gated — the old else-branch
 *   would have run a fuzzy TITLE match for a revived spaceKey (M4).
 */
async function lookupIdentifier(
  ident: DetectedIdentifier,
  spaces: string[],
  userId: string,
): Promise<SearchResult[]> {
  // The excerpt is sized to the SAME per-page budget assembled pages get
  // (#1273 fork F9). A new pin is the one row sibling assembly cannot
  // reach — it is created after that stage, and it has no anchor chunk to
  // grow a window around — so a hardcoded 500 chars gave the feature's
  // headline query ("find the page called X", the page missing from the
  // fused set) the thinnest context in the pipeline. Reading the same knob
  // keeps one operator dial over how much of a page reaches the model;
  // 0/off falls back to the old fixed lede rather than to nothing.
  const budget = await getRagContextCharsPerPage();
  const excerptChars = budget > 0 ? budget : PIN_EXCERPT_FALLBACK_CHARS;
  const select = `SELECT cp.id AS page_id, cp.confluence_id, cp.title, cp.space_key,
                         substring(cp.body_text, 1, $5) AS excerpt
                  FROM pages cp
                  WHERE ${visiblePagesPredicate(1, 3)} AND cp.deleted_at IS NULL`;
  type Row = { page_id: number; confluence_id: string | null; title: string; space_key: string | null; excerpt: string | null };
  const limit = IDENTIFIER_LOOKUP_CANDIDATES;
  let rows: Row[] = [];
  if (ident.kind === 'pageId') {
    const n = Number.parseInt(ident.value, 10);
    const fitsInt4 = Number.isFinite(n) && n <= 2_147_483_647;
    // Placeholders are renumbered per-branch: an UNREFERENCED parameter
    // cannot type-infer ("could not determine data type of parameter") and
    // kills the statement — the visibility fragment holds $1/$3.
    // NULLS LAST is load-bearing, not decoration. `cp.confluence_id = $2`
    // is NULL for a locally-created page, and Postgres sorts DESC as NULLS
    // FIRST — so the null (a PK match on a local page) outranked the TRUE
    // (the real confluence_id match), inverting the exact namespace
    // preference this ORDER BY exists to state.
    const r = fitsInt4
      ? await query<Row>(
          `${select} AND (cp.confluence_id = $2 OR cp.id = $4)
           ORDER BY (cp.confluence_id = $2) DESC NULLS LAST, cp.id ASC LIMIT $6`,
          [spaces, ident.value, userId, n, excerptChars, limit],
        )
      : await query<Row>(
          `${select} AND cp.confluence_id = $2 ORDER BY cp.id ASC LIMIT $4`,
          [spaces, ident.value, userId, limit, excerptChars],
        );
    rows = r.rows;
  } else if (ident.kind === 'issueKey') {
    // The key must match as a TOKEN, not a substring. `ILIKE '%INC-220%'`
    // matches every INC-2203 / INC-22030 page, and the starts-with
    // tiebreak then confidently picks one of them — a pin on a DIFFERENT
    // identifier, which is the failure this whole stage is meant to
    // prevent. The alternation is safe to interpolate because the detector
    // only ever emits [A-Z0-9-]+ (asserted below): no regex metacharacter
    // can reach here, and `-` is literal outside a bracket expression.
    // `~*` is still an index-usable operator for gin_trgm_ops.
    // The boundary rejects what CONTINUES an identifier and admits what
    // ENDS one, and both halves took measuring to get right.
    //
    // The classes are spelled ASCII, not [[:alnum:]]: under en_US.utf8 that
    // POSIX class matches CJK and Hangul, so `INC-2203対応手順` — a
    // perfectly ordinary title in a non-spaced script — was refused. Issue
    // keys are ASCII by construction, so an ASCII class is both correct
    // and narrower.
    //
    // The trailing rule is a lookahead rather than a class because `-` and
    // `.` only continue an identifier when a DIGIT follows: `INC-220-1`
    // and `PROJ-12.1` are sub-tasks (refuse), while `INC-7777-postmortem`
    // is the same ticket with a word suffix and `Root cause of INC-2203.`
    // simply ends a sentence (admit). Excluding either character outright
    // lost those, and both are ordinary title forms.
    if (!/^[A-Za-z0-9-]+$/.test(ident.value)) return [];
    const boundary = '(?![0-9A-Za-z_]|[.-][0-9])';
    const boundedKey = `(^|[^0-9A-Za-z._-])${ident.value}${boundary}`;
    const startsWithKey = `^${ident.value}${boundary}`;
    const titled = await query<Row>(
      `${select} AND cp.title ~* $2
       ORDER BY (cp.title ~* $4) DESC, length(cp.title) ASC, cp.id ASC LIMIT $6`,
      [spaces, boundedKey, userId, startsWithKey, excerptChars, limit],
    );
    rows = titled.rows;
  } else if (ident.kind === 'title') {
    // `%` narrows via the trigram index; normalised EQUALITY is what earns
    // the pin (see NORMALIZED_TITLE — no threshold separates a typo from a
    // sibling page in a versioned title family). Ordering is by id because
    // every survivor is an exact match; the candidate list plus the ACL
    // filter pick which same-titled page the caller may actually read.
    // The SAME expression over the column and over the raw parameter, so
    // the two cannot drift; translate() runs before the \s+ collapse
    // because Postgres's \s is ASCII-only.
    const r = await query<Row>(
      `${select} AND cp.title % $2
       AND ${NORMALIZED_TITLE('cp.title', '$6', '$7')} = ${NORMALIZED_TITLE('$2', '$6', '$7')}
       ORDER BY cp.id ASC LIMIT $4`,
      [spaces, ident.value, userId, limit, excerptChars, UNICODE_SPACES, UNICODE_SPACES_AS_PLAIN],
    );
    rows = r.rows;
  } else {
    // spaceKey (and any future kind) verifies nothing here by design — a
    // space is not a page, so there is nothing for THIS stage to pin. The
    // pin stage filters the kind out before it ever reaches this function,
    // so a space-key detection is currently INERT end to end: recognised,
    // then deliberately consumed by nobody.
    //
    // That is a decision, not a placeholder waiting on an issue. #1110 was
    // named here as the intended consumer and has since been CLOSED without
    // one being built — titles turned out to be near-invisible to retrieval,
    // so a dedicated title/space leg would act in a region nothing
    // downstream reads (the measurement is recorded under "No dedicated
    // title retrieval leg" in docs/architecture/09-flow-rag-chat.md).
    // Scoping or boosting retrieval by a detected space key is UNCLAIMED
    // work with no owner. Whoever picks it up should note it is probably a
    // filter on the visibility predicate rather than a pin: a space names a
    // collection, and this stage returns pages.
    return [];
  }
  return rows.map((row) => ({
    pageId: row.page_id,
    confluenceId: row.confluence_id,
    // Head-of-body excerpt — deliberately NOT sibling-assembled (assembly
    // ran before this stage; #1273 review M7 records the scope line): for
    // "find page X" the lede is the honest context, and an empty
    // body_text yields an empty excerpt under a real title.
    chunkText: row.excerpt ?? '',
    pageTitle: row.title,
    sectionTitle: row.title,
    spaceKey: row.space_key,
    // Ordering-only, like every other producer's score; pinned rows lead
    // by ARRAY position and consumers never re-sort.
    score: 0,
    vectorScore: null,
    keywordRank: null,
    pinned: true as const,
  }));
}

interface ImageLegRows {
  results: SearchResult[];
  /**
   * The lede fetch threw, so every image-ONLY page was dropped.
   *
   * It is OR'd into `deriveDegradedReason`'s image argument by the caller,
   * under this leg's own criterion: a bypass is recorded when it changes
   * which PAGES come back, and this one deletes exactly the pages the leg
   * exists to make retrievable. The leg still ran, so the pages the text legs
   * also found keep both their rank contribution and their `imageHits` — it
   * is a PARTIAL bypass, and `image_leg_unavailable` is the honest value for
   * it because the column has one slot and no finer vocabulary.
   */
  textFetchFailed: boolean;
}

/**
 * #1115 P3 — turn the image leg's page list into `SearchResult`s so the fusion
 * has one shape to work with.
 *
 * A page the text legs already found reuses THEIR row and only gains
 * `imageHits`: it has a measured `vectorScore` or `keywordRank`, a real
 * chunk, and an anchor for sibling assembly, and replacing any of that with a
 * synthetic row would trade evidence for nothing.
 *
 * A page reached ONLY by the image leg has no row at all, and every stage
 * after fusion reads `chunkText` — so without one it could not be reranked,
 * could not be diffed by MMR, and could not be put in front of the model. It
 * gets its `chunk_index 0` row: the page's own opening prose, which is the
 * honest lede for "this page contains the picture you asked about", and which
 * is text the page actually contains.
 *
 * When the page has NO chunk 0 — an image-only page under
 * `MIN_EMBEDDABLE_TEXT_CHARS`, invisible to both text legs today and the whole
 * reason this leg makes anything newly retrievable — `chunkText` is the TITLE,
 * flagged `imageTextSynthesized`. **P3 owns the consequence** (ADR-025 §5):
 * that text is what the cross-encoder scores and what MMR diffs, so a
 * title-only row will rank poorly under rerank and will look maximally
 * distinct under MMR. Both are acceptable and neither is silent: the row still
 * carries the page, the picture and a title a person can read, and it is
 * excluded from the confidence sample precisely because its "relevance" is a
 * measurement of a title we wrote rather than of the evidence that found it.
 *
 * ONE batched query for all image-only pages, on the main pool — a btree
 * lookup, like sibling assembly's, not a similarity scan.
 *
 * Visibility is NOT re-applied: these ids came out of `imageKnn`, which ran
 * `visiblePagesPredicate` in the same request, and the EE per-page ACL filter
 * runs over the fused set below exactly as it does for the text legs. Adding a
 * second predicate here would be a second place for the rule to drift.
 */
async function buildImageLegResults(
  pages: ImageLegPage[],
  vectorResults: SearchResult[],
  keywordResults: SearchResult[],
): Promise<ImageLegRows> {
  if (pages.length === 0) return { results: [], textFetchFailed: false };
  // Vector rows first — they arrive distance-ordered, so a page's first
  // occurrence is its best chunk, and a purpose-built chunk beats a keyword
  // body excerpt (the preference `reciprocalRankFusion` already states).
  // Keyword rows then fill only the pages the vector leg did not reach.
  const byPage = new Map<number, SearchResult>();
  for (const r of vectorResults) if (!byPage.has(r.pageId)) byPage.set(r.pageId, r);
  for (const r of keywordResults) if (!byPage.has(r.pageId)) byPage.set(r.pageId, r);

  const missing = pages.filter((p) => !byPage.has(p.pageId)).map((p) => p.pageId);
  const synthesized = new Map<number, SearchResult>();
  let textFetchFailed = false;
  if (missing.length > 0) {
    try {
      const rows = await query<{
        page_id: number;
        confluence_id: string | null;
        title: string;
        space_key: string | null;
        chunk_text: string | null;
        section_title: string | null;
      }>(
        `SELECT cp.id AS page_id, cp.confluence_id, cp.title, cp.space_key,
                pe.chunk_text,
                pe.metadata->>'section_title' AS section_title
           FROM pages cp
           LEFT JOIN page_embeddings pe ON pe.page_id = cp.id AND pe.chunk_index = 0
          WHERE cp.id = ANY($1::int[])`,
        [missing],
      );
      for (const row of rows.rows) {
        const fromChunk = row.chunk_text !== null && row.chunk_text.length > 0;
        synthesized.set(row.page_id, {
          pageId: row.page_id,
          confluenceId: row.confluence_id,
          chunkText: fromChunk ? row.chunk_text! : row.title,
          pageTitle: row.title,
          sectionTitle: (fromChunk ? row.section_title : null) ?? row.title,
          spaceKey: row.space_key,
          // Ordering-only, like every other producer's `score`: the fusion
          // overwrites it, and nothing measured this page's text.
          score: 0,
          // Both null, and that is the point: an image hit establishes neither
          // basis, so this row can never lift or lower #1105's confidence.
          vectorScore: null,
          keywordRank: null,
          imageOnly: true as const,
          // `chunkIndex` is deliberately left UNSET even for the chunk-0 case.
          // Its contract is "the chunk the VECTOR leg matched", and it is the
          // sibling-assembly anchor; an image-reached page has no matched
          // chunk, so anchoring a window on an arbitrary chunk 0 would claim a
          // measurement that was never taken.
          ...(fromChunk ? {} : { imageTextSynthesized: true as const }),
        });
      }
    } catch (err) {
      // Soft-fail like every neighbouring stage — but note what it costs: the
      // pages that DO have a text row still fuse, and only the image-only ones
      // drop out. A retrieval is never worth failing over a lede fetch.
      //
      // It is REPORTED, though, and that is not the same call as soft-failing.
      // Dropping the image-only pages changes which pages come back, which is
      // the exact criterion this leg records a bypass on at all — leaving it
      // silent wrote a healthy analytics row for a request that lost every
      // newly-retrievable page.
      textFetchFailed = true;
      logger.warn(
        { err },
        'Image-only text fetch failed — those pages are dropped from the image leg (degraded_reason: image_leg_unavailable)',
      );
    }
  }

  const out: SearchResult[] = [];
  for (const page of pages) {
    const base = byPage.get(page.pageId) ?? synthesized.get(page.pageId);
    if (!base) continue;
    // `imageRawIndex` rides along for `fuseWithStableHead`'s narrow
    // reconstruction alone; see its JSDoc on `SearchResult`.
    out.push({ ...base, imageHits: page.hits, imageRawIndex: page.bestRawIndex });
  }
  return { results: out, textFetchFailed };
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
  // #1112: a caller-supplied pool REPLACES the configured one, through the
  // operator's own clamp — a per-request option must not be able to ship more
  // documents to the rerank provider (and, under EE ACL, more access checks)
  // than `rag_rerank_candidates`' ceiling allows, and must be able to ship
  // FEWER when one gesture fans out into several concurrent searches.
  const rerankCandidatesPromise = opts?.rerank
    ? opts.rerankCandidatesOverride === undefined
      ? getRagRerankCandidates()
      : Promise.resolve(
          Math.min(
            Math.max(opts.rerankCandidatesOverride, RAG_RERANK_CANDIDATES_MIN),
            RAG_RERANK_CANDIDATES_MAX,
          ),
        )
    : Promise.resolve(0);
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
    keywordSearch(userId, question, stageLimit, { spaceKey: opts?.spaceKey }),
  );
  // Observe the promise so a rejection can never go unhandled if the embedding
  // path short-circuits (e.g. rethrowing CircuitBreakerOpenError) before the
  // `await keywordPromise` below runs. This no-op observer does not consume the
  // result — the await at the end still throws/propagates in the normal path.
  keywordPromise.catch(() => {});

  // ── Image leg (#1115 P3) ───────────────────────────────────────────────
  // Started HERE, beside the keyword leg and before the text embed, so its
  // one VL request overlaps the two text legs instead of adding to them: the
  // cost a question pays is `max(text, image) - text`, not the image leg's
  // whole latency. BOTH of its stages carry a budget, and they are separate
  // numbers rather than one — `IMAGE_LEG_TIMEOUT_MS` (3s) on the embed and
  // `IMAGE_LEG_KNN_TIMEOUT_MS` (2s, a `SET LOCAL statement_timeout`) on the
  // kNN, which compose to a ~5s worst case for this await. The kNN needs its
  // own because it is not always cheap: above 4000 dimensions the index is
  // deliberately absent and the scan is sequential. The gate inside it means
  // a deployment with no VL model spends one cached boolean and one indexed
  // assignment lookup on this line — the non-empty-index EXISTS is BEHIND
  // that lookup and is never reached until a model is assigned (see the
  // gate's own header for the order and why).
  //
  // What it also spends, on every hybrid search that reaches the kNN, is a
  // SECOND concurrent connection from the vector pool (`PG_VECTOR_POOL_MAX`,
  // default 5) — the leg is started HERE precisely so its transaction overlaps
  // `vectorSearch`'s. That halves the pool's effective per-request headroom,
  // and the two legs are not equally forgiving about losing the race: a
  // connect timeout inside the image leg is a bypass, while one inside the try
  // below sets `embeddingFailed` and `/llm/ask` refuses the turn. Raise
  // `PG_VECTOR_POOL_MAX` when enabling the leg on a busy instance (runbook §6).
  //
  // `searchImageLeg` never rejects — every failure is a bypass it reports on
  // the outcome. The `.catch` covers the chain in FRONT of it (`stageLimit`
  // resolves the width and the rerank assignment): a rejection there is a
  // failure of the search proper, which the awaits below will surface, and
  // this handler exists so it does so instead of becoming an unhandled
  // rejection on a promise nobody has awaited yet.
  const imageLegPromise: Promise<ImageLegOutcome> = stageLimitPromise
    .then((stageLimit) =>
      searchImageLeg(userId, question, {
        limit: stageLimit,
        spaceKey: opts?.spaceKey,
        imageLeg: opts?.imageLeg,
      }),
    )
    .catch(() => ({ ran: false, failed: false, pages: [] }));

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
    // #1114: instruction-aware models (Qwen3) want a preamble on the QUERY and
    // nothing on the document. This is one of the app's TWO query-side
    // embedding calls — `routes/knowledge/search.ts` is the other, embedding
    // the query itself for `mode=semantic` instead of coming through here — and
    // both apply the asymmetry. `query-instruction.test.ts` enumerates both,
    // and every document-side call site, and asserts on each `generateEmbedding`
    // CALL rather than on the file — so neither a third path nor a second,
    // unprefixed embed added right here can pick up either policy by omission.
    // It is a no-op for every model that is not
    // instruction-aware, so it runs unconditionally rather than behind a second
    // flag that could drift out of step with the resolved model.
    //
    // Keyed off the RESOLVED model, so it turns on exactly when a swap makes
    // Qwen3 live and back off on a rollback, with no separate setting to
    // remember. Documents are embedded bare under every model, so the stored
    // corpus is identical either way and flipping this needs no re-embed.
    const embeddings = await generateEmbedding(
      config, model, formatQueryForEmbedding(model, question),
    );
    const questionEmbedding = embeddings[0]!;
    vectorResults = await vectorSearch(userId, questionEmbedding, await stageLimitPromise, { spaceKey: opts?.spaceKey });
  } catch (err) {
    // Let circuit breaker errors propagate for proper 503 handling
    if (err instanceof CircuitBreakerOpenError) {
      throw err;
    }
    embeddingFailed = true;
    // One catch covering three stages is deliberate — a missing `embedding`
    // assignment, a provider 5xx/timeout/still-loading model, and a pgvector
    // dimension mismatch all leave the caller in the same position (no vector
    // leg), and which stage threw is in `err`. What CALLERS do about it is no
    // longer "carry on quietly": `/llm/ask` refuses the turn on this verdict
    // (its honest-refusal gate) and `/api/search` renders `degradedReason`.
    // Only the SEARCH degrades to keyword-only; the ANSWER does not — which
    // is why this no longer says "falling back".
    logger.warn(
      { err },
      'Embedding failed — vector leg down, keyword leg only (degraded_reason: embedding_failed)',
    );
  }

  const keywordResults = await keywordPromise;
  const coverage = await coveragePromise;
  const imageLegOutcome = await imageLegPromise;
  // The image leg's rows become SearchResults BEFORE fusion, so nothing
  // downstream needs an image-specific branch (ADR-025 §5): rerank, the
  // ranking prior, MMR, sibling assembly and the pin stage all keep scoring
  // `chunkText` exactly as they do today.
  const { results: imageResults, textFetchFailed } = await buildImageLegResults(
    imageLegOutcome.pages, vectorResults, keywordResults,
  );
  // Two ways the leg can fail to deliver its pages, one column: the leg itself
  // (embed, kNN or a gate read that threw) and the lede fetch that turns its
  // image-only pages into rows. Both change which pages come back.
  const degradedReason = deriveDegradedReason(
    embeddingFailed, coverage, imageLegOutcome.failed || textFetchFailed,
  );
  const analyticsExtras: SearchAnalyticsExtras = {
    degradedReason,
    embeddingCoverage: coverage?.coverage ?? null,
  };
  // Distinguish keyword-fallback (vector leg contributed nothing) from true
  // hybrid; `degraded_reason` in the extras records WHY (#1117). Derived once
  // so the two ACL branches below can never disagree.
  const searchType: SearchAnalyticsType =
    vectorResults.length === 0 && keywordResults.length > 0 ? 'keyword_fallback' : 'hybrid';

  // Row count and distinct-page yield — see the same pair in vectorSearch
  // (#1269 review m12: `hits <= limit` stopped holding when hits became
  // chunk rows over a fanned-out window).
  span?.setAttribute('rag.vector_hits', vectorResults.length);
  span?.setAttribute('rag.vector_pages', countDistinctPages(vectorResults));
  span?.setAttribute('rag.keyword_hits', keywordResults.length);
  // #1115 P3. Absence means the leg did not run at all (off, unassigned or an
  // empty index) — a trace has to separate "the leg found nothing" from "there
  // is no leg here", which is the distinction a zero would erase.
  if (imageLegOutcome.ran) {
    span?.setAttribute('rag.image_pages', imageResults.length);
    span?.setAttribute('rag.image_only_pages', imageResults.filter((r) => r.imageOnly).length);
  }
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
  const merged = fuseWithStableHead(
    vectorResults, keywordResults, await fetchWidthPromise, imageResults,
  );

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
  let aclEmptied = false;
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
    aclEmptied = merged.length > 0 && candidates.length === 0;
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

  // ── Quality / recency prior (#1111) ────────────────────────────────────
  // BEFORE rerank on purpose: this nudges the order the cross-encoder then
  // judges, so #1104 can overrule it on relevance grounds. Applying it after
  // rerank would override the epic's biggest measured win.
  //
  // Signals are fetched here in ONE batched query rather than joined into
  // the hot retrieval SQL, which keeps Postgres the source of truth (the
  // issue's note that a vector payload goes stale) and leaves both legs
  // untouched. Demote-only, and an UNSCORED page is neutral — never
  // penalised — because unscored correlates with recently synced rather
  // than with bad.
  if (candidates.length > 1) {
    try {
      const priorWeight = await getRagRankingPriorWeight();
      if (priorWeight > 0) {
        const signalRows = await query<{ id: number; quality_score: number | null; last_modified_at: Date | null }>(
          `SELECT id, quality_score, last_modified_at FROM pages WHERE id = ANY($1::int[])`,
          [candidates.map((c) => c.pageId)],
        );
        const byId = new Map(signalRows.rows.map((r) => [r.id, r]));
        const before = candidates.map((c) => c.pageId);
        candidates = applyRankingPrior(
          candidates,
          (r) => {
            const row = byId.get(r.pageId);
            return { qualityScore: row?.quality_score ?? null, lastModifiedAt: row?.last_modified_at ?? null };
          },
          { weight: priorWeight },
        );
        const moved = candidates.some((c, i) => c.pageId !== before[i]);
        span?.setAttribute('rag.ranking_prior', moved ? 'reordered' : 'no_change');
      } else {
        span?.setAttribute('rag.ranking_prior', 'off');
      }
    } catch (err) {
      // Soft-fail like every neighbouring stage: a ranking preference is
      // never worth failing a retrieval over.
      logger.warn({ err }, 'Ranking prior bypassed — serving the fused order');
      span?.setAttribute('rag.ranking_prior', 'bypassed');
    }
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
  // The best row available for each page BEFORE the topK slice, used only
  // by the pin stage's enriched-row recovery. It starts as the fused
  // candidates and is upgraded to the reranked pool when that stage runs —
  // otherwise recovering a page from `candidates` silently hands back the
  // pre-rerank object, and the recovery's own comment would be claiming a
  // rerankScore it dropped (the scored entries are new objects; the
  // rerank stage never mutates `candidates`).
  let enrichedPool: SearchResult[] = candidates;
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
      const reranked = [...scoredEntries, ...unscored];
      enrichedPool = reranked;
      topResults = reranked.slice(0, Math.max(0, topK));
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

  // ── MMR diversity narrow (#1109) ───────────────────────────────────────
  // AFTER the ranking stages and BEFORE assembly, so a page this drops never
  // costs a sibling-window fetch. It re-orders results that are already
  // relevant; it never adds one, and it never moves the head.
  //
  // Default OFF, and honestly so: this is a CONTEXT-BUDGET optimisation, not
  // a recall one. Measured on a corpus authored to crowd results with
  // near-duplicates, retrieval still ranks the expected page first every
  // time, so MMR cannot convert a miss into a hit. What it removes is the
  // model being handed the same runbook five times — 53% of the returned
  // slots on those queries were near-duplicates of a higher-ranked result.
  //
  // The narrow runs over the PRE-SLICE pool so it has something to choose
  // from: narrowing an already-sliced topK could only reorder it.
  if (topResults.length > 0) {
    try {
      const mmr = opts?.mmr
        ? { enabled: opts.mmr.enabled, lambda: opts.mmr.lambda ?? RAG_MMR_LAMBDA_DEFAULT }
        : await getRagMmrConfig();
      if (mmr.enabled && mmr.lambda < 1) {
        // Oversample to 2xK and narrow to K — the width the issue specifies,
        // and it is load-bearing rather than arbitrary. An earlier version
        // narrowed over the WHOLE reranked pool (up to rag_rerank_candidates,
        // default 30). Measured live, that lost 3 queries at lambda 0.5:
        // a 30-wide pool hands MMR far-away candidates whose only virtue is
        // being different, and promoting one of those can push the correct
        // answer out of topK. At 2xK every candidate is still a plausible
        // answer, so diversity chooses among near-peers instead of reaching
        // for strangers. The simulation that tuned lambda used a 10-wide pool
        // and therefore measured the SPECIFIED design while the code did
        // something else — the gap between them is what exposed this.
        const pool = (enrichedPool.length > topResults.length ? enrichedPool : topResults)
          .slice(0, Math.max(topK * 2, topResults.length));
        const narrowed = selectDiverse(pool, { lambda: mmr.lambda, k: Math.min(topK, topResults.length) });
        if (narrowed.length > 0) {
          topResults = narrowed;
          span?.setAttribute('rag.mmr', 'applied');
          span?.setAttribute('rag.mmr_lambda', mmr.lambda);
        }
      } else {
        span?.setAttribute('rag.mmr', mmr.enabled ? 'lambda_off' : 'off');
      }
    } catch (err) {
      // Soft-fail like every neighbouring stage: a diversity preference is
      // never worth failing a retrieval over.
      logger.warn({ err }, 'MMR narrow bypassed — serving the ranked order');
      span?.setAttribute('rag.mmr', 'bypassed');
    }
  }

  // ── Sibling-chunk context assembly (#1106 PR 2) ────────────────────────
  // AFTER the topK slice (work only for survivors) and BEFORE analytics,
  // the confidence computation and onRetrievalMeta — so the trace, the
  // route gate and the meta all see the final shape, and because assembly
  // touches no ranking or score field the confidence verdict is identical
  // either way. The fetch runs on the MAIN pool (a plain btree lookup —
  // the vector pool is reserved for similarity queries) against the
  // (page_id, chunk_index) unique index, and it is BOUNDED AND ANCHORED
  // (#1270 review F2): only rows that carry a resolvable anchor
  // participate, and per page only chunk_index within ±SIBLING_FETCH_SPAN
  // of the anchor is fetched — an unbounded per-page fetch shipped every
  // chunk of an 82 KB page to keep ~6000 chars, and on a keyword_fallback
  // outage fetched everything to assemble nothing. The anchor's TEXT is
  // verified against the retrieval row (#1270 review F3): a positional
  // check alone let a mid-request re-embed that kept enough chunks pass,
  // assembling unmeasured content under the old chunk's labels. Soft-fail
  // is the house pattern: any error keeps chunk-level rows; per-page empty
  // or mismatched sibling sets degrade only that page.
  if (opts?.assembleContext && topResults.length > 0) {
    try {
      const budget = await getRagContextCharsPerPage();
      if (budget <= 0) {
        // 'off' is distinct from 'bypassed' (error), 'none' (ran, nothing
        // assembled) and from the attribute being ABSENT (flag never
        // passed) — a trace must distinguish config from failure from
        // outcome from not-requested (#1270 reviews m4 + F6).
        span?.setAttribute('rag.page_merge', 'off');
      }
      if (budget > 0) {
        const assembleStarted = performance.now();
        let assembledPages = 0;
        const anchored = topResults.filter((r) => r.chunkIndex !== undefined);
        if (anchored.length > 0) {
          const siblings = await query<{
            page_id: number;
            chunk_index: number;
            chunk_text: string;
            section_title: string | null;
          }>(
            `SELECT pe.page_id, pe.chunk_index, pe.chunk_text,
                    pe.metadata->>'section_title' AS section_title
             FROM page_embeddings pe
             JOIN unnest($1::int[], $2::int[]) AS a(page_id, anchor)
               ON pe.page_id = a.page_id
             WHERE pe.chunk_index BETWEEN a.anchor - $3 AND a.anchor + $3
             ORDER BY pe.page_id, pe.chunk_index`,
            [anchored.map((r) => r.pageId), anchored.map((r) => r.chunkIndex!), SIBLING_FETCH_SPAN],
          );
          const byPage = new Map<number, { chunkIndex: number; chunkText: string; sectionTitle: string | null }[]>();
          for (const row of siblings.rows) {
            let list = byPage.get(row.page_id);
            if (!list) {
              list = [];
              byPage.set(row.page_id, list);
            }
            list.push({ chunkIndex: row.chunk_index, chunkText: row.chunk_text, sectionTitle: row.section_title });
          }
          topResults = topResults.map((r) => {
            if (r.chunkIndex === undefined) return r;
            const sibs = byPage.get(r.pageId) ?? [];
            // F3: the anchor must still BE the text retrieval scored — a
            // re-embed between the candidate query and this fetch (its own
            // atomic transaction, but up to the rerank budget later) can
            // reassign chunk_index over different content.
            const anchorSib = sibs.find((c) => c.chunkIndex === r.chunkIndex);
            if (!anchorSib || anchorSib.chunkText !== r.chunkText) return r;
            const window = assembleSiblingWindow(sibs, r.chunkIndex, budget);
            if (window === null) return r;
            assembledPages++;
            return {
              ...r,
              contextText: window.text,
              mergedChunkCount: window.mergedChunkCount,
              contextSpansSections: window.spansSections,
            };
          });
        }
        // 'assembled' means pages actually gained context — not "the query
        // did not throw" (#1270 review F6). The count answers "how many".
        span?.setAttribute('rag.page_merge', assembledPages > 0 ? 'assembled' : 'none');
        span?.setAttribute('rag.page_merge_pages', assembledPages);
        recordHistogram(
          RETRIEVAL_STAGE_DURATION_METRIC,
          performance.now() - assembleStarted,
          { stage: 'page_merge' },
          STAGE_DURATION_OPTS,
        );
      }
    } catch (err) {
      logger.warn({ err }, 'Sibling assembly bypassed — serving chunk-level context');
      span?.setAttribute('rag.page_merge', 'bypassed');
    }
  }

  // ── Exact-identifier pin stage (#1107) ────────────────────────────────
  // AFTER rerank + assembly and BEFORE analytics/confidence/meta, so every
  // observer sees the final shape. Detection is pure and guarded
  // (identifier-shortcircuit.ts); every detection is VERIFIED by an indexed
  // lookup under the same space-visibility predicate as retrieval, and
  // under EE ACL via the same batched filter. A verified page already in
  // the fused set is MOVED to the front keeping its enriched row (assembled
  // context included); a new one enters as a keyword-style excerpt row.
  // At most two pins; the tail shrinks via the same topK slice; the fused
  // order below the pins is never re-sorted. Space-key detections verify
  // nothing here by design — a space is not a page (design of record).
  //
  // #1351: `lookupIdentifier`'s SQL is NOT space-scoped — unlike the vector
  // and keyword legs, it has no `opts.spaceKey` predicate, because its
  // candidate list already carries `spaceKey` on every row and the ACL
  // post-filter below is the established pattern for narrowing that list
  // after the query runs, not inside it. `inScope` applies the same
  // narrowing the same way. No caller combines `pinIdentifiers` with
  // `spaceKey` today (`/api/search` never requests pins; `/llm/ask` and deep
  // search never scope by space), so this is a latent guarantee, not yet an
  // observable behavior — kept true anyway so a future caller (deep search
  // already spreads `...opts` into `hybridSearch`) can't silently resurface
  // an out-of-scope page through this leg while the other two are honored.
  if (opts?.pinIdentifiers && (await getRagPinIdentifiersEnabled())) {
    try {
      const detected = detectIdentifiers(question).filter((d) => d.kind !== 'spaceKey');
      if (detected.length > 0) {
        const pinSpaces = await getUserAccessibleSpaces(userId);
        // Per-lookup isolation (#1273 fork F8): the stage's contract is
        // "any lookup error skips THAT pin, never the search", and a
        // single try around the loop broke it — one failing detection
        // discarded a second, independently verified one.
        const lookedUp: SearchResult[][] = [];
        for (const ident of detected) {
          try {
            lookedUp.push(await lookupIdentifier(ident, pinSpaces, userId));
          } catch (err) {
            logger.warn({ err, kind: ident.kind }, 'Identifier lookup failed — skipping this pin');
          }
        }
        // ACL BEFORE the winner is chosen (#1273 fork F5), still one
        // batched query for every candidate of every detection.
        let isAccessible: (pageId: number) => boolean = () => true;
        if (aclEnforced) {
          const candidateIds = lookedUp.flat().map((r) => r.pageId);
          if (candidateIds.length > 0) {
            const accessible = await filterAccessiblePages(userId, candidateIds);
            isAccessible = (pageId) => accessible.has(pageId);
          }
        }
        // #1351: same narrow-only contract as the two legs — a candidate
        // outside the requested space is never a valid pin, whether or not
        // it is otherwise accessible.
        const inScope = (r: SearchResult): boolean => !opts.spaceKey || r.spaceKey === opts.spaceKey;
        // Each detection contributes AT MOST ONE pin, and never a
        // substitute. Sliding past an already-pinned page to the next
        // candidate looks like de-duplication and is not: the second row
        // is a different page that merely also matched — another page
        // sharing the title, or another page whose title carries the key —
        // so one user gesture producing two detections of the same page
        // would pin an unrelated one beneath it, labelled a verified exact
        // match, ahead of every fused result. Take the best accessible,
        // in-scope candidate; if it is already pinned, this detection has
        // nothing left to say.
        const verified: SearchResult[] = [];
        for (const candidateRows of lookedUp) {
          const pick = candidateRows.find((c) => isAccessible(c.pageId) && inScope(c));
          if (pick && !verified.some((v) => v.pageId === pick.pageId)) verified.push(pick);
        }
        if (verified.length > 0) {
          const pinnedIds = new Set(verified.map((r) => r.pageId));
          const head: SearchResult[] = verified.map((v) => {
            // topResults FIRST (it alone carries assembled context), then
            // the pre-slice pool (#1273 fork F12): a verified page that
            // fused just OUTSIDE topK — the diluted-exact-match case this
            // feature exists for — used to lose its scored chunk,
            // chunkIndex and rerankScore and re-enter as a bare excerpt,
            // while the purpose-built row sat one array away. `enrichedPool`
            // is the RERANKED pool where that stage ran, so the recovered
            // row keeps its relevance score; `candidates` is the last
            // resort for a page beyond the rerank pool entirely.
            const existing =
              topResults.find((r) => r.pageId === v.pageId) ??
              enrichedPool.find((r) => r.pageId === v.pageId) ??
              candidates.find((r) => r.pageId === v.pageId);
            return existing ? { ...existing, pinned: true as const } : v;
          });
          topResults = [...head, ...topResults.filter((r) => !pinnedIds.has(r.pageId))].slice(0, Math.max(0, topK));
          span?.setAttribute('rag.pinned', verified.length);
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Identifier pin stage bypassed — serving the fused order');
    }
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
  // the ef_search floor always carried, and since #1285 that one is a knob on
  // the same panel.
  // Pinned NEW rows carry score 0 (never a fused value); excluding them
  // keeps max_score's unit contract and stops a pinned-only head writing
  // 0 into the knowledge-gap predicate's range (#1273 review M8). Moved
  // pins keep their fused score and stay in the sample.
  const scoreRows = topResults.filter((r) => r.pinned === undefined || r.vectorScore !== null || r.keywordRank !== null);
  const maxScore = scoreRows.length > 0 ? Math.max(...scoreRows.map((r) => r.score)) : null;
  // #1112: a deep-search leg suppresses this row — see
  // HybridSearchOptions.recordAnalytics. The wrapper records one row for the
  // merged set, so one user gesture stays one row and no model-invented
  // paraphrase is ever filed as a user query.
  if (opts?.recordAnalytics !== false) {
    trackSearchAnalytics(userId, question, topResults.length, maxScore, searchTypeFinal, {
      ...analyticsExtras,
      rerankScore: rerankMax,
    });
  }

  // Retrieval confidence on the trace (#1268 review: the docs promised
  // "logs/traces" and only the log existed). Computed here with the same
  // health caveat the route's gate uses, so the two can never disagree.
  // `coverage === null` covers both a failed self-probe and a failed probe
  // handed over by /api/search (its `null` means "mine already failed").
  // #1115 P3: `image_leg_unavailable` reaches this line like any other
  // degraded reason, and shadows 'coverage_unknown' when the coverage probe
  // ALSO failed. That is deliberate and inert: `computeRetrievalConfidence`
  // reads this field only as null-vs-non-null (the empty-set branch), so the
  // verdict is identical either way, and the coverage reading travels beside
  // it on both the log line and the analytics row. What it must NOT become is
  // a refusal input — the ask route special-cases `embedding_failed` alone,
  // and an image leg that fell over is not an outage of the index the answer
  // is grounded in.
  const healthCaveat: RetrievalHealthCaveat | null =
    degradedReason ?? (coverage === null ? 'coverage_unknown' : null);
  const confidence = computeRetrievalConfidence(topResults, healthCaveat);
  if (confidence.score !== null) {
    span?.setAttribute('rag.confidence', confidence.score);
  }
  span?.setAttribute('rag.confidence_basis', confidence.basis);

  // Guarded: the callback is a caller-supplied observer running mid-request;
  // a throwing consumer must not turn a completed retrieval into a 500 with
  // no analytics row.
  try {
    opts?.onRetrievalMeta?.({
      degradedReason,
      healthCaveat,
      searchType: searchTypeFinal,
      embeddingCoverage: coverage?.coverage ?? null,
      aclEmptied,
    });
  } catch (err) {
    logger.warn({ err }, 'onRetrievalMeta observer threw — ignored');
  }

  return topResults;
}

// Moved to its own dependency-free leaf module so route suites can keep it
// REAL under a closed-list rag-service stub (#1268 review). Re-exported here
// so service-side callers and existing tests keep their import path.
export {
  computeRetrievalConfidence,
  type RetrievalConfidence,
  type RetrievalHealthCaveat,
} from './retrieval-confidence.js';

/**
 * Build a RAG context prompt from search results.
 */
export function buildRagContext(results: SearchResult[]): string {
  if (results.length === 0) {
    return 'No relevant context found in the knowledge base.';
  }

  return results
    .map((r, i) => {
      // #1106 PR 2: prefer the assembled sibling window, and drop the
      // `Section:` clause when it spans sections — a single section label
      // must not claim multi-section text (the design round's honest-header
      // graft). Markdown headings inside the merged text carry the internal
      // structure since #1265.
      //
      // NOT sanitized here (#1270 re-verification N4+N5): the route
      // sanitizes the FULL assembled KB context — this output plus the
      // sub-page tree — in one pass, so detections reach the injection
      // attestation flags and the audit log instead of dying in a
      // domain-level logger.warn. Keeping this function pure is what makes
      // that single route-level pass complete.
      const body = r.contextText ?? r.chunkText;
      const multiSection = r.contextSpansSections === true;
      const header = multiSection
        ? `[Source ${i + 1}: "${r.pageTitle}" (Space: ${r.spaceKey || 'Local'})]`
        : `[Source ${i + 1}: "${r.pageTitle}" (Space: ${r.spaceKey || 'Local'}, Section: ${r.sectionTitle})]`;
      return `${header}\n${body}`;
    })
    .join('\n\n---\n\n');
}

export { reciprocalRankFusion, rrfWorstCase };
export type { SearchResult };
