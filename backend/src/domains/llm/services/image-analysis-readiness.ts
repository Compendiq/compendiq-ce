/**
 * ADR-027 "Readiness" — computed here (#1616), rendered by #1618's card.
 *
 * Per page, readiness is a PURE function of (row status, retained identity,
 * current version constants), and of nothing else: it never reads the clock,
 * so a `failed` row whose backoff has elapsed is still `failed` here until the
 * worker selects it and rewrites it; and it changes without a row write when
 * the retained identity or a constant changes — an `analyzed` row that then
 * fails D5's predicate counts as `pending` here, which the next sweep makes
 * literal.
 *
 * States are disjoint by construction, evaluated in this order, first match
 * wins: `none`, `complete`, `partial`, `pending`, `failed`, `skipped`.
 * Orthogonally, embedding readiness is `NOT pages.embedding_dirty`: "analysis
 * complete, text embedding pending" is `complete AND embedding_dirty`.
 */
import { query } from '../../../core/db/postgres.js';
import { getRetainedImageAnalysisIdentity } from './image-analysis-provider.js';
import {
  isValidAnalysisRow,
  validityParamValues,
  validitySql,
  type ValidityParams,
  type ValidityRow,
} from './image-analysis-validity.js';

export type ImageAnalysisReadiness = 'none' | 'complete' | 'partial' | 'pending' | 'failed' | 'skipped';

export const IMAGE_ANALYSIS_READINESS_STATES: readonly ImageAnalysisReadiness[] = [
  'none',
  'complete',
  'partial',
  'pending',
  'failed',
  'skipped',
];

/** The pure function. `rows` are the page's `page_image_analyses` rows. */
export function computeImageAnalysisReadiness(
  rows: readonly ValidityRow[],
  params: ValidityParams,
): ImageAnalysisReadiness {
  if (rows.length === 0) return 'none';
  let valid = 0;
  let pending = 0;
  let failed = 0;
  for (const row of rows) {
    if (isValidAnalysisRow(row, params)) valid++;
    else if (row.status === 'skipped') continue;
    else if (row.status === 'failed' || row.status === 'failed_terminal') failed++;
    // `pending`, and an `analyzed` row that fails the predicate (stale until
    // the sweep re-pends it), both read as pending.
    else pending++;
  }
  if (valid > 0 && pending + failed === 0) return 'complete';
  if (valid > 0) return 'partial';
  if (pending > 0) return 'pending';
  if (failed > 0) return 'failed';
  // Only `skipped` rows remain.
  return 'skipped';
}

export interface PageImageAnalysisReadiness {
  readiness: ImageAnalysisReadiness;
  /** `NOT pages.embedding_dirty` — the text embedder has caught up with the page. */
  embeddingReady: boolean;
}

/** One page's readiness, read under the retained identity. `null` for an unknown page. */
export async function readPageImageAnalysisReadiness(pageId: number): Promise<PageImageAnalysisReadiness | null> {
  const [retained, page, rows] = await Promise.all([
    getRetainedImageAnalysisIdentity(),
    query<{ embedding_dirty: boolean }>(`SELECT embedding_dirty FROM pages WHERE id = $1`, [pageId]),
    query<ValidityRow>(
      `SELECT status, identity_hash, prompt_version, schema_version
         FROM page_image_analyses WHERE page_id = $1`,
      [pageId],
    ),
  ]);
  const row = page.rows[0];
  if (!row) return null;
  return {
    readiness: computeImageAnalysisReadiness(rows.rows, { identityHash: retained?.identityHash ?? null }),
    embeddingReady: !row.embedding_dirty,
  };
}

export interface ImageAnalysisCorpusCounts {
  /** Rows by status; `analyzed` counts only VALID rows, the rest of them are `stale`. */
  rows: {
    analyzed: number;
    /** `analyzed` in the table but failing the validity predicate (awaiting the sweep). */
    stale: number;
    pending: number;
    failed: number;
    terminal: number;
    skipped: number;
  };
  skipReasons: Record<'missing' | 'unsupported' | 'oversized' | 'too_large' | 'external' | 'capped', number>;
  /** Live, non-folder pages still carrying `image_analysis_dirty`. */
  dirtyPages: number;
  /** Pages with ≥ 1 valid row that are still `embedding_dirty` ("analysis complete, text embedding pending"). */
  pagesAwaitingEmbed: number;
}

/** Corpus-wide counts for the card (#1618 renders them). */
export async function readImageAnalysisCorpusCounts(): Promise<ImageAnalysisCorpusCounts> {
  const retained = await getRetainedImageAnalysisIdentity();
  const validity = validityParamValues({ identityHash: retained?.identityHash ?? null });
  const [statusRes, skipRes, dirtyRes, awaitingRes] = await Promise.all([
    query<{ status: string; valid: boolean; n: string }>(
      `SELECT a.status, (${validitySql('a', 1, 2, 3)}) AS valid, COUNT(*)::text AS n
         FROM page_image_analyses a
        GROUP BY 1, 2`,
      validity,
    ),
    query<{ skip_reason: string; n: string }>(
      `SELECT skip_reason, COUNT(*)::text AS n FROM page_image_analyses
        WHERE status = 'skipped' GROUP BY 1`,
    ),
    query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM pages
        WHERE image_analysis_dirty AND deleted_at IS NULL AND COALESCE(page_type, 'page') <> 'folder'`,
    ),
    query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM pages p
        WHERE p.embedding_dirty AND p.deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM page_image_analyses a
                       WHERE a.page_id = p.id AND ${validitySql('a', 1, 2, 3)})`,
      validity,
    ),
  ]);

  const rows = { analyzed: 0, stale: 0, pending: 0, failed: 0, terminal: 0, skipped: 0 };
  for (const r of statusRes.rows) {
    const n = Number(r.n);
    if (r.status === 'analyzed') {
      if (r.valid) rows.analyzed += n;
      else rows.stale += n;
    } else if (r.status === 'pending') rows.pending += n;
    else if (r.status === 'failed') rows.failed += n;
    else if (r.status === 'failed_terminal') rows.terminal += n;
    else if (r.status === 'skipped') rows.skipped += n;
  }
  const skipReasons = { missing: 0, unsupported: 0, oversized: 0, too_large: 0, external: 0, capped: 0 };
  for (const r of skipRes.rows) {
    if (r.skip_reason in skipReasons) skipReasons[r.skip_reason as keyof typeof skipReasons] += Number(r.n);
  }
  return {
    rows,
    skipReasons,
    dirtyPages: Number(dirtyRes.rows[0]?.n ?? 0),
    pagesAwaitingEmbed: Number(awaitingRes.rows[0]?.n ?? 0),
  };
}
