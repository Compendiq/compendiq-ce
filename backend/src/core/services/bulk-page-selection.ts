/**
 * Filter-based selection resolver for bulk page operations
 * (Compendiq/compendiq-ee#117).
 *
 * Two input shapes are supported:
 *   - `{ ids: string[] }`  — explicit list of page identifiers
 *   - `{ filter: BulkPageFilter, expectedCount: number }` — server resolves
 *     the matching pages from the same filter shape used by
 *     `GET /api/pages`. The client passes the count it observed in the
 *     preview; the server aborts with HTTP 409 when the live count diverges
 *     by more than `driftToleranceFraction` (default 5%).
 *
 * RBAC: the resolver always restricts results to pages the caller is
 * entitled to see — the same rule that gates `GET /api/pages`. Filter mode
 * MUST NOT widen the surface; an admin-only filter view (`/api/admin/...`)
 * passes its own widened scope via the `accessibleSpaces` parameter.
 *
 * Side effects: none. The resolver only reads from `pages`. Mutating routes
 * are responsible for their own UPDATE / DELETE work.
 */
import { z } from 'zod';
import { query } from '../db/postgres.js';

/**
 * Subset of the GET /pages filter shape that's safe + useful for bulk
 * operations. We intentionally exclude `search` (FTS+ILIKE fallback) and
 * `page` / `limit` / `sort`: bulk operations apply to the entire matching
 * set, not a paginated slice. Adding `search` later is straightforward but
 * deferred — typing a search term then bulk-acting on FTS scores is a
 * user-experience footgun.
 */
export const BulkPageFilterSchema = z
  .object({
    spaceKey: z.string().optional(),
    labels: z.string().optional(), // comma-separated, same convention as GET /pages
    source: z.enum(['confluence', 'standalone']).optional(),
    visibility: z.enum(['private', 'shared']).optional(),
    freshness: z.enum(['fresh', 'recent', 'aging', 'stale']).optional(),
    embeddingStatus: z.enum(['pending', 'done']).optional(),
    qualityMin: z.coerce.number().int().min(0).max(100).optional(),
    qualityMax: z.coerce.number().int().min(0).max(100).optional(),
    qualityStatus: z.enum(['pending', 'analyzing', 'analyzed', 'failed', 'skipped']).optional(),
    dateFrom: z.string().optional(),
    dateTo: z.string().optional(),
  })
  .strict();

export type BulkPageFilter = z.infer<typeof BulkPageFilterSchema>;

/**
 * Wire shape for any bulk route's `selection` body. Routes use this in
 * their request schema:
 *
 *   const Body = z.object({ selection: BulkSelectionSchema, ...other })
 */
export const BulkSelectionSchema = z
  .object({
    ids: z.array(z.string().min(1)).min(1).max(1000).optional(),
    filter: BulkPageFilterSchema.optional(),
    expectedCount: z.coerce.number().int().min(0).optional(),
    /**
     * Fraction of `expectedCount` we tolerate as drift between the user's
     * preview and the server-side resolution. 0 means exact-match required.
     * Default 0.05 (5%). Set 0 for risky operations (permission changes).
     */
    driftToleranceFraction: z.coerce.number().min(0).max(1).optional(),
  })
  .refine(
    (v) =>
      (v.ids && !v.filter && v.expectedCount === undefined) ||
      (!v.ids && v.filter && v.expectedCount !== undefined),
    {
      message:
        'Provide either { ids } or { filter, expectedCount }; do not mix or omit expectedCount in filter mode',
    },
  );

export type BulkSelection = z.infer<typeof BulkSelectionSchema>;

export interface ResolvedBulkRow {
  id: number;
  confluenceId: string | null;
  spaceKey: string | null;
  source: 'confluence' | 'standalone';
  /**
   * Existing label set on the page. Included in the SELECT so a single
   * resolver round-trip serves both the "which pages match" and the "what
   * are their current tags" needs of the tag/replace-tag routes.
   */
  labels: string[];
}

export interface BulkSelectionResolutionError {
  /**
   * Discriminator. `count_drift` maps to HTTP 409 in the route layer; the
   * shape is stable so the frontend can render a "the selection changed
   * since you previewed it" prompt without parsing the message.
   */
  kind: 'count_drift' | 'invalid_input';
  message: string;
  /** Counts only populated for `count_drift`. */
  expected?: number;
  actual?: number;
}

export interface ResolveBulkSelectionResult {
  rows: ResolvedBulkRow[];
  /** IDs supplied by the caller that did not resolve to any page (only for ids-mode). */
  notFoundIds: string[];
}

/**
 * Resolve a `{ ids } | { filter, expectedCount }` body to a list of pages.
 * Throws `BulkSelectionResolutionError` (as a plain object via Zod's
 * convention is not used — we just throw a regular Error with a structured
 * `cause` so the route layer can map to HTTP).
 */
export class BulkSelectionError extends Error {
  constructor(public detail: BulkSelectionResolutionError) {
    super(detail.message);
    this.name = 'BulkSelectionError';
  }
}

/**
 * Build the SQL filter fragment from a `BulkPageFilter`. Returns
 * `{ wherePart, values }` where `wherePart` joins to a base WHERE clause
 * supplied by the caller, and `values` are the positional parameters
 * matching `$startIdx..$startIdx+N`.
 *
 * Keep in sync with the filter clauses in `routes/knowledge/pages-crud.ts`
 * `GET /pages` (lines 185-268). We deliberately omit FTS search.
 */
export function buildFilterClauses(
  filter: BulkPageFilter,
  startIdx: number,
): { parts: string[]; values: unknown[]; nextIdx: number } {
  const parts: string[] = [];
  const values: unknown[] = [];
  let idx = startIdx;

  if (filter.spaceKey) {
    parts.push(`cp.space_key = $${idx++}`);
    values.push(filter.spaceKey);
  }

  if (filter.labels) {
    const labelList = filter.labels
      .split(',')
      .map((l) => l.trim())
      .filter(Boolean);
    if (labelList.length > 0) {
      parts.push(`cp.labels @> $${idx++}`);
      values.push(labelList);
    }
  }

  if (filter.source) {
    parts.push(`cp.source = $${idx++}`);
    values.push(filter.source);
  }

  if (filter.visibility) {
    parts.push(`cp.visibility = $${idx++}`);
    values.push(filter.visibility);
  }

  if (filter.freshness) {
    const map: Record<string, [string | null, string | null]> = {
      fresh:  [`NOW() - INTERVAL '7 days'`, null],
      recent: [`NOW() - INTERVAL '30 days'`, `NOW() - INTERVAL '7 days'`],
      aging:  [`NOW() - INTERVAL '90 days'`, `NOW() - INTERVAL '30 days'`],
      stale:  [null, `NOW() - INTERVAL '90 days'`],
    };
    const entry = map[filter.freshness];
    if (entry) {
      const [after, before] = entry;
      if (after) parts.push(`cp.last_modified_at >= ${after}`);
      if (before) parts.push(`cp.last_modified_at < ${before}`);
    }
  }

  if (filter.embeddingStatus) {
    parts.push(`cp.embedding_dirty = $${idx++}`);
    values.push(filter.embeddingStatus === 'pending');
  }

  if (filter.qualityMin !== undefined) {
    parts.push(`cp.quality_score >= $${idx++}`);
    values.push(filter.qualityMin);
  }
  if (filter.qualityMax !== undefined) {
    parts.push(`cp.quality_score <= $${idx++}`);
    values.push(filter.qualityMax);
  }
  if (filter.qualityStatus) {
    parts.push(`cp.quality_status = $${idx++}`);
    values.push(filter.qualityStatus);
  }

  if (filter.dateFrom) {
    parts.push(`cp.last_modified_at >= $${idx++}`);
    values.push(filter.dateFrom);
  }
  if (filter.dateTo) {
    parts.push(`cp.last_modified_at <= $${idx++}`);
    values.push(filter.dateTo);
  }

  return { parts, values, nextIdx: idx };
}

const DEFAULT_DRIFT_TOLERANCE = 0.05;

/**
 * Resolve a bulk selection body. The caller supplies the pre-fetched
 * `accessibleSpaces` (RBAC scope) so we don't double-fetch when the route
 * already has them.
 *
 * For ids-mode: queries `pages` filtered by id OR confluence_id, restricted
 * to the user's RBAC scope (own standalone OR accessible spaces). Returns
 * the matching rows + the input ids that didn't resolve.
 *
 * For filter-mode: builds the same WHERE clause that `GET /pages` would,
 * COUNTs, validates drift, then SELECTs the resolved rows. Throws
 * `BulkSelectionError` when drift exceeds tolerance.
 */
export async function resolveBulkSelection(
  userId: string,
  selection: BulkSelection,
  accessibleSpaces: string[],
  options: { idMode?: 'numeric-only' | 'mixed' } = {},
): Promise<ResolveBulkSelectionResult> {
  // -- ids mode --
  if (selection.ids) {
    const ids = selection.ids;
    const numericIds = ids.filter((id) => /^\d+$/.test(id)).map(Number);
    const confluenceStringIds =
      options.idMode === 'numeric-only' ? [] : ids.filter((id) => !/^\d+$/.test(id));

    const result = await query<{
      id: number;
      confluence_id: string | null;
      space_key: string | null;
      source: string;
      labels: string[] | null;
    }>(
      `SELECT cp.id, cp.confluence_id, cp.space_key, cp.source, cp.labels FROM pages cp
       WHERE (cp.id = ANY($1::int[]) OR cp.confluence_id = ANY($2::text[]))
         AND cp.deleted_at IS NULL
         AND ((cp.source = 'standalone' AND (cp.visibility = 'shared' OR cp.created_by_user_id = $3))
              OR cp.space_key = ANY($4::text[]))`,
      [numericIds, confluenceStringIds, userId, accessibleSpaces],
    );

    const rows: ResolvedBulkRow[] = result.rows.map((r) => ({
      id: r.id,
      confluenceId: r.confluence_id,
      spaceKey: r.space_key,
      source: r.source as 'confluence' | 'standalone',
      labels: r.labels ?? [],
    }));

    // Map each returned row back to the *original* id the caller supplied so
    // we can compute notFoundIds correctly. In `numeric-only` mode every
    // input is the integer PK; in `mixed` mode the input is whatever the
    // route accepted (PK for standalone pages, confluence_id for synced).
    const foundOriginal = new Set<string>(
      result.rows.map((r) => {
        if (options.idMode === 'numeric-only') return String(r.id);
        return r.source === 'standalone' ? String(r.id) : r.confluence_id ?? String(r.id);
      }),
    );
    const notFoundIds = ids.filter((id) => !foundOriginal.has(id));

    return { rows, notFoundIds };
  }

  // -- filter mode --
  if (!selection.filter || selection.expectedCount === undefined) {
    throw new BulkSelectionError({
      kind: 'invalid_input',
      message: 'Filter mode requires both `filter` and `expectedCount`',
    });
  }

  const tolerance = selection.driftToleranceFraction ?? DEFAULT_DRIFT_TOLERANCE;

  // Base WHERE clause matches the GET /pages RBAC + tombstone shape.
  const baseValues: unknown[] = [accessibleSpaces, userId];
  const { parts, values: filterValues } = buildFilterClauses(
    selection.filter,
    baseValues.length + 1,
  );
  const whereParts = ['cp.deleted_at IS NULL', ...parts];
  const where = `WHERE (
      (cp.source = 'confluence' AND cp.space_key = ANY($1::text[]))
      OR (cp.source = 'standalone' AND cp.visibility = 'shared')
      OR (cp.source = 'standalone' AND cp.visibility = 'private' AND cp.created_by_user_id = $2)
    ) AND ${whereParts.join(' AND ')}`;

  const allValues = [...baseValues, ...filterValues];

  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM pages cp ${where}`,
    allValues,
  );
  const actual = parseInt(countResult.rows[0]?.count ?? '0', 10);

  // Drift check — `expectedCount` of zero with tolerance 0 means "the user
  // is bulk-acting on an empty preview" which we treat as a no-op rather
  // than as a 409. Otherwise apply the fractional tolerance against the
  // expected count (so tiny selections don't false-positive on a 1-row drift
  // when tolerance > 0%).
  const expected = selection.expectedCount;
  if (expected === 0 && actual === 0) {
    return { rows: [], notFoundIds: [] };
  }
  // tolerance=0 → exact match required. Otherwise allow at least ±1 row of
  // drift even on tiny selections (a 1-page drift on a 5-row preview should
  // not 409 — that's noise, not a real change in the matching set).
  const allowedDrift =
    tolerance === 0 ? 0 : Math.max(1, Math.ceil(expected * tolerance));
  if (Math.abs(actual - expected) > allowedDrift) {
    throw new BulkSelectionError({
      kind: 'count_drift',
      message: `Selection drift exceeded tolerance: expected ~${expected} (±${allowedDrift}), got ${actual}`,
      expected,
      actual,
    });
  }

  // Hard cap on filter-mode selections. Bulk routes already cap ids[] at
  // 1000; filter mode should not be a backdoor around that. Bigger
  // operations should be split client-side.
  const HARD_CAP = 5000;
  const result = await query<{
    id: number;
    confluence_id: string | null;
    space_key: string | null;
    source: string;
    labels: string[] | null;
  }>(
    `SELECT cp.id, cp.confluence_id, cp.space_key, cp.source, cp.labels FROM pages cp ${where}
     ORDER BY cp.id ASC
     LIMIT ${HARD_CAP}`,
    allValues,
  );

  const rows: ResolvedBulkRow[] = result.rows.map((r) => ({
    id: r.id,
    confluenceId: r.confluence_id,
    spaceKey: r.space_key,
    source: r.source as 'confluence' | 'standalone',
    labels: r.labels ?? [],
  }));

  return { rows, notFoundIds: [] };
}
