/**
 * Background auto-summarizer worker.
 *
 * Periodically scans pages for articles that need summarization
 * (never summarized, content changed, or failed with retries remaining)
 * and generates summaries using the LLM service.
 *
 * Design mirrors sync-service.ts: setInterval scheduling, in-memory lock,
 * configurable interval via env var; batch size from admin settings
 * (`summary_batch_size`, Settings → Workers), read once per batch.
 *
 * NEVER writes summaries back to Confluence — local DB only.
 *
 * `summary_status = 'skipped'` recovery:
 *   When no summary model can be resolved for the configured provider
 *   (e.g. admin set provider=openai but no openai_model / usecase model),
 *   pending pages are transitioned to `'skipped'` rather than sitting
 *   stuck in `'pending'`. Admin recovery paths, in order of preference:
 *     1. Set a model for the Summary use case (Settings → AI Models,
 *        Use case assignments), or set the shared `openai_model` /
 *        `ollama_model` field.
 *     2. Hit `POST /api/llm/summary-rescan` (admin-only) — calls
 *        `rescanAllSummaries()` which resets pages for re-summarization
 *        and fires an immediate batch.
 *     3. (Surgical alternative) Re-queue only the skipped pages by SQL:
 *        `UPDATE pages SET summary_status = 'pending'
 *           WHERE summary_status = 'skipped' AND deleted_at IS NULL;`
 *     4. The next batch (runs every SUMMARY_CHECK_INTERVAL_MINUTES, default
 *        60) will pick them up automatically.
 */

import crypto from 'node:crypto';
import { query } from '../../../core/db/postgres.js';
import { emitWebhookEvent } from '../../../core/services/webhook-emit-hook.js';
import { scanForPii } from '../../../core/services/pii-scan-hook.js';
import { getSystemPrompt } from '../../llm/services/prompts.js';
import { resolveUsecase } from '../../llm/services/llm-provider-resolver.js';
import {
  streamChat,
  type ProviderConfig,
} from '../../llm/services/openai-compatible-client.js';
import { sanitizeLlmInput } from '../../../core/utils/sanitize-llm-input.js';
import { logger } from '../../../core/utils/logger.js';
import { acquireWorkerLock, releaseWorkerLock, refreshWorkerLock } from '../../../core/services/redis-cache.js';
import { getWorkerBatchSize } from '../../../core/services/admin-settings-service.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SUMMARY_CHECK_INTERVAL_MINUTES = parseInt(
  process.env.SUMMARY_CHECK_INTERVAL_MINUTES ?? '60',
  10,
);
const MAX_RETRIES = 3;
const MIN_BODY_LENGTH = 100;
const LOCK_TTL_SECONDS = 600;
const LOCK_REFRESH_MS = 60_000;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let workerIntervalHandle: ReturnType<typeof setInterval> | null = null;
let workerLock = false;
let isProcessing = false;
let lastRunAt: Date | null = null;

// ---------------------------------------------------------------------------
// Public status
// ---------------------------------------------------------------------------

interface SummaryStatus {
  totalPages: number;
  summarizedPages: number;
  summarizingPages: number;
  pendingPages: number;
  failedPages: number;
  skippedPages: number;
  isProcessing: boolean;
  lastRunAt: string | null;
  intervalMinutes: number;
  model: string;
}

interface SummaryAssignment {
  config: ProviderConfig & { id: string; name: string; defaultModel: string | null };
  model: string;
}

/**
 * Resolve the `{config, model}` pair for the summary use case via the
 * use-case resolver (multi-provider). The resolver reads from
 * `llm_usecase_assignments` + `llm_providers` tables.
 */
async function resolveSummaryAssignment(): Promise<SummaryAssignment | null> {
  try {
    return await resolveUsecase('summary');
  } catch {
    return null;
  }
}

export async function getSummaryStatus(): Promise<SummaryStatus> {
  const [result, assignment] = await Promise.all([
    query<{
      total: string;
      summarized: string;
      summarizing: string;
      pending: string;
      failed: string;
      skipped: string;
    }>(`
      SELECT
        COUNT(*)                                                 AS total,
        COUNT(*) FILTER (WHERE summary_status = 'summarized')    AS summarized,
        COUNT(*) FILTER (WHERE summary_status = 'summarizing')   AS summarizing,
        COUNT(*) FILTER (WHERE summary_status = 'pending')       AS pending,
        COUNT(*) FILTER (WHERE summary_status = 'failed')        AS failed,
        COUNT(*) FILTER (WHERE summary_status = 'skipped')       AS skipped
      FROM pages
      WHERE deleted_at IS NULL
    `),
    resolveSummaryAssignment(),
  ]);

  const row = result.rows[0];
  if (!row) throw new Error('Expected a row from summary stats query');
  return {
    totalPages: parseInt(row.total, 10),
    summarizedPages: parseInt(row.summarized, 10),
    summarizingPages: parseInt(row.summarizing, 10),
    pendingPages: parseInt(row.pending, 10),
    failedPages: parseInt(row.failed, 10),
    skippedPages: parseInt(row.skipped, 10),
    isProcessing,
    lastRunAt: lastRunAt ? lastRunAt.toISOString() : null,
    intervalMinutes: SUMMARY_CHECK_INTERVAL_MINUTES,
    model: assignment?.model ?? '',
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
// Strip model preamble / trailing meta-chatter from generated summaries (#912)
// ---------------------------------------------------------------------------

/**
 * Remove framing text some models wrap around the actual summary — a leading
 * "Here's a summary…" line and trailing offer/meta lines (e.g. "…please provide
 * it so I can respond in German."). Deliberately conservative so a genuine
 * summary is never eaten: the leading strip requires an explicit framing opener
 * plus the word "summary" plus a following newline, and the trailing strip only
 * peels a final line that carries an explicit offer/meta phrase.
 */
export function stripSummaryPreamble(markdown: string): string {
  let text = markdown.trim();

  // Leading framing line, e.g. "Here's a concise summary of the article in
  // Markdown format:" / "Below is a summary:". Requires a following newline so
  // the real summary (on later lines) is never eaten.
  text = text.replace(
    /^\s*(?:sure[,.!]?\s*)?(?:here(?:'s|\s+is|\s+are)|below\s+is|the\s+following\s+is)\b[^\n]*?\bsummary\b[^\n]*?\n+/i,
    '',
  );

  // Bare heading-style preamble line: "Summary:" / "**Summary:**".
  text = text.replace(/^\s*\**\s*summary\s*\**\s*:?\s*\n+/i, '');

  // Trailing meta/offer lines (optionally bold). Match only lines carrying an
  // explicit offer/meta phrase so real summary sentences beginning with "If"
  // survive. Loop to peel multiple trailing meta lines.
  const TRAILING_META =
    /\n+\s*\**[^\n]*\b(?:please\s+(?:provide|let\s+me\s+know|note)|let\s+me\s+know|feel\s+free|would\s+you\s+like|i\s+can\s+(?:help|provide|assist)|if\s+you(?:'d| would)\s+like|i\s+hope\s+this\s+helps|respond\s+in\s+(?:german|english))\b[^\n]*\**\s*$/i;
  let prev: string;
  do {
    prev = text;
    text = text.replace(TRAILING_META, '');
  } while (text !== prev);

  return text.trim();
}

// ---------------------------------------------------------------------------
// Core batch processing
// ---------------------------------------------------------------------------

interface SummaryCandidate {
  id: number;
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
    `SELECT id, body_text, summary_content_hash, summary_retry_count, title
     FROM pages
     WHERE summary_status IN ('pending', 'failed')
       AND deleted_at IS NULL
       AND COALESCE(page_type, 'page') != 'folder'
       AND (summary_status = 'pending' OR summary_retry_count < $1)
     ORDER BY
       CASE summary_status WHEN 'pending' THEN 0 ELSE 1 END,
       last_modified_at DESC NULLS LAST
     LIMIT $2`,
    [MAX_RETRIES, batchSize],
  );
  return result.rows;
}

const SUMMARIZE_LENGTH_INSTRUCTION_SHORT = 'Provide a brief 2-3 sentence summary.';

/**
 * Process a single page: generate summary, convert to HTML, store in DB.
 */
async function summarizePage(
  candidate: SummaryCandidate,
  assignment: SummaryAssignment,
): Promise<void> {
  const { id, body_text, title } = candidate;
  const { config, model } = assignment;

  // Skip empty/short content
  if (!body_text || body_text.length < MIN_BODY_LENGTH) {
    await query(
      `UPDATE pages
       SET summary_status = 'skipped',
           summary_error = 'Content too short for summarization'
       WHERE id = $1`,
      [id],
    );
    logger.info({ pageId: id, title }, 'Page skipped — content too short');
    return;
  }

  const contentHash = computeContentHash(body_text);

  // Mark as summarizing
  await query(
    `UPDATE pages SET summary_status = 'summarizing' WHERE id = $1`,
    [id],
  );

  try {
    // Build summarize messages here (rather than via ollama-service.summarizeContent)
    // so we can route through the use-case provider override.
    const { sanitized } = sanitizeLlmInput(body_text);
    const generator = streamChat(config, model, [
      {
        role: 'system',
        content: `${getSystemPrompt('summarize')} ${SUMMARIZE_LENGTH_INSTRUCTION_SHORT}`,
      },
      { role: 'user', content: sanitized },
    ]);
    const rawSummary = await collectStream(generator);
    // Strip model framing/meta-chatter before the empty-check, PII scan, and
    // HTML conversion so both summary_text and summary_html are stored clean (#912).
    const markdownSummary = stripSummaryPreamble(rawSummary);

    if (!markdownSummary.trim()) {
      throw new Error('LLM returned empty summary');
    }

    // PII guard (EE #119): scan the generated summary before persisting it.
    // No-op in CE / when no policy is active. On 'blocked' the summary is
    // withheld (terminal 'skipped' + content hash so it isn't retried until the
    // source content changes); on 'redacted' the redacted variant is persisted.
    const piiResult = await scanForPii(markdownSummary, 'summary');
    if (piiResult?.action === 'blocked') {
      await query(
        `UPDATE pages
         SET summary_status = 'skipped',
             summary_error = $1,
             summary_content_hash = $2,
             summary_retry_count = 0
         WHERE id = $3`,
        ['Summary withheld: detected PII (policy: block)', contentHash, id],
      );
      logger.warn(
        { pageId: id, title, piiSpans: piiResult.spans.length },
        'Summary blocked — PII detected in generated summary',
      );
      return;
    }
    const summaryMarkdown =
      piiResult?.action === 'redacted' && piiResult.redactedText
        ? piiResult.redactedText
        : markdownSummary;

    // Convert Markdown → HTML
    const summaryHtml = await markdownToHtml(summaryMarkdown);
    const summaryText = stripHtml(summaryHtml);

    // Store result
    await query(
      `UPDATE pages
       SET summary_text = $1,
           summary_html = $2,
           summary_status = 'summarized',
           summary_generated_at = NOW(),
           summary_error = NULL,
           summary_content_hash = $3,
           summary_model = $4,
           summary_retry_count = 0
       WHERE id = $5`,
      [summaryText, summaryHtml, contentHash, model, id],
    );

    emitWebhookEvent({
      eventType: 'ai.summary.complete',
      payload: {
        pageId: id,
        summary: summaryText,
        completedAt: new Date().toISOString(),
      },
    });

    logger.info({ pageId: id, title, model }, 'Summary generated');
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    const newRetryCount = candidate.summary_retry_count + 1;
    // Status is always 'failed' — retry gating is handled by the
    // findCandidates SQL query which filters on summary_retry_count < MAX_RETRIES.
    const newStatus = 'failed';

    await query(
      `UPDATE pages
       SET summary_status = $1,
           summary_error = $2,
           summary_retry_count = $3
       WHERE id = $4`,
      [newStatus, message, newRetryCount, id],
    );

    logger.error(
      { err, pageId: id, title, retryCount: newRetryCount },
      'Summary generation failed',
    );
    throw err;
  }
}

/**
 * Run one batch cycle: detect stale hashes, then process candidates.
 *
 * The optional `model` argument is an override for tests and manual invocations.
 * When absent, the resolver picks `{provider, model}` from admin settings
 * (use-case override → shared default → env bootstrap). See issue #214.
 */
export async function runSummaryBatch(
  model?: string,
): Promise<{ processed: number; errors: number }> {
  if (workerLock) return { processed: 0, errors: 0 };
  // Claim locally before awaiting Redis, including on Redis-less installations.
  workerLock = true;
  let lockToken: string | null = null;
  let guardTimer: NodeJS.Timeout | undefined;
  let guardInFlight: Promise<void> | null = null;
  let lockLost = false;

  try {
    lockToken = await acquireWorkerLock('summary-worker', LOCK_TTL_SECONDS, { failClosed: true });
    if (!lockToken) return { processed: 0, errors: 0 };
    const token = lockToken;
    isProcessing = true;
    lastRunAt = new Date();

    const renewLease = (): Promise<void> => {
      if (guardInFlight) return guardInFlight;
      if (lockLost) return Promise.resolve();
      guardInFlight = refreshWorkerLock('summary-worker', token, LOCK_TTL_SECONDS)
        .then((holder) => {
          if (holder !== token) lockLost = true;
        })
        .catch((err: unknown) => {
          lockLost = true;
          logger.error({ err }, 'Summary worker lock renewal failed');
        })
        .finally(() => {
          guardInFlight = null;
        });
      return guardInFlight;
    };
    const assertLease = async (): Promise<void> => {
      if (guardInFlight) await guardInFlight;
      if (lockLost) throw new Error('Summary worker lock lost; batch stopped');
    };
    // Renew even while a slow provider request is in flight; serialize renewals.
    guardTimer = setInterval(() => void renewLease(), LOCK_REFRESH_MS);
    guardTimer.unref();

    // Resolve the full assignment (config + model) via the use-case resolver.
    const assignment = await resolveSummaryAssignment();
    const effectiveModel = model || assignment?.model || '';
    await assertLease();

    if (!assignment || !effectiveModel) {
      const flipped = await query(
        // Clear stale errors so config-skips remain recoverable by rescan.
        `UPDATE pages SET summary_status = 'skipped', summary_error = NULL
         WHERE summary_status = 'pending' AND deleted_at IS NULL`,
      );
      logger.warn(
        { providerId: assignment?.config.providerId, flippedToSkipped: flipped.rowCount ?? 0 },
        'No summary provider/model configured (Settings → AI Models, Use case assignments). Marked pending pages as skipped — admin must POST /api/llm/summary-rescan to reprocess after fixing the config.',
      );
      return { processed: 0, errors: 0 };
    }

    const effectiveAssignment: SummaryAssignment = {
      config: assignment.config,
      model: effectiveModel,
    };

    // Only the lease holder may recover a crashed run's orphaned pages.
    await query(
      `UPDATE pages
       SET summary_status = 'pending'
       WHERE summary_status = 'summarizing'
         AND deleted_at IS NULL`,
    );

    // Detect content changes without hashing every summarized page.
    await query(
      `UPDATE pages
       SET summary_status = 'pending'
       WHERE summary_status = 'summarized'
         AND deleted_at IS NULL
         AND summary_generated_at IS NOT NULL
         AND last_modified_at IS NOT NULL
         AND last_modified_at > summary_generated_at
         AND body_text IS NOT NULL
         AND length(body_text) >= $1`,
      [MIN_BODY_LENGTH],
    );

    const candidates = await findCandidates(await getWorkerBatchSize('summary_batch_size'));
    let processed = 0;
    let errors = 0;

    for (const candidate of candidates) {
      await assertLease();
      try {
        await summarizePage(candidate, effectiveAssignment);
        processed++;
      } catch (err) {
        errors++;
        logger.error({ err, pageId: candidate.id }, 'Error in summary batch');
      }
    }

    await assertLease();
    return { processed, errors };
  } finally {
    clearInterval(guardTimer);
    try {
      if (guardInFlight) await guardInFlight;
      if (lockToken) await releaseWorkerLock('summary-worker', lockToken);
    } finally {
      isProcessing = false;
      workerLock = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Worker lifecycle
// ---------------------------------------------------------------------------

export function startSummaryWorker(intervalMinutes?: number): void {
  if (workerIntervalHandle) return;

  const interval = (intervalMinutes ?? SUMMARY_CHECK_INTERVAL_MINUTES) * 60 * 1000;

  workerIntervalHandle = setInterval(async () => {
    try {
      const { processed, errors } = await runSummaryBatch();
      if (processed > 0 || errors > 0) {
        logger.info({ processed, errors }, 'Summary worker batch completed');
      }
    } catch (err) {
      logger.error({ err }, 'Summary worker error');
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
  try {
    const { processed, errors } = await runSummaryBatch();
    if (processed > 0 || errors > 0) {
      logger.info({ processed, errors }, 'Initial summary batch completed');
    }
  } catch (err) {
    logger.error({ err }, 'Initial summary batch error');
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
 * Reset summary state to trigger full re-summarization. Admin-only operation.
 *
 * Recovers config-skipped pages (skipped with no summary_error, i.e. the
 * no-model path at runSummaryBatch) so this is the documented no-model
 * recovery route (#910). Deliberate skips carrying a non-null summary_error
 * (content-too-short, PII-blocked) stay skipped and are not reprocessed.
 */
export async function rescanAllSummaries(): Promise<number> {
  const result = await query(
    `UPDATE pages
     SET summary_content_hash = NULL,
         summary_status = 'pending',
         summary_retry_count = 0
     WHERE deleted_at IS NULL
       AND (summary_status != 'skipped' OR summary_error IS NULL)
     RETURNING confluence_id`,
  );
  return result.rowCount ?? 0;
}

/**
 * Trigger re-summarization for a single page.
 */
export async function regenerateSummary(pageId: number): Promise<void> {
  await query(
    `UPDATE pages
     SET summary_status = 'pending',
         summary_content_hash = NULL,
         summary_retry_count = 0,
         summary_error = NULL
     WHERE id = $1`,
    [pageId],
  );
}
