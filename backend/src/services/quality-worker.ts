/**
 * Background quality analyzer worker.
 *
 * Periodically scans cached_pages and runs LLM quality analysis in batches.
 * Modeled after sync-service.ts: setInterval scheduling, in-memory lock,
 * configurable interval and batch size via env vars.
 */

import { query } from '../db/postgres.js';
import { getSystemPrompt, streamChat } from './ollama-service.js';
import { sanitizeLlmInput } from '../utils/sanitize-llm-input.js';
import { htmlToMarkdown } from './content-converter.js';
import { logger } from '../utils/logger.js';

// ─── Configuration ────────────────────────────────────────────────────────────

const QUALITY_BATCH_SIZE = parseInt(process.env.QUALITY_BATCH_SIZE ?? '5', 10);
const QUALITY_MODEL = process.env.QUALITY_MODEL ?? process.env.LLM_DEFAULT_MODEL ?? 'qwen3:4b';

// ─── State ────────────────────────────────────────────────────────────────────

let qualityIntervalHandle: ReturnType<typeof setInterval> | null = null;
let qualityLock = false;
let isProcessing = false;

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
  const overallMatch = text.match(/##\s*Overall\s+Quality\s+Score:\s*(\d+)\s*\/\s*100/i);
  const completenessMatch = text.match(/##\s*Completeness:\s*(\d+)\s*\/\s*100/i);
  const clarityMatch = text.match(/##\s*Clarity:\s*(\d+)\s*\/\s*100/i);
  const structureMatch = text.match(/##\s*Structure:\s*(\d+)\s*\/\s*100/i);
  const accuracyMatch = text.match(/##\s*Accuracy:\s*(\d+)\s*\/\s*100/i);
  const readabilityMatch = text.match(/##\s*Readability:\s*(\d+)\s*\/\s*100/i);

  if (!overallMatch || !completenessMatch || !clarityMatch || !structureMatch || !accuracyMatch || !readabilityMatch) {
    return null;
  }

  // Extract summary section
  const summaryMatch = text.match(/##\s*Summary\s*\n([\s\S]*?)(?:\n##|$)/i);
  const summary = summaryMatch ? summaryMatch[1].trim() : '';

  const clamp = (n: number) => Math.max(0, Math.min(100, n));

  return {
    overall: clamp(parseInt(overallMatch[1], 10)),
    completeness: clamp(parseInt(completenessMatch[1], 10)),
    clarity: clamp(parseInt(clarityMatch[1], 10)),
    structure: clamp(parseInt(structureMatch[1], 10)),
    accuracy: clamp(parseInt(accuracyMatch[1], 10)),
    readability: clamp(parseInt(readabilityMatch[1], 10)),
    summary,
  };
}

// ─── Core analysis ────────────────────────────────────────────────────────────

/**
 * Collect the full streamed response from the quality analysis LLM call.
 * This is an internal batch job — no SSE, just accumulate chunks.
 */
async function collectStreamedResponse(content: string): Promise<string> {
  const { sanitized } = sanitizeLlmInput(content);
  const systemPrompt = getSystemPrompt('analyze_quality');
  const generator = streamChat(QUALITY_MODEL, [
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
  confluenceId: string,
  bodyHtml: string,
  bodyText: string,
): Promise<void> {
  // Mark as analyzing
  await query(
    `UPDATE cached_pages SET quality_status = 'analyzing' WHERE confluence_id = $1`,
    [confluenceId],
  );

  try {
    // Convert to markdown for LLM consumption (prefer bodyHtml for richer content)
    const markdown = bodyHtml ? htmlToMarkdown(bodyHtml) : bodyText;

    const response = await collectStreamedResponse(markdown);
    const scores = parseQualityScores(response);

    if (!scores) {
      logger.warn({ confluenceId }, 'Failed to parse quality scores from LLM response');
      await query(
        `UPDATE cached_pages
         SET quality_status = 'failed',
             quality_error = $2,
             quality_analyzed_at = NOW()
         WHERE confluence_id = $1`,
        [confluenceId, 'Failed to parse structured quality scores from LLM output'],
      );
      return;
    }

    await query(
      `UPDATE cached_pages
       SET quality_score = $2,
           quality_completeness = $3,
           quality_clarity = $4,
           quality_structure = $5,
           quality_accuracy = $6,
           quality_readability = $7,
           quality_summary = $8,
           quality_status = 'analyzed',
           quality_error = NULL,
           quality_analyzed_at = NOW()
       WHERE confluence_id = $1`,
      [
        confluenceId,
        scores.overall,
        scores.completeness,
        scores.clarity,
        scores.structure,
        scores.accuracy,
        scores.readability,
        scores.summary,
      ],
    );

    logger.info({ confluenceId, score: scores.overall }, 'Quality analysis complete');
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logger.error({ err, confluenceId }, 'Quality analysis failed for page');
    await query(
      `UPDATE cached_pages
       SET quality_status = 'failed',
           quality_error = $2,
           quality_analyzed_at = NOW()
       WHERE confluence_id = $1`,
      [confluenceId, message.slice(0, 1000)],
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
  // Priority 1: Unscored pages (status = 'pending')
  const pendingResult = await query<{
    confluence_id: string;
    body_html: string;
    body_text: string;
  }>(
    `SELECT confluence_id, COALESCE(body_html, '') AS body_html, COALESCE(body_text, '') AS body_text
     FROM cached_pages
     WHERE quality_status = 'pending'
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
      confluence_id: string;
      body_html: string;
      body_text: string;
    }>(
      `SELECT confluence_id, COALESCE(body_html, '') AS body_html, COALESCE(body_text, '') AS body_text
       FROM cached_pages
       WHERE quality_status = 'analyzed'
         AND last_modified_at > quality_analyzed_at
         AND (body_text IS NOT NULL AND body_text != '')
       ORDER BY last_modified_at DESC
       LIMIT $1`,
      [remaining],
    );
    pages = [...pages, ...staleResult.rows];
  }

  // Priority 3: Failed pages (retry up to MAX_RETRY_COUNT times)
  if (pages.length < QUALITY_BATCH_SIZE) {
    const remaining = QUALITY_BATCH_SIZE - pages.length;
    const failedResult = await query<{
      confluence_id: string;
      body_html: string;
      body_text: string;
    }>(
      `SELECT confluence_id, COALESCE(body_html, '') AS body_html, COALESCE(body_text, '') AS body_text
       FROM cached_pages
       WHERE quality_status = 'failed'
         AND (body_text IS NOT NULL AND body_text != '')
       ORDER BY quality_analyzed_at ASC NULLS FIRST
       LIMIT $1`,
      [remaining],
    );
    pages = [...pages, ...failedResult.rows];
  }

  // Skip empty body_text pages
  const skippedResult = await query(
    `UPDATE cached_pages
     SET quality_status = 'skipped'
     WHERE quality_status = 'pending'
       AND (body_text IS NULL OR body_text = '')`,
  );
  if (skippedResult.rowCount && skippedResult.rowCount > 0) {
    logger.info({ count: skippedResult.rowCount }, 'Skipped empty pages for quality analysis');
  }

  // Process each page sequentially (LLM calls are resource-intensive)
  for (const page of pages) {
    await analyzePageQuality(page.confluence_id, page.body_html, page.body_text);
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
    }
  }, intervalMs);

  logger.info({ intervalMinutes: interval, batchSize: QUALITY_BATCH_SIZE, model: QUALITY_MODEL }, 'Background quality analysis worker started');
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
    `UPDATE cached_pages SET quality_status = 'pending', quality_score = NULL, quality_error = NULL WHERE quality_status != 'pending'`,
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
  pendingPages: number;
  failedPages: number;
  skippedPages: number;
  averageScore: number | null;
  isProcessing: boolean;
}> {
  const result = await query<{
    total: string;
    analyzed: string;
    pending: string;
    failed: string;
    skipped: string;
    avg_score: string | null;
  }>(
    `SELECT
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE quality_status = 'analyzed') AS analyzed,
       COUNT(*) FILTER (WHERE quality_status = 'pending') AS pending,
       COUNT(*) FILTER (WHERE quality_status = 'failed') AS failed,
       COUNT(*) FILTER (WHERE quality_status = 'skipped') AS skipped,
       ROUND(AVG(quality_score) FILTER (WHERE quality_status = 'analyzed'))::TEXT AS avg_score
     FROM cached_pages`,
  );

  const row = result.rows[0];
  return {
    totalPages: parseInt(row.total, 10),
    analyzedPages: parseInt(row.analyzed, 10),
    pendingPages: parseInt(row.pending, 10),
    failedPages: parseInt(row.failed, 10),
    skippedPages: parseInt(row.skipped, 10),
    averageScore: row.avg_score ? parseInt(row.avg_score, 10) : null,
    isProcessing,
  };
}
