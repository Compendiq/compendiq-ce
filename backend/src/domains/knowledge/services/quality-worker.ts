/**
 * Background quality analyzer worker.
 *
 * Periodically scans pages and runs LLM quality analysis in batches.
 * Modeled after sync-service.ts: setInterval scheduling, in-memory lock,
 * configurable interval and batch size via env vars.
 *
 * `quality_status = 'skipped'` recovery:
 *   Pages are marked `'skipped'` in two situations:
 *     a) body_text is empty or shorter than the 50-char analysis threshold
 *        (handled in analyzePageQuality / processBatch), or
 *     b) no quality model can be resolved for the configured provider
 *        (e.g. admin set provider=openai but no openai_model / usecase
 *        model); applying the Ollama-shaped `qwen3:4b` default would fail.
 *   Admin recovery paths for case (b), in order of preference:
 *     1. Set a model: Settings → LLM → Use case assignments → Quality,
 *        or set the shared `openai_model` / `ollama_model` field.
 *     2. Call `forceQualityRescan()` (exported below) or hit
 *        `POST /api/admin/quality-rescan` — flips every `'skipped'` /
 *        `'failed'` / `'analyzed'` page back to `'pending'` so the next
 *        batch reprocesses them.
 *     3. (Surgical alternative) Re-queue only the skipped pages by SQL:
 *        `UPDATE pages SET quality_status = 'pending'
 *           WHERE quality_status = 'skipped' AND deleted_at IS NULL;`
 *     4. The next batch (runs every QUALITY_CHECK_INTERVAL_MINUTES, default
 *        60) will analyze them automatically.
 */

import { query } from '../../../core/db/postgres.js';
import { getSystemPrompt } from '../../llm/services/ollama-service.js';
import { resolveUsecase } from '../../llm/services/llm-provider-resolver.js';
import {
  streamChat,
  type ProviderConfig,
} from '../../llm/services/openai-compatible-client.js';
import { sanitizeLlmInput } from '../../../core/utils/sanitize-llm-input.js';
import { htmlToMarkdown } from '../../../core/services/content-converter.js';
import { logger } from '../../../core/utils/logger.js';
import { acquireWorkerLock, releaseWorkerLock } from '../../../core/services/redis-cache.js';

// ─── Configuration ────────────────────────────────────────────────────────────

const QUALITY_BATCH_SIZE = parseInt(process.env.QUALITY_BATCH_SIZE ?? '5', 10);
const MAX_RETRIES = 3;

interface QualityAssignment {
  config: ProviderConfig & { id: string; name: string; defaultModel: string | null };
  model: string;
}

/**
 * Resolve the `{config, model}` pair for the quality use case via the
 * use-case resolver. Pulls from `llm_usecase_assignments` + `llm_providers`
 * tables; picks up runtime admin edits without restart.
 */
async function resolveQualityAssignment(): Promise<QualityAssignment | null> {
  try {
    return await resolveUsecase('quality');
  } catch {
    return null;
  }
}

// ─── State ────────────────────────────────────────────────────────────────────

let qualityIntervalHandle: ReturnType<typeof setInterval> | null = null;
let qualityLock = false;
let isProcessing = false;
let lastRunAt: Date | null = null;

// ─── Score parsing ────────────────────────────────────────────────────────────

export interface QualityScores {
  overall: number;
  completeness: number;
  clarity: number;
  structure: number;
  accuracy: number;
  readability: number;
  summary: string;
}

/**
 * Parse the structured LLM quality output into numeric scores.
 *
 * Expected format:
 *   ## Overall Quality Score: 75/100
 *   ## Completeness: 80/100
 *   ## Clarity: 70/100
 *   ...
 *   ## Summary
 *   [text]
 */
export function parseQualityScores(text: string): QualityScores | null {
  // Strip <think>...</think> blocks from thinking models (e.g., qwen3, deepseek-r1)
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  const overallMatch = cleaned.match(/##?\s*Overall\s+Quality\s+Score:\s*(\d+)\s*\/\s*100/i);
  const completenessMatch = cleaned.match(/##?\s*Completeness:\s*(\d+)\s*\/\s*100/i);
  const clarityMatch = cleaned.match(/##?\s*Clarity:\s*(\d+)\s*\/\s*100/i);
  const structureMatch = cleaned.match(/##?\s*Structure:\s*(\d+)\s*\/\s*100/i);
  const accuracyMatch = cleaned.match(/##?\s*Accuracy:\s*(\d+)\s*\/\s*100/i);
  const readabilityMatch = cleaned.match(/##?\s*Readability:\s*(\d+)\s*\/\s*100/i);

  if (!overallMatch || !completenessMatch || !clarityMatch || !structureMatch || !accuracyMatch || !readabilityMatch) {
    return null;
  }

  // Extract summary section
  const summaryMatch = cleaned.match(/##?\s*Summary\s*\n([\s\S]*?)(?:\n##|$)/i);
  const summary = summaryMatch?.[1]?.trim() ?? '';

  const clamp = (n: number) => Math.max(0, Math.min(100, n));

  return {
    overall: clamp(parseInt(overallMatch[1]!, 10)),
    completeness: clamp(parseInt(completenessMatch[1]!, 10)),
    clarity: clamp(parseInt(clarityMatch[1]!, 10)),
    structure: clamp(parseInt(structureMatch[1]!, 10)),
    accuracy: clamp(parseInt(accuracyMatch[1]!, 10)),
    readability: clamp(parseInt(readabilityMatch[1]!, 10)),
    summary,
  };
}

// ─── Core analysis ────────────────────────────────────────────────────────────

/**
 * Collect the full streamed response from the quality analysis LLM call.
 * This is an internal batch job — no SSE, just accumulate chunks.
 *
 * Routes via `streamChat` against the resolved use-case provider config.
 */
async function collectStreamedResponse(
  assignment: QualityAssignment,
  content: string,
): Promise<string> {
  const { sanitized } = sanitizeLlmInput(content);
  const systemPrompt = getSystemPrompt('analyze_quality');
  const generator = streamChat(assignment.config, assignment.model, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: sanitized },
  ]);

  let fullResponse = '';
  for await (const chunk of generator) {
    fullResponse += chunk.content;
  }
  return fullResponse;
}

/**
 * Analyze a single page's quality.
 */
async function analyzePageQuality(
  pageId: number,
  assignment: QualityAssignment,
  bodyHtml: string,
  bodyText: string,
  currentRetryCount: number = 0,
): Promise<void> {
  // Mark as analyzing
  await query(
    `UPDATE pages SET quality_status = 'analyzing' WHERE id = $1`,
    [pageId],
  );

  try {
    // Convert to markdown for LLM consumption (prefer bodyHtml for richer content)
    const markdown = bodyHtml ? htmlToMarkdown(bodyHtml) : bodyText;

    // Skip pages with insufficient content for meaningful analysis
    if (!markdown || markdown.trim().length < 50) {
      logger.debug({ pageId, contentLength: markdown?.length ?? 0 }, 'Skipping quality analysis — content too short');
      await query(
        `UPDATE pages SET quality_status = 'skipped' WHERE id = $1`,
        [pageId],
      );
      return;
    }

    const response = await collectStreamedResponse(assignment, markdown);
    const scores = parseQualityScores(response);

    if (!scores) {
      logger.warn({ pageId }, 'Failed to parse quality scores from LLM response');
      await query(
        `UPDATE pages
         SET quality_status = 'failed',
             quality_error = $2,
             quality_retry_count = $3,
             quality_analyzed_at = NOW()
         WHERE id = $1`,
        [pageId, 'Failed to parse structured quality scores from LLM output', currentRetryCount + 1],
      );
      return;
    }

    await query(
      `UPDATE pages
       SET quality_score = $2,
           quality_completeness = $3,
           quality_clarity = $4,
           quality_structure = $5,
           quality_accuracy = $6,
           quality_readability = $7,
           quality_summary = $8,
           quality_status = 'analyzed',
           quality_error = NULL,
           quality_retry_count = 0,
           quality_analyzed_at = NOW()
       WHERE id = $1`,
      [
        pageId,
        scores.overall,
        scores.completeness,
        scores.clarity,
        scores.structure,
        scores.accuracy,
        scores.readability,
        scores.summary,
      ],
    );

    logger.info({ pageId, score: scores.overall }, 'Quality analysis complete');
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : 'Unknown error';
    // Replace raw network errors with user-friendly messages
    const isTransient = /fetch failed|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|socket hang up/i.test(rawMessage);
    const message = isTransient
      ? 'Could not reach AI service — will retry on next cycle'
      : rawMessage;
    logger.error({ err, pageId }, 'Quality analysis failed for page');
    await query(
      `UPDATE pages
       SET quality_status = 'failed',
           quality_error = $2,
           quality_retry_count = $3,
           quality_analyzed_at = NOW()
       WHERE id = $1`,
      [pageId, message.slice(0, 1000), currentRetryCount + 1],
    );
  }
}

// ─── Batch processing ─────────────────────────────────────────────────────────

/**
 * Find and process a batch of pages needing quality analysis.
 *
 * Priority order:
 *   1. Unscored pages (quality_status = 'pending') — oldest sync first
 *   2. Content changed since last analysis (last_modified_at > quality_analyzed_at)
 *   3. Previously failed (quality_status = 'failed'), oldest failure first
 */
export async function processBatch(): Promise<number> {
  lastRunAt = new Date();
  // Resolve `{config, model}` at runtime — no cache, picks up admin edits
  // immediately via the provider cache-bus.
  const assignment = await resolveQualityAssignment();

  // When no provider/model can be resolved, mark pending pages as skipped
  // and return rather than making a call with an empty model name (which
  // would fail downstream and leave pages stuck in 'pending'). Hit when no
  // default provider is configured or the quality use case has no model set.
  if (!assignment || !assignment.model) {
    const flipped = await query(
      `UPDATE pages SET quality_status = 'skipped'
       WHERE quality_status = 'pending' AND deleted_at IS NULL`,
    );
    logger.warn(
      { providerId: assignment?.config.providerId, flippedToSkipped: flipped.rowCount ?? 0 },
      'No quality provider/model configured (Settings → LLM → Use case assignments). Marked pending pages as skipped — admin must call forceQualityRescan() to reprocess after fixing the config.',
    );
    return 0;
  }

  // Priority 1: Unscored pages (status = 'pending')
  const pendingResult = await query<{
    id: number;
    body_html: string;
    body_text: string;
    quality_retry_count: number;
  }>(
    `SELECT id, COALESCE(body_html, '') AS body_html, COALESCE(body_text, '') AS body_text, quality_retry_count
     FROM pages
     WHERE quality_status = 'pending'
       AND deleted_at IS NULL
       AND COALESCE(page_type, 'page') != 'folder'
       AND (body_text IS NOT NULL AND body_text != '')
     ORDER BY last_synced ASC
     LIMIT $1`,
    [QUALITY_BATCH_SIZE],
  );

  // Priority 2: Content changed since last analysis
  let pages = pendingResult.rows;
  if (pages.length < QUALITY_BATCH_SIZE) {
    const remaining = QUALITY_BATCH_SIZE - pages.length;
    const staleResult = await query<{
      id: number;
      body_html: string;
      body_text: string;
      quality_retry_count: number;
    }>(
      `SELECT id, COALESCE(body_html, '') AS body_html, COALESCE(body_text, '') AS body_text, quality_retry_count
       FROM pages
       WHERE quality_status = 'analyzed'
         AND deleted_at IS NULL
         AND COALESCE(page_type, 'page') != 'folder'
         AND last_modified_at > quality_analyzed_at
         AND (body_text IS NOT NULL AND body_text != '')
       ORDER BY last_modified_at DESC
       LIMIT $1`,
      [remaining],
    );
    pages = [...pages, ...staleResult.rows];
  }

  // Priority 3: Failed pages (retry up to MAX_RETRIES times)
  if (pages.length < QUALITY_BATCH_SIZE) {
    const remaining = QUALITY_BATCH_SIZE - pages.length;
    const failedResult = await query<{
      id: number;
      body_html: string;
      body_text: string;
      quality_retry_count: number;
    }>(
      `SELECT id, COALESCE(body_html, '') AS body_html, COALESCE(body_text, '') AS body_text, quality_retry_count
       FROM pages
       WHERE quality_status = 'failed'
         AND deleted_at IS NULL
         AND COALESCE(page_type, 'page') != 'folder'
         AND quality_retry_count < $2
         AND (body_text IS NOT NULL AND body_text != '')
       ORDER BY quality_analyzed_at ASC NULLS FIRST
       LIMIT $1`,
      [remaining, MAX_RETRIES],
    );
    pages = [...pages, ...failedResult.rows];
  }

  // Skip empty body_text pages
  const skippedResult = await query(
    `UPDATE pages
     SET quality_status = 'skipped'
     WHERE quality_status = 'pending'
       AND deleted_at IS NULL
       AND (body_text IS NULL OR body_text = '')`,
  );
  if (skippedResult.rowCount && skippedResult.rowCount > 0) {
    logger.info({ count: skippedResult.rowCount }, 'Skipped empty pages for quality analysis');
  }

  // Process each page sequentially (LLM calls are resource-intensive)
  for (const page of pages) {
    await analyzePageQuality(page.id, assignment, page.body_html, page.body_text, page.quality_retry_count);
  }

  return pages.length;
}

// ─── Worker lifecycle ─────────────────────────────────────────────────────────

/**
 * Start the background quality analysis worker.
 */
export function startQualityWorker(intervalMinutes?: number): void {
  if (qualityIntervalHandle) return;

  const interval = intervalMinutes ?? parseInt(process.env.QUALITY_CHECK_INTERVAL_MINUTES ?? '60', 10);
  const intervalMs = interval * 60 * 1000;

  qualityIntervalHandle = setInterval(async () => {
    if (qualityLock) return;
    const acquired = await acquireWorkerLock('quality-worker', 600);
    if (!acquired) return;
    qualityLock = true;
    isProcessing = true;

    try {
      const processed = await processBatch();
      if (processed > 0) {
        logger.info({ processed }, 'Quality analysis batch completed');
      }
    } catch (err) {
      logger.error({ err }, 'Quality analysis worker error');
    } finally {
      qualityLock = false;
      isProcessing = false;
      await releaseWorkerLock('quality-worker');
    }
  }, intervalMs);

  logger.info(
    { intervalMinutes: interval, batchSize: QUALITY_BATCH_SIZE },
    'Background quality analysis worker started (model resolved at batch time from admin settings)',
  );
}

/**
 * Trigger a single quality batch run with lock guards.
 * Safe to call from startup timers — will no-op if the worker is already processing.
 */
export async function triggerQualityBatch(): Promise<void> {
  if (qualityLock) return;
  const acquired = await acquireWorkerLock('quality-worker', 600);
  if (!acquired) return;
  qualityLock = true;
  isProcessing = true;

  try {
    const processed = await processBatch();
    if (processed > 0) {
      logger.info({ processed }, 'Initial quality analysis batch completed');
    }
  } catch (err) {
    logger.error({ err }, 'Initial quality analysis batch error');
  } finally {
    qualityLock = false;
    isProcessing = false;
    await releaseWorkerLock('quality-worker');
  }
}

/**
 * Stop the background quality analysis worker.
 */
export function stopQualityWorker(): void {
  if (qualityIntervalHandle) {
    clearInterval(qualityIntervalHandle);
    qualityIntervalHandle = null;
    logger.info('Background quality analysis worker stopped');
  }
}

/**
 * Force re-analysis of all pages (admin action).
 * Resets all quality statuses to 'pending'.
 */
export async function forceQualityRescan(): Promise<number> {
  const result = await query(
    `UPDATE pages SET quality_status = 'pending', quality_score = NULL, quality_error = NULL, quality_retry_count = 0 WHERE quality_status != 'pending' AND deleted_at IS NULL`,
  );
  const count = result.rowCount ?? 0;
  logger.info({ count }, 'Forced quality rescan — all pages reset to pending');
  return count;
}

/**
 * Get aggregate quality analysis status.
 */
export async function getQualityStatus(): Promise<{
  totalPages: number;
  analyzedPages: number;
  analyzingPages: number;
  pendingPages: number;
  failedPages: number;
  skippedPages: number;
  averageScore: number | null;
  isProcessing: boolean;
  lastRunAt: string | null;
  intervalMinutes: number;
  model: string;
}> {
  const [result, assignment] = await Promise.all([
    query<{
      total: string;
      analyzed: string;
      analyzing: string;
      pending: string;
      failed: string;
      skipped: string;
      avg_score: string | null;
    }>(
      `SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE quality_status = 'analyzed') AS analyzed,
         COUNT(*) FILTER (WHERE quality_status = 'analyzing') AS analyzing,
         COUNT(*) FILTER (WHERE quality_status = 'pending') AS pending,
         COUNT(*) FILTER (WHERE quality_status = 'failed') AS failed,
         COUNT(*) FILTER (WHERE quality_status = 'skipped') AS skipped,
         ROUND(AVG(quality_score) FILTER (WHERE quality_status = 'analyzed'))::TEXT AS avg_score
       FROM pages
       WHERE deleted_at IS NULL`,
    ),
    resolveQualityAssignment(),
  ]);

  const row = result.rows[0];
  if (!row) throw new Error('Expected a row from quality stats query');
  const intervalMinutes = parseInt(process.env.QUALITY_CHECK_INTERVAL_MINUTES ?? '60', 10);

  return {
    totalPages: parseInt(row.total, 10),
    analyzedPages: parseInt(row.analyzed, 10),
    analyzingPages: parseInt(row.analyzing, 10),
    pendingPages: parseInt(row.pending, 10),
    failedPages: parseInt(row.failed, 10),
    skippedPages: parseInt(row.skipped, 10),
    averageScore: row.avg_score ? parseInt(row.avg_score, 10) : null,
    isProcessing,
    lastRunAt: lastRunAt ? lastRunAt.toISOString() : null,
    intervalMinutes,
    model: assignment?.model ?? '',
  };
}
