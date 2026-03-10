import { query } from '../db/postgres.js';
import { providerGenerateEmbedding } from './llm-provider.js';
import { htmlToText } from './content-converter.js';
import { logger } from '../utils/logger.js';
import { invalidateGraphCache, acquireEmbeddingLock, releaseEmbeddingLock, isEmbeddingLocked } from './redis-cache.js';
import pgvector from 'pgvector';

const CHUNK_SIZE = 500;     // ~500 tokens target
const CHUNK_OVERLAP = 50;   // ~50 token overlap
const CHARS_PER_TOKEN = 4;  // rough estimate

interface ChunkMetadata {
  page_title: string;
  section_title: string;
  space_key: string;
  confluence_id: string;
}

interface EmbeddingStatus {
  totalPages: number;
  embeddedPages: number;
  dirtyPages: number;
  totalEmbeddings: number;
  isProcessing: boolean;
}

/**
 * Split text into chunks, preferring heading/paragraph boundaries.
 */
export function chunkText(text: string, pageTitle: string, spaceKey: string, confluenceId: string): Array<{ text: string; metadata: ChunkMetadata }> {
  const maxChars = CHUNK_SIZE * CHARS_PER_TOKEN;
  const overlapChars = CHUNK_OVERLAP * CHARS_PER_TOKEN;

  // Split on headings first (lines starting with # or lines with === or ---)
  const sections = text.split(/(?=^#{1,6}\s)/m);
  const chunks: Array<{ text: string; metadata: ChunkMetadata }> = [];

  let currentSection = pageTitle;

  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;

    // Extract section title
    const headingMatch = trimmed.match(/^#{1,6}\s+(.+?)$/m);
    if (headingMatch) {
      currentSection = headingMatch[1];
    }

    if (trimmed.length <= maxChars) {
      chunks.push({
        text: trimmed,
        metadata: {
          page_title: pageTitle,
          section_title: currentSection,
          space_key: spaceKey,
          confluence_id: confluenceId,
        },
      });
    } else {
      // Split large sections on paragraph boundaries
      const paragraphs = trimmed.split(/\n\n+/);
      let currentChunk = '';

      for (const para of paragraphs) {
        if ((currentChunk + '\n\n' + para).length > maxChars && currentChunk) {
          chunks.push({
            text: currentChunk.trim(),
            metadata: {
              page_title: pageTitle,
              section_title: currentSection,
              space_key: spaceKey,
              confluence_id: confluenceId,
            },
          });
          // Keep overlap from end of previous chunk
          const words = currentChunk.split(/\s+/);
          const overlapWords = Math.ceil(overlapChars / 5);
          currentChunk = words.slice(-overlapWords).join(' ') + '\n\n' + para;
        } else {
          currentChunk = currentChunk ? currentChunk + '\n\n' + para : para;
        }
      }

      if (currentChunk.trim()) {
        chunks.push({
          text: currentChunk.trim(),
          metadata: {
            page_title: pageTitle,
            section_title: currentSection,
            space_key: spaceKey,
            confluence_id: confluenceId,
          },
        });
      }
    }
  }

  return chunks;
}

/**
 * Embed a single page's content.
 */
export async function embedPage(
  userId: string,
  confluenceId: string,
  pageTitle: string,
  spaceKey: string,
  bodyHtml: string,
): Promise<number> {
  const plainText = htmlToText(bodyHtml);
  if (!plainText || plainText.length < 20) {
    logger.debug({ confluenceId, pageTitle }, 'Skipping empty/short page for embedding');
    return 0;
  }

  const chunks = chunkText(plainText, pageTitle, spaceKey, confluenceId);
  if (chunks.length === 0) return 0;

  // Delete old embeddings for this page
  await query('DELETE FROM page_embeddings WHERE user_id = $1 AND confluence_id = $2', [userId, confluenceId]);

  // Generate embeddings in batches of 10
  const batchSize = 10;
  let embeddedCount = 0;

  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const texts = batch.map((c) => c.text);

    try {
      const embeddings = await providerGenerateEmbedding(userId, texts);

      for (let j = 0; j < batch.length; j++) {
        await query(
          `INSERT INTO page_embeddings (user_id, confluence_id, chunk_index, chunk_text, embedding, metadata)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            userId,
            confluenceId,
            i + j,
            batch[j].text,
            pgvector.toSql(embeddings[j]),
            JSON.stringify(batch[j].metadata),
          ],
        );
        embeddedCount++;
      }
    } catch (err) {
      logger.error({ err, confluenceId, batch: i }, 'Failed to embed batch');
      throw err;
    }
  }

  // Mark page as no longer dirty + update embedding status + clear any previous error
  await query(
    `UPDATE cached_pages SET embedding_dirty = FALSE, embedding_status = 'embedded', embedded_at = NOW(), embedding_error = NULL
     WHERE user_id = $1 AND confluence_id = $2`,
    [userId, confluenceId],
  );

  logger.info({ confluenceId, pageTitle, chunks: embeddedCount }, 'Page embedded');
  return embeddedCount;
}

/**
 * Check if embedding processing is already running for a user.
 * Uses Redis distributed lock instead of in-memory Set.
 */
export async function isProcessingUser(userId: string): Promise<boolean> {
  return isEmbeddingLocked(userId);
}

/**
 * Process all dirty pages for a user.
 * Returns `alreadyProcessing: true` if skipped because processing was in progress.
 */
export async function processDirtyPages(userId: string): Promise<{ processed: number; errors: number; alreadyProcessing?: boolean }> {
  const lockId = await acquireEmbeddingLock(userId);
  if (!lockId) {
    logger.warn({ userId }, 'Embedding processing already in progress for user');
    return { processed: 0, errors: 0, alreadyProcessing: true };
  }

  let processed = 0;
  let errors = 0;

  try {
    const result = await query<{
      confluence_id: string;
      title: string;
      space_key: string;
      body_html: string;
    }>(
      `SELECT confluence_id, title, space_key, body_html
       FROM cached_pages
       WHERE user_id = $1 AND embedding_dirty = TRUE AND body_html IS NOT NULL
       ORDER BY last_modified_at DESC`,
      [userId],
    );

    logger.info({ userId, dirtyPages: result.rows.length }, 'Processing dirty pages for embedding');

    for (const page of result.rows) {
      try {
        // Mark page as currently embedding and clear any previous error
        await query(
          `UPDATE cached_pages SET embedding_status = 'embedding', embedding_error = NULL WHERE user_id = $1 AND confluence_id = $2`,
          [userId, page.confluence_id],
        );

        await embedPage(userId, page.confluence_id, page.title, page.space_key, page.body_html);
        processed++;
      } catch (err) {
        logger.error({ err, confluenceId: page.confluence_id }, 'Failed to embed page');
        // Mark page as failed and store the error reason for UI display
        const errorMessage = err instanceof Error ? err.message : String(err);
        await query(
          `UPDATE cached_pages SET embedding_status = 'failed', embedding_error = $3 WHERE user_id = $1 AND confluence_id = $2`,
          [userId, page.confluence_id, errorMessage.slice(0, 1000)],
        ).catch((updateErr) => logger.error({ err: updateErr }, 'Failed to update embedding_status to failed'));
        errors++;
      }
    }
  } finally {
    await releaseEmbeddingLock(userId, lockId);
  }

  // Post-embed hook: recompute nearest-neighbor relationships
  if (processed > 0) {
    try {
      await computePageRelationships(userId);
      // Invalidate cached graph data so the next request reflects new relationships
      await invalidateGraphCache(userId);
    } catch (err) {
      logger.error({ err, userId }, 'Failed to compute page relationships after embedding');
    }
  }

  return { processed, errors };
}

/**
 * Compute nearest-neighbor page relationships using pgvector cosine similarity.
 * Uses average embedding per page, then finds top-K neighbors for each page.
 * Also computes label-overlap edges.
 */
export async function computePageRelationships(userId: string): Promise<number> {
  const TOP_K = 5;
  const SIMILARITY_THRESHOLD = 0.7; // cosine similarity (1 - cosine_distance)

  // Clear existing relationships for this user
  await query('DELETE FROM page_relationships WHERE user_id = $1', [userId]);

  // Compute embedding similarity edges using pgvector <=> operator.
  // We compute average embedding per page, then find top-K nearest neighbors.
  // This is a materialized computation, not real-time.
  const similarityResult = await query<{ page_id_1: string; page_id_2: string; score: number }>(
    `WITH page_avg AS (
       SELECT confluence_id, AVG(embedding) AS avg_embedding
       FROM page_embeddings
       WHERE user_id = $1
       GROUP BY confluence_id
     ),
     neighbors AS (
       SELECT
         a.confluence_id AS page_id_1,
         b.confluence_id AS page_id_2,
         (1 - (a.avg_embedding <=> b.avg_embedding)) AS score
       FROM page_avg a
       CROSS JOIN LATERAL (
         SELECT confluence_id, avg_embedding
         FROM page_avg b
         WHERE b.confluence_id != a.confluence_id
         ORDER BY a.avg_embedding <=> b.avg_embedding
         LIMIT $2
       ) b
       WHERE (1 - (a.avg_embedding <=> b.avg_embedding)) >= $3
     )
     INSERT INTO page_relationships (user_id, page_id_1, page_id_2, relationship_type, score)
     SELECT $1, page_id_1, page_id_2, 'embedding_similarity', score
     FROM neighbors
     ON CONFLICT (user_id, page_id_1, page_id_2, relationship_type) DO UPDATE
       SET score = EXCLUDED.score, created_at = NOW()
     RETURNING page_id_1, page_id_2, score`,
    [userId, TOP_K, SIMILARITY_THRESHOLD],
  );

  // Compute label-overlap edges: pages sharing at least one label
  const labelResult = await query<{ page_id_1: string; page_id_2: string; score: number }>(
    `WITH label_overlaps AS (
       SELECT
         a.confluence_id AS page_id_1,
         b.confluence_id AS page_id_2,
         CASE
           WHEN array_length(a.labels, 1) IS NULL OR array_length(b.labels, 1) IS NULL THEN 0
           ELSE (
             SELECT COUNT(*)::real FROM (
               SELECT unnest(a.labels) INTERSECT SELECT unnest(b.labels)
             ) x
           ) / GREATEST(
             array_length(a.labels, 1)::real,
             array_length(b.labels, 1)::real
           )
         END AS score
       FROM cached_pages a
       JOIN cached_pages b ON a.user_id = b.user_id
         AND a.confluence_id < b.confluence_id
       WHERE a.user_id = $1
         AND a.labels IS NOT NULL AND array_length(a.labels, 1) > 0
         AND b.labels IS NOT NULL AND array_length(b.labels, 1) > 0
         AND a.labels && b.labels
     )
     INSERT INTO page_relationships (user_id, page_id_1, page_id_2, relationship_type, score)
     SELECT $1, page_id_1, page_id_2, 'label_overlap', score
     FROM label_overlaps
     WHERE score > 0
     ON CONFLICT (user_id, page_id_1, page_id_2, relationship_type) DO UPDATE
       SET score = EXCLUDED.score, created_at = NOW()
     RETURNING page_id_1, page_id_2, score`,
    [userId],
  );

  const totalEdges = similarityResult.rows.length + labelResult.rows.length;
  logger.info({ userId, embeddingSimilarity: similarityResult.rows.length, labelOverlap: labelResult.rows.length },
    'Page relationships computed');
  return totalEdges;
}

/**
 * Get embedding status for a user.
 */
export async function getEmbeddingStatus(userId: string): Promise<EmbeddingStatus> {
  const [totalResult, dirtyResult, embeddingResult, embeddedPagesResult, isProcessing] = await Promise.all([
    query<{ count: string }>('SELECT COUNT(*) as count FROM cached_pages WHERE user_id = $1', [userId]),
    query<{ count: string }>('SELECT COUNT(*) as count FROM cached_pages WHERE user_id = $1 AND embedding_dirty = TRUE', [userId]),
    query<{ count: string }>('SELECT COUNT(*) as count FROM page_embeddings WHERE user_id = $1', [userId]),
    query<{ count: string }>('SELECT COUNT(DISTINCT confluence_id) as count FROM page_embeddings WHERE user_id = $1', [userId]),
    isEmbeddingLocked(userId),
  ]);

  return {
    totalPages: parseInt(totalResult.rows[0].count, 10),
    embeddedPages: parseInt(embeddedPagesResult.rows[0].count, 10),
    dirtyPages: parseInt(dirtyResult.rows[0].count, 10),
    totalEmbeddings: parseInt(embeddingResult.rows[0].count, 10),
    isProcessing,
  };
}

/**
 * Re-embed all pages for all users (admin action).
 */
export async function reEmbedAll(): Promise<void> {
  await query('DELETE FROM page_embeddings');
  await query(`UPDATE cached_pages SET embedding_dirty = TRUE, embedding_status = 'not_embedded', embedded_at = NULL, embedding_error = NULL`);
  logger.info('All embeddings cleared, pages marked dirty for re-embedding');

  // Get all users with pages
  const users = await query<{ user_id: string }>(
    'SELECT DISTINCT user_id FROM cached_pages',
  );

  for (const { user_id } of users.rows) {
    await processDirtyPages(user_id);
  }
}
