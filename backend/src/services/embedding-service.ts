import { query } from '../db/postgres.js';
import { providerGenerateEmbedding } from './llm-provider.js';
import { htmlToText } from './content-converter.js';
import { logger } from '../utils/logger.js';
import { invalidateGraphCache, acquireEmbeddingLock, releaseEmbeddingLock, isEmbeddingLocked } from './redis-cache.js';
import { CircuitBreakerOpenError, ollamaBreakers, openaiBreakers } from './circuit-breaker.js';
import pgvector from 'pgvector';

const CHUNK_SIZE = 500;          // ~500 tokens target
const CHUNK_OVERLAP = 50;        // ~50 token overlap
const CHARS_PER_TOKEN = 3;       // conservative estimate (code/tables can be 1–3 chars/token)
export const CHUNK_HARD_LIMIT = 6_000;  // absolute character ceiling (~1,500–2,000 tokens safety cap)

/** Delay between embedding pages to reduce LLM server pressure (ms). */
export const INTER_PAGE_DELAY_MS = 200;

/** Max retries when circuit breaker is open before stopping the batch. */
export const MAX_CIRCUIT_BREAKER_RETRIES = 3;

/** Consecutive non-circuit-breaker failures before pausing. */
export const CONSECUTIVE_FAILURE_PAUSE_THRESHOLD = 10;

/** Pause duration after consecutive failures (ms). */
export const CONSECUTIVE_FAILURE_PAUSE_MS = 30_000;

/** Extra wait time added after circuit breaker timeout to give server headroom (ms). */
export const CIRCUIT_BREAKER_WAIT_BUFFER_MS = 1_000;

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

/** Progress event emitted during embedding processing. */
export interface EmbeddingProgressEvent {
  type: 'progress' | 'complete' | 'waiting' | 'paused';
  total: number;
  completed: number;
  failed: number;
  currentPage?: string;
  percentage: number;
  /** Only for 'waiting' type: reason for the wait */
  reason?: string;
  /** Only for 'complete' type: first N error descriptions */
  errors?: string[];
}


/**
 * Helper to detect if an error is a circuit breaker open error.
 */
export function isCircuitBreakerError(err: unknown): boolean {
  return err instanceof CircuitBreakerOpenError;
}

/**
 * Helper to detect HTTP 400 "input length exceeds context length" errors from
 * Ollama/OpenAI-compatible embedding endpoints.
 */
export function isContextLengthError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('input length exceeds') ||
    msg.includes('context length') ||
    (msg.includes('http 400') && msg.includes('context'))
  );
}

/**
 * Get the next retry time for the embedding circuit breaker.
 * Checks both ollama and openai breakers and returns the soonest retry time,
 * or null if neither is open.
 */
export function getEmbedBreakerNextRetryTime(): number | null {
  const ollamaStatus = ollamaBreakers.embed.getStatus();
  const openaiStatus = openaiBreakers.embed.getStatus();

  const times: number[] = [];
  if (ollamaStatus.nextRetryTime !== null) times.push(ollamaStatus.nextRetryTime);
  if (openaiStatus.nextRetryTime !== null) times.push(openaiStatus.nextRetryTime);

  return times.length > 0 ? Math.min(...times) : null;
}

/**
 * Sleep helper.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Word-level fallback splitter. Splits `text` into chunks of at most `maxChars`
 * characters, breaking on whitespace boundaries. Used when paragraph splitting
 * still yields an oversized chunk (e.g. a single code block or minified JSON).
 */
export function splitByWords(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/);
  const result: string[] = [];
  let current = '';

  for (const word of words) {
    if (!word) continue;

    // If a single word exceeds maxChars, slice it by characters
    if (word.length > maxChars) {
      if (current) {
        result.push(current);
        current = '';
      }
      for (let offset = 0; offset < word.length; offset += maxChars) {
        result.push(word.slice(offset, offset + maxChars));
      }
      continue;
    }

    const candidate = current ? current + ' ' + word : word;
    if (candidate.length > maxChars && current) {
      result.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }

  if (current) result.push(current);
  return result;
}

/**
 * Push a candidate chunk, applying CHUNK_HARD_LIMIT as an absolute ceiling.
 * If the candidate exceeds the limit, it is split further by words before
 * being appended to the output array.
 */
function pushChunk(
  chunks: Array<{ text: string; metadata: ChunkMetadata }>,
  text: string,
  metadata: ChunkMetadata,
): void {
  const trimmed = text.trim();
  if (!trimmed) return;

  if (trimmed.length <= CHUNK_HARD_LIMIT) {
    chunks.push({ text: trimmed, metadata });
  } else {
    // Word-level fallback for oversized chunks (code blocks, tables, etc.)
    for (const part of splitByWords(trimmed, CHUNK_HARD_LIMIT)) {
      if (part.trim()) chunks.push({ text: part.trim(), metadata });
    }
  }
}

/**
 * Split text into chunks, preferring heading/paragraph boundaries.
 */
export function chunkText(
  text: string,
  pageTitle: string,
  spaceKey: string,
  confluenceId: string,
  chunkSize = CHUNK_SIZE,
  chunkOverlap = CHUNK_OVERLAP,
): Array<{ text: string; metadata: ChunkMetadata }> {
  const maxChars = chunkSize * CHARS_PER_TOKEN;
  const overlapChars = chunkOverlap * CHARS_PER_TOKEN;

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

    const meta: ChunkMetadata = {
      page_title: pageTitle,
      section_title: currentSection,
      space_key: spaceKey,
      confluence_id: confluenceId,
    };

    if (trimmed.length <= maxChars) {
      // Section fits within the target — still enforce the hard limit
      pushChunk(chunks, trimmed, meta);
    } else {
      // Split large sections on paragraph boundaries
      const paragraphs = trimmed.split(/\n\n+/);
      let currentChunk = '';

      for (const para of paragraphs) {
        if ((currentChunk + '\n\n' + para).length > maxChars && currentChunk) {
          pushChunk(chunks, currentChunk, meta);
          // Keep overlap from end of previous chunk
          const words = currentChunk.split(/\s+/);
          const overlapWords = Math.ceil(overlapChars / 5);
          currentChunk = words.slice(-overlapWords).join(' ') + '\n\n' + para;
        } else {
          currentChunk = currentChunk ? currentChunk + '\n\n' + para : para;
        }
      }

      if (currentChunk.trim()) {
        pushChunk(chunks, currentChunk, meta);
      }
    }
  }

  return chunks;
}

/**
 * Read chunk settings from admin_settings table.
 * Falls back to module-level defaults if not found.
 */
export async function getAdminChunkSettings(): Promise<{ chunkSize: number; chunkOverlap: number }> {
  const result = await query<{ setting_key: string; setting_value: string }>(
    `SELECT setting_key, setting_value FROM admin_settings
     WHERE setting_key IN ('embedding_chunk_size', 'embedding_chunk_overlap')`,
  );

  const settings: Record<string, number> = {};
  for (const row of result.rows) {
    settings[row.setting_key] = parseInt(row.setting_value, 10);
  }

  return {
    chunkSize: settings['embedding_chunk_size'] ?? CHUNK_SIZE,
    chunkOverlap: settings['embedding_chunk_overlap'] ?? CHUNK_OVERLAP,
  };
}

/**
 * Embed a single page's content.
 * Tables are shared (no user_id); access control is at the query layer.
 */
export async function embedPage(
  userId: string,
  confluenceId: string,
  pageTitle: string,
  spaceKey: string,
  bodyHtml: string,
  opts?: { chunkSize?: number; chunkOverlap?: number },
): Promise<number> {
  const plainText = htmlToText(bodyHtml);
  if (!plainText || plainText.length < 20) {
    logger.debug({ confluenceId, pageTitle }, 'Skipping empty/short page for embedding');
    await query(
      'UPDATE cached_pages SET embedding_dirty = FALSE WHERE confluence_id = $1',
      [confluenceId],
    );
    return 0;
  }

  const chunks = chunkText(plainText, pageTitle, spaceKey, confluenceId, opts?.chunkSize, opts?.chunkOverlap);
  if (chunks.length === 0) return 0;

  // Delete old embeddings for this page
  await query('DELETE FROM page_embeddings WHERE confluence_id = $1', [confluenceId]);

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
          `INSERT INTO page_embeddings (confluence_id, chunk_index, chunk_text, embedding, metadata)
           VALUES ($1, $2, $3, $4, $5)`,
          [
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
      // HTTP 400 "input length exceeds context length" — skip this batch and
      // continue so the rest of the page's chunks are still embedded.
      if (isContextLengthError(err)) {
        logger.warn(
          { confluenceId, batchOffset: i, batchSize: batch.length },
          'Skipping oversized embedding batch (context length exceeded)',
        );
        continue;
      }
      logger.error({ err, confluenceId, batch: i }, 'Failed to embed batch');
      throw err;
    }
  }

  // Mark page as no longer dirty + update embedding status + clear any previous error
  await query(
    `UPDATE cached_pages SET embedding_dirty = FALSE, embedding_status = 'embedded', embedded_at = NOW(), embedding_error = NULL
     WHERE confluence_id = $1`,
    [confluenceId],
  );

  logger.info({ confluenceId, pageTitle, chunks: embeddedCount }, 'Page embedded');
  return embeddedCount;
}

export const DIRTY_PAGE_BATCH_SIZE = 100;

/**
 * Check if embedding processing is already running for a user.
 * Uses Redis distributed lock instead of in-memory Set.
 */
export async function isProcessingUser(userId: string): Promise<boolean> {
  return isEmbeddingLocked(userId);
}

/**
 * Process all dirty pages in batches with circuit breaker resilience.
 *
 * Pages are fetched in batches of DIRTY_PAGE_BATCH_SIZE using LIMIT/OFFSET.
 * When a CircuitBreakerOpenError is detected, instead of marking the page
 * as failed, the loop waits for the breaker to recover and retries.
 *
 * An optional `onProgress` callback receives progress events for SSE streaming.
 *
 * userId is used only for the Redis lock and providerGenerateEmbedding (LLM provider selection).
 */
export async function processDirtyPages(
  userId: string,
  onProgress?: (event: EmbeddingProgressEvent) => void,
): Promise<{ processed: number; errors: number; alreadyProcessing?: boolean }> {
  const lockId = await acquireEmbeddingLock(userId);
  if (!lockId) {
    logger.warn({ userId }, 'Embedding processing already in progress for user');
    return { processed: 0, errors: 0, alreadyProcessing: true };
  }

  let totalProcessed = 0;
  let totalErrors = 0;
  let consecutiveFailures = 0;
  const errorList: string[] = [];

  try {
    // Fetch global chunk settings from admin_settings
    const chunkOpts = await getAdminChunkSettings();

    // Get total count for logging purposes (global, not per-user)
    const countResult = await query<{ count: string }>(
      'SELECT COUNT(*) as count FROM cached_pages WHERE embedding_dirty = TRUE AND body_html IS NOT NULL',
    );
    const totalDirty = parseInt(countResult.rows[0].count, 10);
    logger.info({ userId, dirtyPages: totalDirty }, 'Processing dirty pages for embedding');

    if (totalDirty === 0) {
      return { processed: 0, errors: 0 };
    }

    // Offset only advances by the number of errors per batch, because
    // successfully processed pages drop out of the WHERE filter.
    let offset = 0;
    let batchAborted = false;

    for (;;) {
      if (batchAborted) break;

      const batch = await query<{
        confluence_id: string;
        title: string;
        space_key: string;
        body_html: string;
      }>(
        `SELECT confluence_id, title, space_key, body_html
         FROM cached_pages
         WHERE embedding_dirty = TRUE AND body_html IS NOT NULL
         ORDER BY last_modified_at DESC
         LIMIT $1 OFFSET $2`,
        [DIRTY_PAGE_BATCH_SIZE, offset],
      );

      if (batch.rows.length === 0) break;

      let batchErrors = 0;
      const batchTotal = totalDirty; // Use totalDirty for progress percentage

      for (const page of batch.rows) {
        try {
          // Mark page as currently embedding and clear any previous error
          await query(
            `UPDATE cached_pages SET embedding_status = 'embedding', embedding_error = NULL WHERE confluence_id = $1`,
            [page.confluence_id],
          );

          await embedPage(userId, page.confluence_id, page.title, page.space_key, page.body_html, chunkOpts);
          totalProcessed++;
          consecutiveFailures = 0; // Reset on success

          // Report progress
          if (onProgress) {
            onProgress({
              type: 'progress',
              total: batchTotal,
              completed: totalProcessed,
              failed: totalErrors,
              currentPage: page.title,
              percentage: Math.round((totalProcessed + totalErrors) / batchTotal * 100),
            });
          }

          // Inter-page delay to reduce server pressure
          await sleep(INTER_PAGE_DELAY_MS);
        } catch (err) {
          // Circuit breaker open: wait for recovery instead of marking page as failed
          if (isCircuitBreakerError(err)) {
            let cbRetries = 0;
            let cbSuccess = false;

            while (cbRetries < MAX_CIRCUIT_BREAKER_RETRIES) {
              const nextRetry = getEmbedBreakerNextRetryTime();
              const waitMs = nextRetry !== null
                ? Math.max(nextRetry - Date.now() + CIRCUIT_BREAKER_WAIT_BUFFER_MS, CIRCUIT_BREAKER_WAIT_BUFFER_MS)
                : CIRCUIT_BREAKER_WAIT_BUFFER_MS;

              logger.warn(
                { userId, confluenceId: page.confluence_id, waitMs, attempt: cbRetries + 1 },
                'Circuit breaker open, waiting for recovery...',
              );

              if (onProgress) {
                onProgress({
                  type: 'waiting',
                  total: batchTotal,
                  completed: totalProcessed,
                  failed: totalErrors,
                  currentPage: page.title,
                  percentage: Math.round((totalProcessed + totalErrors) / batchTotal * 100),
                  reason: `Circuit breaker open, waiting ${Math.round(waitMs / 1000)}s for recovery (attempt ${cbRetries + 1}/${MAX_CIRCUIT_BREAKER_RETRIES})`,
                });
              }

              await sleep(waitMs);
              cbRetries++;

              // Try embedding again
              try {
                await embedPage(userId, page.confluence_id, page.title, page.space_key, page.body_html, chunkOpts);
                totalProcessed++;
                consecutiveFailures = 0;
                cbSuccess = true;

                if (onProgress) {
                  onProgress({
                    type: 'progress',
                    total: batchTotal,
                    completed: totalProcessed,
                    failed: totalErrors,
                    currentPage: page.title,
                    percentage: Math.round((totalProcessed + totalErrors) / batchTotal * 100),
                  });
                }

                await sleep(INTER_PAGE_DELAY_MS);
                break; // Success, move to next page
              } catch (retryErr) {
                if (!isCircuitBreakerError(retryErr)) {
                  // Different error, mark as failed and move on
                  const errorMessage = retryErr instanceof Error ? retryErr.message : String(retryErr);
                  logger.error({ err: retryErr, confluenceId: page.confluence_id }, 'Failed to embed page after circuit breaker recovery');
                  await query(
                    `UPDATE cached_pages SET embedding_status = 'failed', embedding_error = $2 WHERE confluence_id = $1`,
                    [page.confluence_id, errorMessage.slice(0, 1000)],
                  ).catch((updateErr) => logger.error({ err: updateErr }, 'Failed to update embedding_status to failed'));
                  totalErrors++;
                  batchErrors++;
                  consecutiveFailures++;
                  errorList.push(`${page.title}: ${errorMessage.slice(0, 200)}`);
                  cbSuccess = true; // Mark as handled (failed, but handled)
                  break;
                }
                // Still circuit breaker -- will loop to wait again
              }
            }

            // Exhausted circuit breaker retries -- stop the entire embedding job
            if (!cbSuccess) {
              logger.error(
                { userId, retriesExhausted: cbRetries },
                'Circuit breaker not recovering after max retries, stopping embedding batch',
              );
              batchAborted = true;
              break; // Exit the inner for loop
            }

            continue; // handled by circuit breaker path
          }

          // Non-circuit-breaker error: mark page as failed
          logger.error({ err, confluenceId: page.confluence_id }, 'Failed to embed page');
          const errorMessage = err instanceof Error ? err.message : String(err);
          await query(
            `UPDATE cached_pages SET embedding_status = 'failed', embedding_error = $2 WHERE confluence_id = $1`,
            [page.confluence_id, errorMessage.slice(0, 1000)],
          ).catch((updateErr) => logger.error({ err: updateErr }, 'Failed to update embedding_status to failed'));
          totalErrors++;
          batchErrors++;
          consecutiveFailures++;
          errorList.push(`${page.title}: ${errorMessage.slice(0, 200)}`);

          // Pause after too many consecutive failures to let the server recover
          if (consecutiveFailures >= CONSECUTIVE_FAILURE_PAUSE_THRESHOLD) {
            logger.warn(
              { userId, consecutiveFailures },
              `${consecutiveFailures} consecutive embedding failures, pausing for ${CONSECUTIVE_FAILURE_PAUSE_MS / 1000}s`,
            );

            if (onProgress) {
              onProgress({
                type: 'paused',
                total: batchTotal,
                completed: totalProcessed,
                failed: totalErrors,
                percentage: Math.round((totalProcessed + totalErrors) / batchTotal * 100),
                reason: `${consecutiveFailures} consecutive failures, pausing ${CONSECUTIVE_FAILURE_PAUSE_MS / 1000}s`,
              });
            }

            await sleep(CONSECUTIVE_FAILURE_PAUSE_MS);
            consecutiveFailures = 0; // Reset after pause
          }

          // Report progress even on failure
          if (onProgress) {
            onProgress({
              type: 'progress',
              total: batchTotal,
              completed: totalProcessed,
              failed: totalErrors,
              currentPage: page.title,
              percentage: Math.round((totalProcessed + totalErrors) / batchTotal * 100),
            });
          }
        }
      }

      // If every page in the batch errored, we need to advance past them
      // to avoid an infinite loop. If some succeeded, those dropped from
      // the result set so offset only needs to skip the errored ones.
      offset += batchErrors;

      // If the batch was smaller than the batch size, we've reached the end
      if (batch.rows.length < DIRTY_PAGE_BATCH_SIZE) break;
    }

    // Send completion event
    if (onProgress) {
      onProgress({
        type: 'complete',
        total: totalDirty,
        completed: totalProcessed,
        failed: totalErrors,
        percentage: totalDirty > 0 ? Math.round((totalProcessed + totalErrors) / totalDirty * 100) : 100,
        errors: errorList.slice(0, 20),
      });
    }
  } finally {
    await releaseEmbeddingLock(userId, lockId);
  }

  // Post-embed hook: recompute nearest-neighbor relationships
  if (totalProcessed > 0) {
    try {
      await computePageRelationships();
      // Invalidate cached graph data so the next request reflects new relationships
      await invalidateGraphCache(userId);
    } catch (err) {
      logger.error({ err, userId }, 'Failed to compute page relationships after embedding');
    }
  }

  return { processed: totalProcessed, errors: totalErrors };
}

/**
 * Reset all failed embeddings back to 'not_embedded' so they can be retried.
 * Returns the number of pages reset.
 */
export async function resetFailedEmbeddings(): Promise<number> {
  const result = await query(
    `UPDATE cached_pages
     SET embedding_dirty = TRUE, embedding_status = 'not_embedded', embedding_error = NULL
     WHERE embedding_status = 'failed'`,
  );

  const count = result.rowCount ?? 0;
  logger.info({ resetCount: count }, 'Reset failed embeddings for retry');
  return count;
}

/**
 * Compute nearest-neighbor page relationships using pgvector cosine similarity.
 * Uses average embedding per page, then finds top-K neighbors for each page.
 * Also computes label-overlap edges.
 * Tables are shared (no user_id).
 */
export async function computePageRelationships(): Promise<number> {
  const TOP_K = 5;
  const SIMILARITY_THRESHOLD = 0.7; // cosine similarity (1 - cosine_distance)

  // Clear all existing relationships
  await query('DELETE FROM page_relationships');

  // Compute embedding similarity edges using pgvector <=> operator.
  // We compute average embedding per page, then find top-K nearest neighbors.
  // This is a materialized computation, not real-time.
  const similarityResult = await query<{ page_id_1: string; page_id_2: string; score: number }>(
    `WITH page_avg AS (
       SELECT confluence_id, AVG(embedding) AS avg_embedding
       FROM page_embeddings
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
         LIMIT $1
       ) b
       WHERE (1 - (a.avg_embedding <=> b.avg_embedding)) >= $2
     )
     INSERT INTO page_relationships (page_id_1, page_id_2, relationship_type, score)
     SELECT page_id_1, page_id_2, 'embedding_similarity', score
     FROM neighbors
     ON CONFLICT (page_id_1, page_id_2, relationship_type) DO UPDATE
       SET score = EXCLUDED.score, created_at = NOW()
     RETURNING page_id_1, page_id_2, score`,
    [TOP_K, SIMILARITY_THRESHOLD],
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
       JOIN cached_pages b ON a.confluence_id < b.confluence_id
       WHERE a.labels IS NOT NULL AND array_length(a.labels, 1) > 0
         AND b.labels IS NOT NULL AND array_length(b.labels, 1) > 0
         AND a.labels && b.labels
     )
     INSERT INTO page_relationships (page_id_1, page_id_2, relationship_type, score)
     SELECT page_id_1, page_id_2, 'label_overlap', score
     FROM label_overlaps
     WHERE score > 0
     ON CONFLICT (page_id_1, page_id_2, relationship_type) DO UPDATE
       SET score = EXCLUDED.score, created_at = NOW()
     RETURNING page_id_1, page_id_2, score`,
  );

  const totalEdges = similarityResult.rows.length + labelResult.rows.length;
  logger.info({ embeddingSimilarity: similarityResult.rows.length, labelOverlap: labelResult.rows.length },
    'Page relationships computed');
  return totalEdges;
}

/**
 * Get embedding status scoped to a user's selected spaces.
 */
export async function getEmbeddingStatus(userId: string): Promise<EmbeddingStatus> {
  const [totalResult, dirtyResult, embeddingResult, embeddedPagesResult, isProcessing] = await Promise.all([
    query<{ count: string }>(
      `SELECT COUNT(*) as count FROM cached_pages cp
       JOIN user_space_selections uss ON cp.space_key = uss.space_key AND uss.user_id = $1`,
      [userId],
    ),
    query<{ count: string }>(
      `SELECT COUNT(*) as count FROM cached_pages cp
       JOIN user_space_selections uss ON cp.space_key = uss.space_key AND uss.user_id = $1
       WHERE cp.embedding_dirty = TRUE`,
      [userId],
    ),
    query<{ count: string }>(
      `SELECT COUNT(*) as count FROM page_embeddings pe
       JOIN cached_pages cp ON pe.confluence_id = cp.confluence_id
       JOIN user_space_selections uss ON cp.space_key = uss.space_key AND uss.user_id = $1`,
      [userId],
    ),
    query<{ count: string }>(
      `SELECT COUNT(DISTINCT pe.confluence_id) as count FROM page_embeddings pe
       JOIN cached_pages cp ON pe.confluence_id = cp.confluence_id
       JOIN user_space_selections uss ON cp.space_key = uss.space_key AND uss.user_id = $1`,
      [userId],
    ),
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
 * Re-embed all pages (admin action).
 */
export async function reEmbedAll(): Promise<void> {
  await query('DELETE FROM page_embeddings');
  await query(`UPDATE cached_pages SET embedding_dirty = TRUE, embedding_status = 'not_embedded', embedded_at = NULL, embedding_error = NULL`);
  logger.info('All embeddings cleared, pages marked dirty for re-embedding');

  // Use a system user ID for provider selection (pick any active user with settings)
  const usersResult = await query<{ user_id: string }>(
    'SELECT user_id FROM user_settings WHERE confluence_url IS NOT NULL LIMIT 1',
  );
  const systemUserId = usersResult.rows[0]?.user_id ?? 'system';

  await processDirtyPages(systemUserId);
}
