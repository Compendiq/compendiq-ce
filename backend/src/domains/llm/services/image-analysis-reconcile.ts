/**
 * ADR-027 D4/D6 — the reconcile: step 2 of every analysis batch, run whether
 * or not a vision model is assigned.
 *
 * For one page: CLAIM `pages.image_analysis_dirty` (clear it BEFORE
 * enumerating — a writer that raises it during the reconcile raises it after
 * the claim, and the next pass re-enumerates; D6.2 inverts ADR-025 P2's
 * clear-at-the-end, which lost a raise that landed mid-scan), enumerate the
 * body's current image references, hash each survivor's bytes through the
 * shared intake, and upsert `page_image_analyses` rows so the table agrees
 * with the body again:
 *
 *  - a reference that is GONE from `body_html` deletes its row;
 *  - a row whose hash changed becomes `pending` with `payload = NULL,
 *    attempts = 0, next_attempt_at = NULL, error = NULL` — new bytes are a new
 *    image with a fresh attempt budget, whatever the old bytes did (a
 *    `failed_terminal` row leaves the terminal state here);
 *  - an ABSENT file (`ENOENT`) is not a deletion: an existing row is left
 *    untouched, and a `missing` skip is recorded only for a reference that
 *    has never had a row (the lazy re-fetch writer re-raises the flag when
 *    the bytes arrive). A file that is there but cannot be read (`EACCES`,
 *    `EIO`, …) is neither: the pass throws and the page stays dirty for the
 *    next cycle, because no row state describes "ask the disk again";
 *  - external keys are `skipped (external)` while `rag_image_index_external`
 *    is off, the first `rag_images_per_page_max` survivors are kept and the
 *    rest are `skipped (capped)`; a policy change flips rows in place.
 * The reconcile compares bytes and policy only, never page text: a caption,
 * heading or title edit changes no row, because those lines are composed from
 * the current page at embed time (D8/D9). The page is bumped —
 * `pages.image_analysis_revision + 1` and `embedding_dirty = TRUE` in ONE
 * statement (D6.3) — only when its VALID derived set changed: an `analyzed`
 * row was deleted, re-pended under new bytes, or moved to `skipped`. A new
 * `pending` or `skipped` row, or a `pending`/`failed` row re-pended, composes
 * nothing before and nothing after, so it bumps nothing: the first batch after
 * migration 115 lands over an existing corpus inserts `pending` rows for every
 * image page without re-embedding one of them. Because the reconcile runs
 * unassigned too, a pause never composes a description of bytes that are gone.
 *
 * A reconcile that throws re-raises the flag (D6.2).
 */
import type { PoolClient } from 'pg';
import type { PageSource } from '@compendiq/contracts';
import { getPool, query } from '../../../core/db/postgres.js';
import { logger } from '../../../core/utils/logger.js';
import {
  extractImageReferencesFromHtml,
  isExternalImageKey,
  type PageImageReference,
} from '../../../core/services/image-references.js';
import {
  getRagImageIndexExternal,
  getRagImagesPerPageMax,
} from '../../../core/services/admin-settings-service.js';
import { intakePageImage } from './image-intake.js';

/**
 * Thrown by the worker's `assertLockHeld` (D6.4) and recognised here so a
 * lost lease stops the pass instead of being counted as one page's failure.
 */
export class ImageAnalysisLeaseLostError extends Error {
  constructor() {
    super('Image analysis worker lock lost — batch stopped');
    this.name = 'ImageAnalysisLeaseLostError';
  }
}

export type ImageAnalysisSkipReason =
  | 'missing'
  | 'unsupported'
  | 'oversized'
  | 'too_large'
  | 'external'
  | 'capped';

export interface ReconcileCounts {
  /** Rows inserted or re-pended with new bytes — work for step 3. */
  pended: number;
  /** Rows written as `skipped` (policy or format), by reason. */
  skipped: Record<ImageAnalysisSkipReason, number>;
  /** Rows deleted because their reference left the body. */
  removed: number;
  /** References whose row already described the same bytes and policy. */
  unchanged: number;
}

export function emptyReconcileCounts(): ReconcileCounts {
  return {
    pended: 0,
    skipped: { missing: 0, unsupported: 0, oversized: 0, too_large: 0, external: 0, capped: 0 },
    removed: 0,
    unchanged: 0,
  };
}

export type ReconcileOutcome =
  | { claimed: false }
  | ({
      claimed: true;
      /** Whether any row was written or deleted. */
      changed: boolean;
      /** Whether the page was bumped (D6.3): an `analyzed` row left the valid derived set. */
      bumped: boolean;
    } & ReconcileCounts);

interface ClaimedPage {
  id: number;
  confluence_id: string | null;
  source: PageSource;
  body_html: string | null;
}

interface ExistingRow {
  id: number;
  source: string;
  attachment_key: string;
  content_hash: string;
  status: string;
  skip_reason: string | null;
}

/** What one reference should look like after this pass. */
type Desired =
  | { kind: 'work'; sha256: string; format: string; width: number; height: number }
  | { kind: 'skip'; reason: ImageAnalysisSkipReason; sha256: string | null; format: string | null }
  /** Unreadable with an existing row: leave it alone (not a deletion). */
  | { kind: 'keep' };

/** Reconcile one page. `assertLockHeld` runs before every write (D6.4). */
export async function reconcilePageImageAnalyses(
  pageId: number,
  assertLockHeld: () => Promise<void> = async () => undefined,
): Promise<ReconcileOutcome> {
  await assertLockHeld();
  const claim = await query<ClaimedPage>(
    `UPDATE pages SET image_analysis_dirty = FALSE
      WHERE id = $1 AND image_analysis_dirty
        AND deleted_at IS NULL AND COALESCE(page_type, 'page') <> 'folder'
      RETURNING id, confluence_id, source, body_html`,
    [pageId],
  );
  const page = claim.rows[0];
  if (!page) return { claimed: false };

  try {
    const counts = await reconcileClaimedPage(page, assertLockHeld);
    return { claimed: true, ...counts };
  } catch (err) {
    // D6.2: a reconcile that throws re-raises the flag, so the next pass
    // re-enumerates rather than leaving the table out of step with the body.
    await query(`UPDATE pages SET image_analysis_dirty = TRUE WHERE id = $1`, [pageId]).catch((raiseErr) => {
      logger.error({ err: raiseErr, pageId }, 'Could not re-raise image_analysis_dirty after a failed reconcile');
    });
    throw err;
  }
}

async function reconcileClaimedPage(
  page: ClaimedPage,
  assertLockHeld: () => Promise<void>,
): Promise<ReconcileCounts & { changed: boolean; bumped: boolean }> {
  const counts = emptyReconcileCounts();
  const [perPageMax, indexExternal] = await Promise.all([getRagImagesPerPageMax(), getRagImageIndexExternal()]);

  const allRefs = extractImageReferencesFromHtml(page.body_html);
  const existingRes = await query<ExistingRow>(
    `SELECT id, source, attachment_key, content_hash, status, skip_reason
       FROM page_image_analyses WHERE page_id = $1`,
    [page.id],
  );
  const existing = new Map<string, ExistingRow>(existingRes.rows.map((r) => [`${r.source}:${r.attachment_key}`, r]));

  // Policy first (external, then the cap — turning external indexing off
  // frees budget for the page's own images), then intake for the survivors.
  const desired = new Map<string, { ref: PageImageReference; want: Desired }>();
  let kept = 0;
  for (const ref of allRefs) {
    const key = `${ref.source}:${ref.key}`;
    if (!indexExternal && isExternalImageKey(ref.key)) {
      desired.set(key, { ref, want: { kind: 'skip', reason: 'external', sha256: null, format: null } });
      continue;
    }
    if (kept >= perPageMax) {
      desired.set(key, { ref, want: { kind: 'skip', reason: 'capped', sha256: null, format: null } });
      continue;
    }
    kept++;
    const intake = await intakePageImage(page, ref);
    if (intake.kind === 'unavailable') {
      // Not absent, not readable: no desired state can be written for this
      // reference, and writing `skipped (missing)` would park it behind a
      // state no re-read revisits. D6.2's path is the right one — the pass
      // throws, the flag is re-raised and the next cycle re-enumerates.
      throw new Error(`Image bytes unavailable for ${ref.source}:${ref.key} on page ${page.id}`, { cause: intake.error });
    }
    if (intake.kind === 'ok') {
      desired.set(key, {
        ref,
        want: { kind: 'work', sha256: intake.sha256, format: intake.format, width: intake.width, height: intake.height },
      });
    } else if (intake.reason === 'missing') {
      desired.set(key, { ref, want: existing.has(key) ? { kind: 'keep' } : { kind: 'skip', reason: 'missing', sha256: null, format: null } });
    } else {
      desired.set(key, { ref, want: { kind: 'skip', reason: intake.reason, sha256: intake.sha256 ?? null, format: null } });
    }
  }

  const gone = existingRes.rows.filter((r) => !desired.has(`${r.source}:${r.attachment_key}`));

  await assertLockHeld();
  const client: PoolClient = await getPool().connect();
  let changed = false;
  // `status = 'analyzed'` stands for "in the valid derived set": step 1 of
  // the same batch re-pended (and bumped for) every analyzed row that fails
  // the predicate, so what is still `analyzed` here is composed. An analyzed
  // row that turned stale since is over-bumped — one recompose — never missed.
  let bumped = false;
  try {
    await client.query('BEGIN');

    if (gone.length > 0) {
      const del = await client.query(`DELETE FROM page_image_analyses WHERE id = ANY($1::bigint[])`, [gone.map((r) => r.id)]);
      counts.removed = del.rowCount ?? 0;
      changed = changed || counts.removed > 0;
      bumped = bumped || gone.some((r) => r.status === 'analyzed');
    }

    for (const { ref, want } of desired.values()) {
      const key = `${ref.source}:${ref.key}`;
      const prior = existing.get(key);
      if (want.kind === 'keep') {
        counts.unchanged++;
        continue;
      }
      if (want.kind === 'work') {
        if (prior && prior.content_hash === want.sha256 && prior.status !== 'skipped') {
          counts.unchanged++;
          continue;
        }
        await client.query(
          `INSERT INTO page_image_analyses
             (page_id, source, attachment_key, content_hash, format, width, height, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
           ON CONFLICT (page_id, source, attachment_key) DO UPDATE SET
             content_hash = EXCLUDED.content_hash, format = EXCLUDED.format,
             width = EXCLUDED.width, height = EXCLUDED.height,
             status = 'pending', skip_reason = NULL,
             payload = NULL, attempts = 0, next_attempt_at = NULL, error = NULL,
             updated_at = NOW()`,
          [page.id, ref.source, ref.key, want.sha256, want.format, want.width, want.height],
        );
        counts.pended++;
        changed = true;
        bumped = bumped || prior?.status === 'analyzed';
        continue;
      }
      // want.kind === 'skip'
      if (prior && prior.status === 'skipped' && prior.skip_reason === want.reason) {
        counts.unchanged++;
        continue;
      }
      // `content_hash` and `format` are NOT NULL; a policy skip never read the
      // bytes, so an empty string stands for "no bytes were hashed for this
      // row" — never composed, never sent, and replaced the moment the row
      // becomes work again.
      await client.query(
        `INSERT INTO page_image_analyses
           (page_id, source, attachment_key, content_hash, format, status, skip_reason)
         VALUES ($1, $2, $3, $4, $5, 'skipped', $6)
         ON CONFLICT (page_id, source, attachment_key) DO UPDATE SET
           content_hash = EXCLUDED.content_hash, format = EXCLUDED.format,
           width = NULL, height = NULL,
           status = 'skipped', skip_reason = EXCLUDED.skip_reason,
           payload = NULL, attempts = 0, next_attempt_at = NULL, error = NULL,
           updated_at = NOW()`,
        [page.id, ref.source, ref.key, want.sha256 ?? '', want.format ?? '', want.reason],
      );
      counts.skipped[want.reason]++;
      changed = true;
      bumped = bumped || prior?.status === 'analyzed';
    }

    if (bumped) {
      // D6.3: the revision and the text flag move together, in one statement.
      await client.query(
        `UPDATE pages SET image_analysis_revision = image_analysis_revision + 1, embedding_dirty = TRUE
          WHERE id = $1`,
        [page.id],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  return { ...counts, changed, bumped };
}

/**
 * Run the reconcile over every dirty page, oldest-modified last (newest
 * first, like the legacy image scan). `maxPages` bounds a pass; a page that
 * throws is logged, left dirty (D6.2) and stepped past.
 */
export async function reconcileDirtyPages(
  assertLockHeld: () => Promise<void>,
  opts: { maxPages?: number } = {},
): Promise<ReconcileCounts & { pages: number; pagesFailed: number }> {
  const totals = { ...emptyReconcileCounts(), pages: 0, pagesFailed: 0 };
  const limit = opts.maxPages ?? Number.MAX_SAFE_INTEGER;
  const WINDOW = 100;
  // Claimed pages leave the predicate, so the window re-reads from the top;
  // pages that threw stay dirty and are stepped past with `id < $2`.
  let beforeId = Number.MAX_SAFE_INTEGER;
  for (;;) {
    if (totals.pages >= limit) break;
    const batch = await query<{ id: number }>(
      `SELECT id FROM pages
        WHERE image_analysis_dirty AND deleted_at IS NULL AND COALESCE(page_type, 'page') <> 'folder'
          AND id < $2::bigint
        ORDER BY id DESC
        LIMIT $1`,
      [Math.min(WINDOW, limit - totals.pages), beforeId],
    );
    if (batch.rows.length === 0) break;
    for (const row of batch.rows) {
      beforeId = row.id;
      try {
        const outcome = await reconcilePageImageAnalyses(row.id, assertLockHeld);
        if (!outcome.claimed) continue;
        totals.pages++;
        totals.pended += outcome.pended;
        totals.removed += outcome.removed;
        totals.unchanged += outcome.unchanged;
        for (const k of Object.keys(totals.skipped) as ImageAnalysisSkipReason[]) {
          totals.skipped[k] += outcome.skipped[k];
        }
      } catch (err) {
        if (err instanceof ImageAnalysisLeaseLostError) throw err;
        totals.pages++;
        totals.pagesFailed++;
        logger.error({ err, pageId: row.id }, 'Image analysis reconcile threw for a page — it stays dirty; continuing');
      }
    }
  }
  return totals;
}
