/**
 * Background auto-summarizer worker.
 *
 * Periodically scans cached_pages for articles that need summarization
 * (never summarized, content changed, or failed with retries remaining)
 * and generates summaries using the LLM service.
 *
 * Design mirrors sync-service.ts: setInterval scheduling, in-memory lock,
 * configurable batch size and interval.
 *
 * NEVER writes summaries back to Confluence — local DB only.
 */

import crypto from 'node:crypto';
import { query } from '../../../core/db/postgres.js';
import { summarizeContent } from '../../llm/services/ollama-service.js';
import { logger } from '../../../core/utils/logger.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SUMMARY_CHECK_INTERVAL_MINUTES = parseInt(
  process.env.SUMMARY_CHECK_INTERVAL_MINUTES ?? '60',
  10,
);
const SUMMARY_BATCH_SIZE = parseInt(
  process.env.SUMMARY_BATCH_SIZE ?? '5',
  10,
);
const SUMMARY_MODEL = process.env.SUMMARY_MODEL ?? process.env.DEFAULT_LLM_MODEL ?? '';
const MAX_RETRIES = 3;
const MIN_BODY_LENGTH = 100;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let workerIntervalHandle: ReturnType<typeof setInterval> | null = null;
let workerLock = false;
let isProcessing = false;

// ---------------------------------------------------------------------------
// Public status
// ---------------------------------------------------------------------------

export interface SummaryStatus {
  totalPages: number;
  summarizedPages: number;
  pendingPages: number;
  failedPages: number;
  skippedPages: number;
  isProcessing: boolean;
}

export async function getSummaryStatus(): Promise<SummaryStatus> {
  const result = await query<{
    total: string;
    summarized: string;
    pending: string;
    failed: string;
    skipped: string;
  }>(`
    SELECT
      COUNT(*)                                        AS total,
      COUNT(*) FILTER (WHERE summary_status = 'summarized')  AS summarized,
      COUNT(*) FILTER (WHERE summary_status = 'pending')     AS pending,
      COUNT(*) FILTER (WHERE summary_status = 'failed')      AS failed,
      COUNT(*) FILTER (WHERE summary_status = 'skipped')     AS skipped
    FROM cached_pages
  `);

  const row = result.rows[0];
  return {
    totalPages: parseInt(row.total, 10),
    summarizedPages: parseInt(row.summarized, 10),
    pendingPages: parseInt(row.pending, 10),
    failedPages: parseInt(row.failed, 10),
    skippedPages: parseInt(row.skipped, 10),
    isProcessing,
  };
}

// ---------------------------------------------------------------------------
// Content hash utility
// ---------------------------------------------------------------------------

export function computeContentHash(bodyText: string): string {
  return crypto.createHash('sha256').update(bodyText).digest('hex');
}

// ---------------------------------------------------------------------------
// Stream collector: consumes AsyncGenerator<StreamChunk> into a string
// ---------------------------------------------------------------------------

async function collectStream(
  generator: AsyncGenerator<{ content: string; done: boolean }>,
): Promise<string> {
  let result = '';
  for await (const chunk of generator) {
    result += chunk.content;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Convert Markdown to HTML (lazy import to avoid circular deps)
// ---------------------------------------------------------------------------

async function markdownToHtml(markdown: string): Promise<string> {
  const { Marked } = await import('marked');
  const marked = new Marked();
  return await marked.parse(markdown) as string;
}

// ---------------------------------------------------------------------------
// Strip HTML tags to get plain text
// ---------------------------------------------------------------------------

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').trim();
}

// ---------------------------------------------------------------------------
// Core batch processing
// ---------------------------------------------------------------------------

interface SummaryCandidate {
  confluence_id: string;
  body_text: string;
  summary_content_hash: string | null;
  summary_retry_count: number;
  title: string;
}

/**
 * Find pages that need summarization, prioritized:
 * 1. pending (never summarized)
 * 2. content changed (hash mismatch) — detected and set to 'pending' by sync or worker
 * 3. failed with retries remaining
 */
async function findCandidates(batchSize: number): Promise<SummaryCandidate[]> {
  const result = await query<SummaryCandidate>(
    `SELECT confluence_id, body_text, summary_content_hash, summary_retry_count, title
     FROM cached_pages
     WHERE summary_status IN ('pending', 'failed')
       AND (summary_status = 'pending' OR summary_retry_count < $1)
     ORDER BY
       CASE summary_status WHEN 'pending' THEN 0 ELSE 1 END,
       last_modified_at DESC NULLS LAST
     LIMIT $2`,
    [MAX_RETRIES, batchSize],
  );
  return result.rows;
}

/**
 * Process a single page: generate summary, convert to HTML, store in DB.
 */
async function summarizePage(
  candidate: SummaryCandidate,
  model: string,
): Promise<void> {
  const { confluence_id, body_text, title } = candidate;

  // Skip empty/short content
  if (!body_text || body_text.length < MIN_BODY_LENGTH) {
    await query(
      `UPDATE cached_pages
       SET summary_status = 'skipped',
           summary_error = 'Content too short for summarization'
       WHERE confluence_id = $1`,
      [confluence_id],
    );
    logger.info({ pageId: confluence_id, title }, 'Page skipped — content too short');
    return;
  }

  const contentHash = computeContentHash(body_text);

  // Mark as summarizing
  await query(
    `UPDATE cached_pages SET summary_status = 'summarizing' WHERE confluence_id = $1`,
    [confluence_id],
  );

  try {
    // Generate summary using the shared LLM service (collect full stream, NOT SSE)
    const generator = summarizeContent(model, body_text, 'short');
    const markdownSummary = await collectStream(generator);

    if (!markdownSummary.trim()) {
      throw new Error('LLM returned empty summary');
    }

    // Convert Markdown → HTML
    const summaryHtml = await markdownToHtml(markdownSummary);
    const summaryText = stripHtml(summaryHtml);

    // Store result
    await query(
      `UPDATE cached_pages
       SET summary_text = $1,
           summary_html = $2,
           summary_status = 'summarized',
           summary_generated_at = NOW(),
           summary_error = NULL,
           summary_content_hash = $3,
           summary_model = $4,
           summary_retry_count = 0
       WHERE confluence_id = $5`,
      [summaryText, summaryHtml, contentHash, model, confluence_id],
    );

    logger.info({ pageId: confluence_id, title, model }, 'Summary generated');
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    const newRetryCount = candidate.summary_retry_count + 1;
    // Status is always 'failed' — retry gating is handled by the
    // findCandidates SQL query which filters on summary_retry_count < MAX_RETRIES.
    const newStatus = 'failed';

    await query(
      `UPDATE cached_pages
       SET summary_status = $1,
           summary_error = $2,
           summary_retry_count = $3
       WHERE confluence_id = $4`,
      [newStatus, message, newRetryCount, confluence_id],
    );

    logger.error(
      { err, pageId: confluence_id, title, retryCount: newRetryCount },
      'Summary generation failed',
    );
  }
}

/**
 * Run one batch cycle: detect stale hashes, then process candidates.
 */
export async function runSummaryBatch(model?: string): Promise<{ processed: number; errors: number }> {
  const resolvedModel = model || SUMMARY_MODEL;
  if (!resolvedModel) {
    logger.warn('No summary model configured (SUMMARY_MODEL or DEFAULT_LLM_MODEL). Skipping batch.');
    return { processed: 0, errors: 0 };
  }

  // Phase 1: Detect content changes (hash mismatch) and mark as pending
  await query(
    `UPDATE cached_pages
     SET summary_status = 'pending'
     WHERE summary_status = 'summarized'
       AND summary_content_hash IS NOT NULL
       AND body_text IS NOT NULL
       AND length(body_text) >= $1
       AND summary_content_hash != encode(sha256(convert_to(body_text, 'UTF-8')), 'hex')`,
    [MIN_BODY_LENGTH],
  );

  // Phase 2: Find and process candidates
  const candidates = await findCandidates(SUMMARY_BATCH_SIZE);
  let processed = 0;
  let errors = 0;

  for (const candidate of candidates) {
    try {
      await summarizePage(candidate, resolvedModel);
      processed++;
    } catch (err) {
      errors++;
      logger.error({ err, pageId: candidate.confluence_id }, 'Unexpected error in summary batch');
    }
  }

  return { processed, errors };
}

// ---------------------------------------------------------------------------
// Worker lifecycle
// ---------------------------------------------------------------------------

export function startSummaryWorker(intervalMinutes?: number): void {
  if (workerIntervalHandle) return;

  const interval = (intervalMinutes ?? SUMMARY_CHECK_INTERVAL_MINUTES) * 60 * 1000;

  workerIntervalHandle = setInterval(async () => {
    if (workerLock) return;
    workerLock = true;
    isProcessing = true;

    try {
      const { processed, errors } = await runSummaryBatch();
      if (processed > 0 || errors > 0) {
        logger.info({ processed, errors }, 'Summary worker batch completed');
      }
    } catch (err) {
      logger.error({ err }, 'Summary worker error');
    } finally {
      workerLock = false;
      isProcessing = false;
    }
  }, interval);

  logger.info(
    { intervalMinutes: intervalMinutes ?? SUMMARY_CHECK_INTERVAL_MINUTES },
    'Background summary worker started',
  );
}

/**
 * Trigger a single summary batch run with lock guards.
 * Safe to call from startup timers — will no-op if the worker is already processing.
 */
export async function triggerSummaryBatch(): Promise<void> {
  if (workerLock) return;
  workerLock = true;
  isProcessing = true;

  try {
    const { processed, errors } = await runSummaryBatch();
    if (processed > 0 || errors > 0) {
      logger.info({ processed, errors }, 'Initial summary batch completed');
    }
  } catch (err) {
    logger.error({ err }, 'Initial summary batch error');
  } finally {
    workerLock = false;
    isProcessing = false;
  }
}

export function stopSummaryWorker(): void {
  if (workerIntervalHandle) {
    clearInterval(workerIntervalHandle);
    workerIntervalHandle = null;
    logger.info('Background summary worker stopped');
  }
}

/**
 * Reset all summary_content_hash values to trigger full re-summarization.
 * Admin-only operation.
 */
export async function rescanAllSummaries(): Promise<number> {
  const result = await query(
    `UPDATE cached_pages
     SET summary_content_hash = NULL,
         summary_status = 'pending',
         summary_retry_count = 0
     WHERE summary_status != 'skipped'
     RETURNING confluence_id`,
  );
  return result.rowCount ?? 0;
}

/**
 * Trigger re-summarization for a single page.
 */
export async function regenerateSummary(pageId: string): Promise<void> {
  await query(
    `UPDATE cached_pages
     SET summary_status = 'pending',
         summary_content_hash = NULL,
         summary_retry_count = 0,
         summary_error = NULL
     WHERE confluence_id = $1`,
    [pageId],
  );
}
