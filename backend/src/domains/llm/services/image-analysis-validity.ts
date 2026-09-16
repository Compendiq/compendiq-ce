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
 * predicate is unsatisfiable, so a never-assigned instance composes nothing
 * (D9.2). The SQL form and the in-memory twin below agree on EVERY row on
 * their own — neither leans on migration 115's CHECK that an `analyzed` row
 * carries a hash and both versions: each SQL term is two-valued (`IS NOT
 * DISTINCT FROM`, plus an explicit "something is retained"), so the predicate
 * and its negation (the sweep's `NOT (…)`) are exact complements even for a
 * hash-less or version-less row, exactly as the strict `===` chain is.
 */
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
 * from {@link validityParamValues} at those positions. `$<hashParam>` may be
 * NULL (nothing retained), and a row's columns may be NULL: no term here can
 * evaluate to NULL, so `NOT (…)` selects exactly the rows
 * {@link isValidAnalysisRow} rejects.
 */
export function validitySql(
  alias: string,
  hashParam: number,
  promptParam: number,
  schemaParam: number,
): string {
  return (
    `${alias}.status = 'analyzed'` +
    ` AND $${hashParam}::text IS NOT NULL` +
    ` AND ${alias}.identity_hash IS NOT DISTINCT FROM $${hashParam}::text` +
    ` AND ${alias}.prompt_version IS NOT DISTINCT FROM $${promptParam}::int` +
    ` AND ${alias}.schema_version IS NOT DISTINCT FROM $${schemaParam}::int`
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
