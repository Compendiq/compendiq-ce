import type { Job } from 'bullmq';
import { query, getPool } from '../../../core/db/postgres.js';
import { resolveUsecase } from './llm-provider-resolver.js';
import { generateEmbedding } from './openai-compatible-client.js';
import { htmlToText } from '../../../core/services/content-converter.js';
import { logger } from '../../../core/utils/logger.js';
import { invalidateGraphCache, acquireEmbeddingLock, releaseEmbeddingLock, isEmbeddingLocked, getRedisClient } from '../../../core/services/redis-cache.js';
import { getUserAccessibleSpaces } from '../../../core/services/rbac-service.js';
import { CircuitBreakerOpenError, getProviderBreaker } from '../../../core/services/circuit-breaker.js';
import pgvector from 'pgvector';

const CHUNK_SIZE = 500;          // ~500 tokens target
const CHUNK_OVERLAP = 50;        // ~50 token overlap
const CHARS_PER_TOKEN = 3;       // conservative estimate (code/tables can be 1–3 chars/token)
export const CHUNK_HARD_LIMIT = 6_000;  // absolute character ceiling (~1,500–2,000 tokens safety cap)

/** Delay between embedding pages to reduce LLM server pressure (ms). */
export const INTER_PAGE_DELAY_MS = 200;

/**
 * Number of pages to embed concurrently within a batch.
 * Default 1 (sequential) to respect LLM rate limits.
 * Increase only if the embedding server supports parallel requests.
 */
export const EMBEDDING_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.EMBEDDING_CONCURRENCY ?? '1', 10) || 1,
);

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
  lastRunAt: string | null;
  model: string;
}

/** Redis key for the last time embedding processing started (any user). */
const EMBEDDING_LAST_RUN_KEY = 'embedding:last_run_at';

/** Read the last embedding run timestamp from Redis. Returns null if unavailable. */
async function getLastEmbeddingRunAt(): Promise<Date | null> {
  const redis = getRedisClient();
  if (!redis) return null;
  try {
    const val = await redis.get(EMBEDDING_LAST_RUN_KEY);
    return val ? new Date(val) : null;
  } catch (err) {
    logger.error({ err }, 'Failed to read lastEmbeddingRunAt from Redis');
    return null;
  }
}

/** Store the last embedding run timestamp in Redis. */
async function setLastEmbeddingRunAt(date: Date): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  try {
    await redis.set(EMBEDDING_LAST_RUN_KEY, date.toISOString());
  } catch (err) {
    logger.error({ err }, 'Failed to write lastEmbeddingRunAt to Redis');
  }
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
 * Get the next retry time for the currently-resolved embedding provider's
 * circuit breaker. Returns the timestamp at which the breaker will allow a
 * probe request, or `null` when the breaker is closed (immediate retry) or
 * when no embedding provider could be resolved.
 *
 * Previously this queried the legacy `ollamaBreakers` / `openaiBreakers`
 * globals which are no longer populated by the multi-provider OpenAI-compatible
 * client — the real state lives on per-provider breakers keyed by UUID.
 */
export async function getEmbedBreakerNextRetryTime(): Promise<number | null> {
  try {
    const { config } = await resolveUsecase('embedding');
    const breaker = getProviderBreaker(config.providerId);
    return breaker.getStatus().nextRetryTime;
  } catch {
    // No default embedding provider configured yet — caller should retry
    // immediately; we can't locate a breaker to wait on.
    return null;
  }
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
      currentSection = headingMatch[1]!;
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
 * @param pageId - The integer primary key of the page in the `pages` table (pages.id)
 */
export async function embedPage(
  userId: string,
  pageId: number,
  pageTitle: string,
  spaceKey: string,
  bodyHtml: string,
  opts?: { chunkSize?: number; chunkOverlap?: number },
): Promise<number> {
  const plainText = htmlToText(bodyHtml);
  if (!plainText || plainText.length < 20) {
    logger.debug({ pageId, pageTitle }, 'Skipping empty/short page for embedding');
    await query(
      'UPDATE pages SET embedding_dirty = FALSE WHERE id = $1',
      [pageId],
    );
    return 0;
  }

  // Pass String(pageId) as the confluenceId metadata field (cosmetic only; never queried)
  const chunks = chunkText(plainText, pageTitle, spaceKey, String(pageId), opts?.chunkSize, opts?.chunkOverlap);
  if (chunks.length === 0) return 0;

  // ── Phase 1: Generate all embeddings in memory (no DB connection held) ──────
  // If the LLM call fails here, no transaction is opened and the old embeddings
  // remain intact in the database.
  const batchSize = 10;
  const allEmbeddings: Array<{ chunkIndex: number; text: string; embedding: number[]; metadata: ChunkMetadata }> = [];

  // Resolve the `embedding` use-case once per page so we don't hit the
  // resolver cache on every batch. Rotating providers mid-page would mix
  // incompatible vectors in the same page's embeddings; resolving once
  // keeps all chunks of one page consistent.
  const { config: embedConfig, model: embedModel } = await resolveUsecase('embedding');

  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const texts = batch.map((c) => c.text);

    try {
      const embeddings = await generateEmbedding(embedConfig, embedModel, texts);

      for (let j = 0; j < batch.length; j++) {
        allEmbeddings.push({
          chunkIndex: i + j,
          text: batch[j]!.text,
          embedding: embeddings[j]!,
          metadata: batch[j]!.metadata,
        });
      }
    } catch (err) {
      // HTTP 400 "input length exceeds context length" — skip this batch and
      // continue so the rest of the page's chunks are still embedded.
      if (isContextLengthError(err)) {
        logger.warn(
          { pageId, batchOffset: i, batchSize: batch.length },
          'Skipping oversized embedding batch (context length exceeded)',
        );
        continue;
      }
      logger.error({ err, pageId, batch: i }, 'Failed to embed batch');
      throw err;
    }
  }

  // ── Phase 2: Atomically replace old embeddings with new ones ─────────────────
  // All LLM work is done; now open a short-lived transaction so that concurrent
  // RAG queries never see an empty page_embeddings window.
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM page_embeddings WHERE page_id = $1', [pageId]);

    // Batch insert embeddings (50 rows per INSERT) instead of one-at-a-time.
    // 5 params per row x 50 = 250, well within PostgreSQL's 65535 parameter limit.
    const INSERT_BATCH_SIZE = 50;
    for (let batchStart = 0; batchStart < allEmbeddings.length; batchStart += INSERT_BATCH_SIZE) {
      const batch = allEmbeddings.slice(batchStart, batchStart + INSERT_BATCH_SIZE);
      const values: unknown[] = [];
      const placeholders: string[] = [];
      let paramIdx = 1;

      for (const item of batch) {
        placeholders.push(`($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3}, $${paramIdx + 4})`);
        values.push(pageId, item.chunkIndex, item.text, pgvector.toSql(item.embedding), JSON.stringify(item.metadata));
        paramIdx += 5;
      }

      await client.query(
        `INSERT INTO page_embeddings (page_id, chunk_index, chunk_text, embedding, metadata)
         VALUES ${placeholders.join(', ')}`,
        values,
      );
    }

    await client.query(
      `UPDATE pages SET embedding_dirty = FALSE, embedding_status = 'embedded', embedded_at = NOW(), embedding_error = NULL
       WHERE id = $1`,
      [pageId],
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  logger.info({ pageId, pageTitle, chunks: allEmbeddings.length }, 'Page embedded');
  return allEmbeddings.length;
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
 * userId is used only for the Redis embedding-lock. The embedding provider is resolved via resolveUsecase('embedding').
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

  await setLastEmbeddingRunAt(new Date());

  let totalProcessed = 0;
  let totalErrors = 0;
  let consecutiveFailures = 0;
  const errorList: string[] = [];
  const processedPageIds: number[] = [];

  try {
    // Fetch global chunk settings from admin_settings
    const chunkOpts = await getAdminChunkSettings();

    // Get total count for logging purposes (global, not per-user)
    // Exclude folder-type pages which have no content to embed
    const countResult = await query<{ count: string }>(
      "SELECT COUNT(*) as count FROM pages WHERE embedding_dirty = TRUE AND body_html IS NOT NULL AND deleted_at IS NULL AND COALESCE(page_type, 'page') != 'folder'",
    );
    const countRow = countResult.rows[0];
    if (!countRow) throw new Error('Expected a row from COUNT query');
    const totalDirty = parseInt(countRow.count, 10);
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
        id: number;
        confluence_id: string;
        title: string;
        space_key: string;
        body_html: string;
      }>(
        `SELECT id, confluence_id, title, space_key, body_html
         FROM pages
         WHERE embedding_dirty = TRUE AND body_html IS NOT NULL AND deleted_at IS NULL
           AND COALESCE(page_type, 'page') != 'folder'
         ORDER BY last_modified_at DESC
         LIMIT $1 OFFSET $2`,
        [DIRTY_PAGE_BATCH_SIZE, offset],
      );

      if (batch.rows.length === 0) break;

      let batchErrors = 0;
      const batchTotal = totalDirty; // Use totalDirty for progress percentage

      // Batch-mark all pages in this DB batch as 'embedding' in a single UPDATE
      const batchPageIds = batch.rows.map((p) => p.id);
      await query(
        `UPDATE pages SET embedding_status = 'embedding', embedding_error = NULL WHERE id = ANY($1::int[])`,
        [batchPageIds],
      );

      for (const page of batch.rows) {
        try {

          await embedPage(userId, page.id, page.title, page.space_key, page.body_html, chunkOpts);
          totalProcessed++;
          processedPageIds.push(page.id);
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
              const nextRetry = await getEmbedBreakerNextRetryTime();
              const waitMs = nextRetry !== null
                ? Math.max(nextRetry - Date.now() + CIRCUIT_BREAKER_WAIT_BUFFER_MS, CIRCUIT_BREAKER_WAIT_BUFFER_MS)
                : CIRCUIT_BREAKER_WAIT_BUFFER_MS;

              logger.warn(
                { userId, pageId: page.id, waitMs, attempt: cbRetries + 1 },
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
                await embedPage(userId, page.id, page.title, page.space_key, page.body_html, chunkOpts);
                totalProcessed++;
                processedPageIds.push(page.id);
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
                  logger.error({ err: retryErr, pageId: page.id }, 'Failed to embed page after circuit breaker recovery');
                  await query(
                    `UPDATE pages SET embedding_status = 'failed', embedding_error = $2 WHERE id = $1`,
                    [page.id, errorMessage.slice(0, 1000)],
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
          logger.error({ err, pageId: page.id }, 'Failed to embed page');
          const errorMessage = err instanceof Error ? err.message : String(err);
          await query(
            `UPDATE pages SET embedding_status = 'failed', embedding_error = $2 WHERE id = $1`,
            [page.id, errorMessage.slice(0, 1000)],
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

  // Post-embed hook: recompute nearest-neighbor relationships (incremental)
  if (totalProcessed > 0) {
    try {
      await computePageRelationships(processedPageIds);
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
    `UPDATE pages
     SET embedding_dirty = TRUE, embedding_status = 'not_embedded', embedding_error = NULL
     WHERE embedding_status = 'failed' AND deleted_at IS NULL`,
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
export async function computePageRelationships(changedPageIds?: number[]): Promise<number> {
  const TOP_K = 5;
  const SIMILARITY_THRESHOLD = 0.4; // cosine similarity (1 - cosine_distance) — lowered from 0.7 to surface more connections in small corpora

  // Wrap all three queries in a single transaction so the graph is never
  // visible as empty during the window between DELETE and INSERT.
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL statement_timeout = 120000'); // 2 min max for relationship computation

    // Delete only affected relationships when changedPageIds provided, otherwise full recompute
    if (changedPageIds && changedPageIds.length > 0) {
      await client.query(
        'DELETE FROM page_relationships WHERE page_id_1 = ANY($1) OR page_id_2 = ANY($1)',
        [changedPageIds],
      );
    } else {
      await client.query('DELETE FROM page_relationships');
    }

    // Compute embedding similarity edges using pgvector <=> operator.
    // We compute average embedding per page, then find top-K nearest neighbors.
    // When changedPageIds is provided, only use those pages as sources in the LATERAL join.
    const useIncremental = changedPageIds && changedPageIds.length > 0;
    const similarityResult = await client.query<{ page_id_1: number; page_id_2: number; score: number }>(
      `WITH page_avg AS (
         SELECT pe.page_id, AVG(pe.embedding) AS avg_embedding
         FROM page_embeddings pe
         JOIN pages p ON pe.page_id = p.id
         WHERE p.deleted_at IS NULL
         GROUP BY pe.page_id
       ),
       neighbors AS (
         SELECT
           a.page_id AS page_id_1,
           b.page_id AS page_id_2,
           (1 - (a.avg_embedding <=> b.avg_embedding)) AS score
         FROM page_avg a
         CROSS JOIN LATERAL (
           SELECT page_id, avg_embedding
           FROM page_avg b
           WHERE b.page_id != a.page_id
           ORDER BY a.avg_embedding <=> b.avg_embedding
           LIMIT $1
         ) b
         WHERE (1 - (a.avg_embedding <=> b.avg_embedding)) >= $2
           AND ($3::int[] IS NULL OR a.page_id = ANY($3))
       )
       INSERT INTO page_relationships (page_id_1, page_id_2, relationship_type, score)
       SELECT page_id_1, page_id_2, 'embedding_similarity', score
       FROM neighbors
       ON CONFLICT (page_id_1, page_id_2, relationship_type) DO UPDATE
         SET score = EXCLUDED.score, created_at = NOW()
       RETURNING page_id_1, page_id_2, score`,
      [TOP_K, SIMILARITY_THRESHOLD, useIncremental ? changedPageIds : null],
    );

    // Compute label-overlap edges: pages sharing at least one label.
    // When changedPageIds is provided, only compute for pairs involving at least one changed page.
    const labelResult = await client.query<{ page_id_1: number; page_id_2: number; score: number }>(
      `WITH label_overlaps AS (
         SELECT
           a.id AS page_id_1,
           b.id AS page_id_2,
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
         FROM pages a
         JOIN pages b ON a.id < b.id
         WHERE a.deleted_at IS NULL AND b.deleted_at IS NULL
           AND a.labels IS NOT NULL AND array_length(a.labels, 1) > 0
           AND b.labels IS NOT NULL AND array_length(b.labels, 1) > 0
           AND a.labels && b.labels
           AND ($1::int[] IS NULL OR a.id = ANY($1) OR b.id = ANY($1))
       )
       INSERT INTO page_relationships (page_id_1, page_id_2, relationship_type, score)
       SELECT page_id_1, page_id_2, 'label_overlap', score
       FROM label_overlaps
       WHERE score > 0
       ON CONFLICT (page_id_1, page_id_2, relationship_type) DO UPDATE
         SET score = EXCLUDED.score, created_at = NOW()
       RETURNING page_id_1, page_id_2, score`,
      [useIncremental ? changedPageIds : null],
    );

    await client.query('COMMIT');

    const totalEdges = similarityResult.rows.length + labelResult.rows.length;
    logger.info({ embeddingSimilarity: similarityResult.rows.length, labelOverlap: labelResult.rows.length },
      'Page relationships computed');
    return totalEdges;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Get embedding status scoped to a user's selected spaces.
 */
export async function getEmbeddingStatus(userId: string): Promise<EmbeddingStatus> {
  const statusSpaces = await getUserAccessibleSpaces(userId);
  const [totalResult, dirtyResult, embeddingResult, embeddedPagesResult, isProcessing, resolvedEmbedding, lastRunAt] = await Promise.all([
    query<{ count: string }>(
      `SELECT COUNT(*) as count FROM pages cp
       WHERE cp.space_key = ANY($1::text[])
         AND cp.deleted_at IS NULL`,
      [statusSpaces],
    ),
    query<{ count: string }>(
      `SELECT COUNT(*) as count FROM pages cp
       WHERE cp.space_key = ANY($1::text[])
         AND cp.deleted_at IS NULL AND cp.embedding_dirty = TRUE`,
      [statusSpaces],
    ),
    query<{ count: string }>(
      `SELECT COUNT(*) as count FROM page_embeddings pe
       JOIN pages cp ON pe.page_id = cp.id
       WHERE cp.space_key = ANY($1::text[])
         AND cp.deleted_at IS NULL`,
      [statusSpaces],
    ),
    query<{ count: string }>(
      `SELECT COUNT(DISTINCT pe.page_id) as count FROM page_embeddings pe
       JOIN pages cp ON pe.page_id = cp.id
       WHERE cp.space_key = ANY($1::text[])
         AND cp.deleted_at IS NULL`,
      [statusSpaces],
    ),
    isEmbeddingLocked(userId),
    resolveUsecase('embedding').catch(() => null),
    getLastEmbeddingRunAt(),
  ]);

  const totalRow = totalResult.rows[0];
  const embeddedPagesRow = embeddedPagesResult.rows[0];
  const dirtyRow = dirtyResult.rows[0];
  const embeddingRow = embeddingResult.rows[0];
  if (!totalRow || !embeddedPagesRow || !dirtyRow || !embeddingRow) {
    throw new Error('Expected a row from COUNT query');
  }

  return {
    totalPages: parseInt(totalRow.count, 10),
    embeddedPages: parseInt(embeddedPagesRow.count, 10),
    dirtyPages: parseInt(dirtyRow.count, 10),
    totalEmbeddings: parseInt(embeddingRow.count, 10),
    isProcessing,
    lastRunAt: lastRunAt ? lastRunAt.toISOString() : null,
    model: resolvedEmbedding?.model ?? '',
  };
}

/**
 * Re-embed all pages (admin action).
 */
export async function reEmbedAll(): Promise<void> {
  await query('DELETE FROM page_embeddings');
  await query(`UPDATE pages SET embedding_dirty = TRUE, embedding_status = 'not_embedded', embedded_at = NULL, embedding_error = NULL`);
  logger.info('All embeddings cleared, pages marked dirty for re-embedding');

  // Use a system user ID for provider selection (pick any active user with settings)
  const usersResult = await query<{ user_id: string }>(
    'SELECT user_id FROM user_settings WHERE confluence_url IS NOT NULL LIMIT 1',
  );
  const systemUserId = usersResult.rows[0]?.user_id ?? 'system';

  await processDirtyPages(systemUserId);
}

/**
 * Enqueue a re-embed job for all pages. When `newDimensions` is supplied it
 * atomically TRUNCATEs `page_embeddings`, rewrites the pgvector column type,
 * updates the `embedding_dimensions` admin setting, and rebuilds the HNSW
 * index before returning the job id. The worker run that iterates the pages
 * and calls `embedText()` per page is tracked in issue #257.
 */
export async function enqueueReembedAll(
  opts: { newDimensions?: number } = {},
): Promise<string> {
  const jobId = `reembed-${Date.now()}`;
  if (opts.newDimensions !== undefined) {
    // pgvector type args must be literal — validate strictly before interpolation.
    const n = Math.floor(opts.newDimensions);
    if (!Number.isFinite(n) || n < 1 || n > 8192) {
      throw new Error(
        `refused dimension change to non-integer or out-of-range value: ${opts.newDimensions}`,
      );
    }
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query(`TRUNCATE page_embeddings`);
      await client.query(
        `ALTER TABLE page_embeddings ALTER COLUMN embedding TYPE vector(${n})`,
      );
      await client.query(
        `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
         VALUES ('embedding_dimensions', $1, NOW())
         ON CONFLICT (setting_key) DO UPDATE
           SET setting_value = EXCLUDED.setting_value, updated_at = NOW()`,
        [String(n)],
      );
      await client.query(`DROP INDEX IF EXISTS idx_page_embeddings_hnsw`);
      await client.query(
        `CREATE INDEX idx_page_embeddings_hnsw ON page_embeddings USING hnsw (embedding vector_cosine_ops)`,
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
  return jobId;
}

/**
 * BullMQ worker entry point for the `reembed-all` queue (issue #257).
 *
 * Phase 1 placeholder — wired up so the queue can be registered against a
 * real function (typecheck passes, worker boots cleanly). The lock-aware
 * wait-on-locks loop, progress throttling, and
 * `processDirtyPages('__reembed_all__', …)` delegation arrive in Phase 2
 * (§2.3 of `docs/issues/257-implementation-plan.md`).
 *
 * The `_job` parameter is deliberately unused in this stub — Phase 2 will
 * use `job.updateProgress` for real progress reporting.
 */
export async function runReembedAllJob(_job: Job): Promise<string> {
  // Phase 2 replaces this body with the real worker per plan §2.3.
  // For now the legacy in-process reEmbedAll is invoked so the queue
  // registration has a real callable target.
  await reEmbedAll();
  return 'phase-1-stub';
}
