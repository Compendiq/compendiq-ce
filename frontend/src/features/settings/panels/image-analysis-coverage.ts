import type { ImageAnalysisStatus } from '@compendiq/contracts';

/**
 * #1618 — the corpus's analysis readiness, as the Image analysis card states
 * it in one sentence.
 *
 * Its own module rather than the card's, so the card file exports a component
 * and nothing else (Vite's Fast Refresh rule), and so the derivation is
 * testable without rendering.
 */

/** ADR-027's readiness vocabulary, evaluated over the whole corpus. */
export type ImageAnalysisCoverage = 'none' | 'complete' | 'partial' | 'pending' | 'failed' | 'skipped';

/**
 * The corpus's readiness, in the SAME vocabulary and the same first-match
 * order `image-analysis-readiness.ts` applies per page — so the card and the
 * per-page diagnostic never describe one instance in two languages.
 *
 * A `missing` skip is counted as OUTSTANDING rather than as a verdict, exactly
 * as readiness does: the page references evidence the index does not hold,
 * which beside a valid row is `partial`, not `complete`. Every other skip
 * reason is a decision already taken (policy, format, cap) and leaves
 * `complete` alone. Alone, a `missing` row is still `skipped`: nothing is in
 * the work window for it.
 */
export function imageAnalysisCoverage(status: {
  rows: ImageAnalysisStatus['rows'];
  skipReasons: ImageAnalysisStatus['skipReasons'];
}): ImageAnalysisCoverage {
  const { analyzed, stale, pending, failed, terminal, skipped } = status.rows;
  const total = analyzed + stale + pending + failed + terminal + skipped;
  if (total === 0) return 'none';
  const outstanding = stale + pending + failed + terminal + status.skipReasons.missing;
  if (analyzed > 0) return outstanding === 0 ? 'complete' : 'partial';
  if (stale + pending > 0) return 'pending';
  if (failed + terminal > 0) return 'failed';
  return 'skipped';
}

export const COVERAGE_SENTENCE: Record<ImageAnalysisCoverage, string> = {
  none: 'No page images have been seen yet. Images are picked up as pages sync or are edited.',
  complete: 'Every page image has a current description in the text index.',
  partial: 'Some page images are described; the rest are still queued, failed or missing.',
  pending: 'Page images are queued for analysis; none has a current description yet.',
  failed: 'No page image could be analyzed. Retry failed re-queues them with a fresh attempt budget.',
  skipped: 'Every page image was skipped by policy or format — none is in the work window.',
};
