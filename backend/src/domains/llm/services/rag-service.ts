import { query, getVectorPool } from '../../../core/db/postgres.js';
import { resolveUsecase } from './llm-provider-resolver.js';
import { generateEmbedding } from './openai-compatible-client.js';
// Use the request-scoped memoised wrapper so a single hybrid request resolves
// the readable-space set once across vectorSearch + keywordSearch. See ADR-022.
import {
  getUserAccessibleSpacesMemoized as getUserAccessibleSpaces,
  userCanAccessPage,
} from '../../../core/services/rbac-service.js';
import { CircuitBreakerOpenError } from '../../../core/services/circuit-breaker.js';
import { getFtsLanguage } from '../../../core/services/fts-language.js';
import { visiblePagesPredicate } from '../../../core/services/page-visibility.js';
import { isFeatureEnabled } from '../../../core/enterprise/loader.js';
import { ENTERPRISE_FEATURES } from '../../../core/enterprise/features.js';
import pgvector from 'pgvector';
import { logger } from '../../../core/utils/logger.js';

// Configurable ef_search: higher = better recall, slower query.
// Default 100 provides good recall/latency tradeoff for ~10K embeddings.
const parsed = parseInt(process.env.RAG_EF_SEARCH ?? '100', 10);
const RAG_EF_SEARCH = Number.isFinite(parsed) && parsed > 0 && parsed <= 10000 ? parsed : 100;

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
   * worst case is therefore a function of the per-stage limit, and it is easy to
   * underestimate — `rrfWorstCase` below computes it, and a test pins the two
   * figures that matter rather than leaving them as prose:
   *
   * - chat path (`/llm/ask`, topK 5 → stage limit 10, or 8 under EE ACL):
   *   at most ~0.17, comfortably under ConfidenceBadge's 0.4 threshold, which
   *   is why reading this field as a cosine produced "Low confidence" every time.
   * - `/api/search` under EE ACL with `limit=20` → stage limit 30: up to ~0.42,
   *   which is **over** that threshold. Nothing thresholds it on that path, but
   *   do not restate the chat-path bound as a global one.
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
   */
  keywordRank: number | null;
}

/**
 * Vector search: cosine similarity on page_embeddings.
 * Sets hnsw.ef_search for this transaction to improve recall.
 * Scoped to: Confluence pages in user's selected spaces + standalone articles
 * the user can access (shared, or private and owned by the user).
 *
 * Tradeoff: higher ef_search = better recall but slower query.
 * Default PostgreSQL ef_search is 40; we use 100 for better RAG recall.
 */
export async function vectorSearch(userId: string, questionEmbedding: number[], limit = 10): Promise<SearchResult[]> {
  const vecSpaces = await getUserAccessibleSpaces(userId);
  // Use the dedicated vector pool so long-running similarity queries
  // do not starve the main pool used by CRUD routes.
  const client = await getVectorPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL hnsw.ef_search = ${Number(RAG_EF_SEARCH)}`);

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

    return result.rows.map((row) => ({
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
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Keyword search: PostgreSQL full-text search on pages.
 * Scoped to: Confluence pages in user's selected spaces + standalone articles
 * the user can access (shared, or private and owned by the user).
 */
export async function keywordSearch(userId: string, questionText: string, limit = 10): Promise<SearchResult[]> {
  // Use plainto_tsquery which safely handles arbitrary user input
  // (no need to manually sanitize or construct tsquery syntax)
  const trimmed = questionText.trim();
  if (!trimmed) return [];

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
            substring(cp.body_text, 1, 500) as body_text,
            ts_rank(cp.tsv, plainto_tsquery('${ftsLang}', $2)) AS rank
     FROM pages cp
     WHERE cp.tsv @@ plainto_tsquery('${ftsLang}', $2)
       AND ${visiblePagesPredicate(1, 4)}
       AND cp.deleted_at IS NULL
     ORDER BY rank DESC
     LIMIT $3`,
    [kwSpaces, trimmed, limit, userId],
  );

  return result.rows.map((row) => ({
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
 * Record a search analytics event.
 */
export async function recordSearchAnalytics(
  userId: string,
  queryText: string,
  resultCount: number,
  maxScore: number | null,
  searchType: string,
): Promise<void> {
  try {
    await query(
      `INSERT INTO search_analytics (user_id, query, result_count, max_score, search_type)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, queryText, resultCount, maxScore, searchType],
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
  searchType: string,
): void {
  const p = recordSearchAnalytics(userId, queryText, resultCount, maxScore, searchType)
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
export async function hybridSearch(
  userId: string,
  question: string,
  topK = 5,
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

  // Overfetch compensation: when the ACL post-filter is active, some
  // candidates will be dropped. Bump the per-stage candidate pool by 1.5x
  // (rounded up) so the post-filter has headroom to still return `topK`
  // rows. When the flag is OFF we preserve v0.3 behaviour exactly — the
  // default per-stage limit (10) kicks in because we pass `undefined`.
  const stageLimit = aclEnforced ? Math.ceil(topK * 1.5) : undefined;

  let vectorResults: SearchResult[] = [];

  // Start keyword search outside the try block so DB errors in keyword
  // search are not silently caught as "embedding failures".
  const keywordPromise = keywordSearch(userId, question, stageLimit);
  // Observe the promise so a rejection can never go unhandled if the embedding
  // path short-circuits (e.g. rethrowing CircuitBreakerOpenError) before the
  // `await keywordPromise` below runs. This no-op observer does not consume the
  // result — the await at the end still throws/propagates in the normal path.
  keywordPromise.catch(() => {});

  try {
    // Resolve the `embedding` use-case to the provider+model that generated
    // the stored embeddings, so query-time embedding stays compatible.
    const { config, model } = await resolveUsecase('embedding');
    const embeddings = await generateEmbedding(config, model, question);
    const questionEmbedding = embeddings[0]!;
    vectorResults = await vectorSearch(userId, questionEmbedding, stageLimit);
  } catch (err) {
    // Let circuit breaker errors propagate for proper 503 handling
    if (err instanceof CircuitBreakerOpenError) {
      throw err;
    }
    logger.warn({ err }, 'Embedding failed, falling back to keyword-only');
  }

  const keywordResults = await keywordPromise;

  logger.debug({
    vectorHits: vectorResults.length,
    keywordHits: keywordResults.length,
  }, 'Search results');

  // Combine with RRF — output is already one entry per pageId.
  const merged = reciprocalRankFusion(vectorResults, keywordResults);

  // Per-page ACL post-filter: when enabled, drop candidates the caller can
  // no longer read (Confluence restriction added between sync and query,
  // ACE synced for a page whose space the user lost access to, etc.). The
  // filter preserves RRF rank order — `userCanAccessPage` is O(small) and
  // runs N≤ceil(topK*1.5) times, which is acceptable per plan §2.
  if (aclEnforced) {
    const filtered: SearchResult[] = [];
    for (const r of merged) {
      if (await userCanAccessPage(userId, r.pageId)) {
        filtered.push(r);
      }
    }
    logger.debug(
      {
        userId,
        candidatesBeforeFilter: merged.length,
        candidatesAfterFilter: filtered.length,
      },
      'RAG per-page ACL post-filter applied',
    );
    const topResults = filtered.slice(0, topK);

    // Record search analytics (non-blocking)
    const searchType = vectorResults.length === 0 && keywordResults.length > 0 ? 'keyword_fallback' : 'hybrid';
    // Deliberately still the RRF fusion value, NOT `vectorScore`. Changing what
    // this column means would silently make new rows incomparable with every
    // historical one, and `search_analytics` has no column to tell them apart.
    // That belongs with the migration in #1117's analytics half — see the
    // score-semantics note in docs/architecture/09-flow-rag-chat.md.
    // Keep this branch and the non-ACL one below in step.
    const maxScore = topResults.length > 0 ? Math.max(...topResults.map((r) => r.score)) : null;
    trackSearchAnalytics(userId, question, topResults.length, maxScore, searchType);

    return topResults;
  }

  const topResults = merged.slice(0, topK);

  // Record search analytics (non-blocking)
  // Distinguish keyword-fallback (embedding failed) from true hybrid
  const searchType = vectorResults.length === 0 && keywordResults.length > 0 ? 'keyword_fallback' : 'hybrid';
  // Deliberately still the RRF fusion value, NOT `vectorScore` — see the ACL
  // branch above for why, and keep the two in step.
  const maxScore = topResults.length > 0 ? Math.max(...topResults.map((r) => r.score)) : null;
  trackSearchAnalytics(userId, question, topResults.length, maxScore, searchType);

  return topResults;
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
