import { query, getPool } from '../../../core/db/postgres.js';
import { providerGenerateEmbedding } from './llm-provider.js';
import pgvector from 'pgvector';
import { logger } from '../../../core/utils/logger.js';

// Configurable ef_search: higher = better recall, slower query.
// Default 100 provides good recall/latency tradeoff for ~10K embeddings.
const RAG_EF_SEARCH = parseInt(process.env.RAG_EF_SEARCH ?? '100', 10);

interface SearchResult {
  confluenceId: string;
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
  // Use a dedicated client so SET LOCAL applies to our query
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL hnsw.ef_search = $1', [RAG_EF_SEARCH]);

    const result = await client.query<{
      confluence_id: string;
      chunk_text: string;
      metadata: { page_title: string; section_title: string; space_key: string };
      distance: number;
    }>(
      `SELECT cp.confluence_id, pe.chunk_text, pe.metadata,
              pe.embedding <=> $2 AS distance
       FROM page_embeddings pe
       JOIN pages cp ON pe.confluence_id = cp.confluence_id
<<<<<<< HEAD
       LEFT JOIN user_space_selections uss ON cp.space_key = uss.space_key AND uss.user_id = $1
       WHERE (
         (cp.source = 'confluence' AND uss.space_key IS NOT NULL)
         OR (cp.source = 'standalone' AND cp.visibility = 'shared')
         OR (cp.source = 'standalone' AND cp.visibility = 'private' AND cp.created_by_user_id = $1::int)
       )
       AND cp.deleted_at IS NULL
=======
       JOIN user_space_selections uss ON cp.space_key = uss.space_key AND uss.user_id = $1
>>>>>>> 46f8d99 (fix: restore missing worktree files + fix cached_pages references (#353))
       ORDER BY pe.embedding <=> $2
       LIMIT $3`,
      [userId, pgvector.toSql(questionEmbedding), limit],
    );

    await client.query('COMMIT');

    return result.rows.map((row) => ({
      confluenceId: row.confluence_id,
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
<<<<<<< HEAD
 * Scoped to: Confluence pages in user's selected spaces + standalone articles
 * the user can access (shared, or private and owned by the user).
=======
 * Scoped to pages in the user's selected spaces.
>>>>>>> 46f8d99 (fix: restore missing worktree files + fix cached_pages references (#353))
 */
async function keywordSearch(userId: string, questionText: string, limit = 10): Promise<SearchResult[]> {
  // Use plainto_tsquery which safely handles arbitrary user input
  // (no need to manually sanitize or construct tsquery syntax)
  const trimmed = questionText.trim();
  if (!trimmed) return [];

  const result = await query<{
    confluence_id: string;
    title: string;
    space_key: string;
    body_text: string;
    rank: number;
  }>(
    `SELECT cp.confluence_id, cp.title, cp.space_key,
            substring(cp.body_text, 1, 500) as body_text,
            ts_rank(to_tsvector('english', coalesce(cp.title, '') || ' ' || coalesce(cp.body_text, '')),
                    plainto_tsquery('english', $2)) AS rank
     FROM pages cp
<<<<<<< HEAD
     LEFT JOIN user_space_selections uss ON cp.space_key = uss.space_key AND uss.user_id = $1
=======
     JOIN user_space_selections uss ON cp.space_key = uss.space_key AND uss.user_id = $1
>>>>>>> 46f8d99 (fix: restore missing worktree files + fix cached_pages references (#353))
     WHERE to_tsvector('english', coalesce(cp.title, '') || ' ' || coalesce(cp.body_text, '')) @@ plainto_tsquery('english', $2)
       AND (
         (cp.source = 'confluence' AND uss.space_key IS NOT NULL)
         OR (cp.source = 'standalone' AND cp.visibility = 'shared')
         OR (cp.source = 'standalone' AND cp.visibility = 'private' AND cp.created_by_user_id = $1::int)
       )
       AND cp.deleted_at IS NULL
     ORDER BY rank DESC
     LIMIT $3`,
    [userId, trimmed, limit],
  );

  return result.rows.map((row) => ({
    confluenceId: row.confluence_id,
    chunkText: row.body_text,
    pageTitle: row.title,
    sectionTitle: row.title,
    spaceKey: row.space_key,
    score: row.rank,
  }));
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
  const scoreMap = new Map<string, { result: SearchResult; score: number }>();

  // Score from vector search
  vectorResults.forEach((result, rank) => {
    const key = `${result.confluenceId}:${result.chunkText.slice(0, 50)}`;
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
    const key = `${result.confluenceId}:${result.chunkText.slice(0, 50)}`;
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
 */
export async function hybridSearch(
  userId: string,
  question: string,
  topK = 5,
): Promise<SearchResult[]> {
  logger.info({ userId, question: question.slice(0, 100) }, 'Running hybrid RAG search');

  // Generate question embedding using the user's configured provider
  const embeddings = await providerGenerateEmbedding(userId, question);
  const questionEmbedding = embeddings[0];

  // Run vector and keyword search in parallel
  const [vectorResults, keywordResults] = await Promise.all([
    vectorSearch(userId, questionEmbedding),
    keywordSearch(userId, question),
  ]);

  logger.debug({
    vectorHits: vectorResults.length,
    keywordHits: keywordResults.length,
  }, 'Search results');

  // Combine with RRF
  const combined = reciprocalRankFusion(vectorResults, keywordResults);

  // Deduplicate by confluence_id (take best chunk per page)
  const seen = new Set<string>();
  const deduped: SearchResult[] = [];
  for (const result of combined) {
    if (!seen.has(result.confluenceId)) {
      seen.add(result.confluenceId);
      deduped.push(result);
    }
    if (deduped.length >= topK) break;
  }

  // Record search analytics (non-blocking)
  const maxScore = deduped.length > 0 ? Math.max(...deduped.map((r) => r.score)) : null;
  recordSearchAnalytics(userId, question, deduped.length, maxScore, 'hybrid').catch(() => {});

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
