/**
 * ADR-027 D5 — the ONE validity predicate every reader of
 * `page_image_analyses` uses: composition (`embedPage`), coverage, readiness
 * and the D13 invalidation sweep.
 *
 *   status = 'analyzed' AND identity_hash = $retained
 *     AND prompt_version = $IMAGE_ANALYSIS_PROMPT_VERSION
 *     AND schema_version = $IMAGE_ANALYSIS_SCHEMA_VERSION
 *
 * The two constants are bound from the running code on every query, never
 * stored in settings: a deploy that bumps one makes every analyzed row fail
 * at once, and the next sweep re-pends them. With no retained identity the
 * predicate is unsatisfiable — `identity_hash IS NOT DISTINCT FROM NULL` is
 * false for every analyzed row (the CHECK makes the hash NOT NULL there), so
 * a never-assigned instance composes nothing (D9.2).
 */
import { query } from '../../../core/db/postgres.js';
import { logger } from '../../../core/utils/logger.js';
import {
  IMAGE_ANALYSIS_PROMPT_VERSION,
  IMAGE_ANALYSIS_SCHEMA_VERSION,
} from './image-analysis-provider.js';

export interface ValidityParams {
  /** The retained `identityHash` (D7), or `null` when none is retained. */
  identityHash: string | null;
}

/** What the predicate needs from a row; a subset of `page_image_analyses`. */
export interface ValidityRow {
  status: string;
  identity_hash: string | null;
  prompt_version: number | null;
  schema_version: number | null;
}

/**
 * The SQL fragment, with the three values bound at `$<hashParam>`,
 * `$<promptParam>`, `$<schemaParam>`. Callers append the corresponding values
 * from {@link validityParamValues} at those positions.
 */
export function validitySql(
  alias: string,
  hashParam: number,
  promptParam: number,
  schemaParam: number,
): string {
  return (
    `${alias}.status = 'analyzed'` +
    ` AND ${alias}.identity_hash IS NOT DISTINCT FROM $${hashParam}` +
    ` AND ${alias}.prompt_version = $${promptParam}` +
    ` AND ${alias}.schema_version = $${schemaParam}`
  );
}

/** The bound values, in the order {@link validitySql} names them. */
export function validityParamValues(params: ValidityParams): [string | null, number, number] {
  return [params.identityHash, IMAGE_ANALYSIS_PROMPT_VERSION, IMAGE_ANALYSIS_SCHEMA_VERSION];
}

/** The same predicate over a row already in memory (readiness, tests). */
export function isValidAnalysisRow(row: ValidityRow, params: ValidityParams): boolean {
  return (
    row.status === 'analyzed' &&
    params.identityHash !== null &&
    row.identity_hash === params.identityHash &&
    row.prompt_version === IMAGE_ANALYSIS_PROMPT_VERSION &&
    row.schema_version === IMAGE_ANALYSIS_SCHEMA_VERSION
  );
}

/**
 * Whether `page_image_analyses` (migration 115, #1615) exists.
 *
 * The two ADR-027 packages merge in either order, and every reader of the
 * table on this side — composition on every embed, coverage on every hybrid
 * search, the worker on every cadence — must degrade to "no derived rows"
 * rather than fail while 115 is absent. A present table stays present, so the
 * positive answer is cached for the process; a negative one is re-checked
 * after {@link STORE_RECHECK_MS} so a rolling deploy that applies 115 is
 * noticed without a restart.
 */
const STORE_RECHECK_MS = 60_000;
let storePresent = false;
let storeCheckedAt = 0;

export async function imageAnalysisStorePresent(): Promise<boolean> {
  if (storePresent) return true;
  if (Date.now() - storeCheckedAt < STORE_RECHECK_MS) return false;
  storeCheckedAt = Date.now();
  try {
    const r = await query<{ present: string | null }>(
      `SELECT to_regclass('public.page_image_analyses')::text AS present`,
    );
    storePresent = r.rows[0]?.present != null;
  } catch (err) {
    logger.warn({ err }, 'Could not check for page_image_analyses — treating the store as absent');
    storePresent = false;
  }
  return storePresent;
}

/** Test seam: forget the cached answer (a suite that drops or restores the table). */
export function _resetImageAnalysisStorePresenceForTests(): void {
  storePresent = false;
  storeCheckedAt = 0;
}
