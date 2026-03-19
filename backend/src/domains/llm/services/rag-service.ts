import { query, getPool } from '../../../core/db/postgres.js';
import { providerGenerateEmbedding } from './llm-provider.js';
import { getUserAccessibleSpaces } from '../../../core/services/rbac-service.js';
import pgvector from 'pgvector';
import { logger } from '../../../core/utils/logger.js';

// Configurable ef_search: higher = better recall, slower query.
// Default 100 provides good recall/latency tradeoff for ~10K embeddings.
const RAG_EF_SEARCH = parseInt(process.env.RAG_EF_SEARCH ?? '100', 10);

interface SearchResult {
  confluenceId: string;
  pageId: number;
  chunkText: string;
  pageTitle: string;
  sectionTitle: string;
  spaceKey: string | null;
  score: number;
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
async function vectorSearch(userId: string, questionEmbedding: number[], limit = 10): Promise<SearchResult[]> {
  const vecSpaces = await getUserAccessibleSpaces(userId);
  // Use a dedicated client so SET LOCAL applies to our query
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL hnsw.ef_search = ${Number(RAG_EF_SEARCH)}`); // PostgreSQL does not accept parameterized SET statements; Number() cast is safe because RAG_EF_SEARCH is sourced from env, never from user input

    const result = await client.query<{
      confluence_id: string;
      page_id: number;
      chunk_text: string;
      metadata: { page_title: string; section_title: string; space_key: string };
      distance: number;
    }>(
      `SELECT cp.confluence_id, cp.id AS page_id, pe.chunk_text, pe.metadata,
              pe.embedding <=> $2 AS distance
       FROM page_embeddings pe
       JOIN pages cp ON pe.page_id = cp.id
       WHERE (
         (cp.source = 'confluence' AND cp.space_key = ANY($1::text[]))
         OR (cp.source = 'standalone' AND cp.visibility = 'shared')
         OR (cp.source = 'standalone' AND cp.visibility = 'private' AND cp.created_by_user_id = $4)
       )
       AND cp.deleted_at IS NULL
       ORDER BY pe.embedding <=> $2
       LIMIT $3`,
      [vecSpaces, pgvector.toSql(questionEmbedding), limit, userId],
    );

    await client.query('COMMIT');

    return result.rows.map((row) => ({
      confluenceId: row.confluence_id,
      pageId: row.page_id,
      chunkText: row.chunk_text,
      pageTitle: row.metadata.page_title,
      sectionTitle: row.metadata.section_title,
      spaceKey: row.metadata.space_key,
      score: 1 - row.distance, // Convert distance to similarity
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
async function keywordSearch(userId: string, questionText: string, limit = 10): Promise<SearchResult[]> {
  // Use plainto_tsquery which safely handles arbitrary user input
  // (no need to manually sanitize or construct tsquery syntax)
  const trimmed = questionText.trim();
  if (!trimmed) return [];

  const kwSpaces = await getUserAccessibleSpaces(userId);
  const result = await query<{
    confluence_id: string;
    page_id: number;
    title: string;
    space_key: string;
    body_text: string;
    rank: number;
  }>(
    `SELECT cp.confluence_id, cp.id AS page_id, cp.title, cp.space_key,
            substring(cp.body_text, 1, 500) as body_text,
            ts_rank(to_tsvector('english', coalesce(cp.title, '') || ' ' || coalesce(cp.body_text, '')),
                    plainto_tsquery('english', $2)) AS rank
     FROM pages cp
     WHERE to_tsvector('english', coalesce(cp.title, '') || ' ' || coalesce(cp.body_text, '')) @@ plainto_tsquery('english', $2)
       AND (
         (cp.source = 'confluence' AND cp.space_key = ANY($1::text[]))
         OR (cp.source = 'standalone' AND cp.visibility = 'shared')
         OR (cp.source = 'standalone' AND cp.visibility = 'private' AND cp.created_by_user_id = $4)
       )
       AND cp.deleted_at IS NULL
     ORDER BY rank DESC
     LIMIT $3`,
    [kwSpaces, trimmed, limit, userId],
  );

  return result.rows.map((row) => ({
    confluenceId: row.confluence_id,
    pageId: row.page_id,
    chunkText: row.body_text,
    pageTitle: row.title,
    sectionTitle: row.title,
    spaceKey: row.space_key,
    score: row.rank,
  }));
}

/**
 * Reciprocal Rank Fusion (RRF) - combines vector and keyword results.
 * RRF score = sum(1 / (k + rank_i)) for each ranking system.
 * Exported for unit testing.
 */
export function reciprocalRankFusion(
  vectorResults: SearchResult[],
  keywordResults: SearchResult[],
  k = 60,
): SearchResult[] {
  const scoreMap = new Map<string, { result: SearchResult; score: number }>();

  // Score from vector search
  vectorResults.forEach((result, rank) => {
    const key = `${result.confluenceId}:${result.chunkText.slice(0, 100)}`;
    const existing = scoreMap.get(key);
    const rrf = 1 / (k + rank + 1);
    if (existing) {
      existing.score += rrf;
    } else {
      scoreMap.set(key, { result, score: rrf });
    }
  });

  // Score from keyword search
  keywordResults.forEach((result, rank) => {
    const key = `${result.confluenceId}:${result.chunkText.slice(0, 100)}`;
    const existing = scoreMap.get(key);
    const rrf = 1 / (k + rank + 1);
    if (existing) {
      existing.score += rrf;
    } else {
      scoreMap.set(key, { result, score: rrf });
    }
  });

  return Array.from(scoreMap.values())
    .sort((a, b) => b.score - a.score)
    .map((entry) => ({ ...entry.result, score: entry.score }));
}

/**
 * Record a search analytics event.
 */
async function recordSearchAnalytics(
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

/**
 * Hybrid RAG search: combines vector search + keyword search using RRF.
 * Returns top results with source metadata for citations.
 * Scoped to: Confluence pages in user's selected spaces + accessible standalone articles.
 *
 * Graceful degradation: if embedding generation fails (e.g. circuit breaker open,
 * Ollama unreachable), falls back to keyword-only search instead of throwing a 500.
 * Keyword search is started before awaiting the embedding so both overlap on the happy path.
 */
export async function hybridSearch(
  userId: string,
  question: string,
  topK = 5,
): Promise<SearchResult[]> {
  logger.info({ userId, question: question.slice(0, 100) }, 'Running hybrid RAG search');

  // Start keyword search immediately — no embedding needed — so it overlaps with embedding generation
  const keywordPromise = keywordSearch(userId, question);

  // Attempt to generate question embedding; on failure fall back to keyword-only
  let questionEmbedding: number[] | null = null;
  try {
    const embeddings = await providerGenerateEmbedding(userId, question);
    questionEmbedding = embeddings[0];
  } catch (err) {
    logger.warn({ err, userId }, 'Embedding generation failed, falling back to keyword-only search');
  }

  let combined: SearchResult[];

  if (questionEmbedding !== null) {
    // Happy path: run vector search in parallel with the already-started keyword search
    const [vectorResults, keywordResults] = await Promise.all([
      vectorSearch(userId, questionEmbedding),
      keywordPromise,
    ]);

    logger.debug({
      vectorHits: vectorResults.length,
      keywordHits: keywordResults.length,
    }, 'Search results');

    combined = reciprocalRankFusion(vectorResults, keywordResults);
  } else {
    // Fallback: keyword-only (embedding unavailable)
    combined = await keywordPromise;
    logger.debug({ keywordHits: combined.length }, 'Keyword-only fallback');
  }

  // Deduplicate by pageId (stable SERIAL PK) — handles standalone pages with NULL confluenceId
  // where all null confluenceIds would otherwise collapse to the same dedup key
  const seen = new Set<number>();
  const deduped: SearchResult[] = [];
  for (const result of combined) {
    if (!seen.has(result.pageId)) {
      seen.add(result.pageId);
      deduped.push(result);
    }
    if (deduped.length >= topK) break;
  }

  // Record search analytics (non-blocking)
  const maxScore = deduped.length > 0 ? Math.max(...deduped.map((r) => r.score)) : null;
  recordSearchAnalytics(userId, question, deduped.length, maxScore, questionEmbedding !== null ? 'hybrid' : 'keyword').catch(() => {});

  return deduped;
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

export { RAG_EF_SEARCH };
export type { SearchResult };
