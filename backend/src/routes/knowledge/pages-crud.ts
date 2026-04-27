import { FastifyInstance } from 'fastify';
import { query, getPool } from '../../core/db/postgres.js';
import { getFtsLanguage } from '../../core/services/fts-language.js';
import { RedisCache } from '../../core/services/redis-cache.js';
import { getClientForUser } from '../../domains/confluence/services/sync-service.js';
import { htmlToConfluence, confluenceToHtml } from '../../core/services/content-converter.js';
import { cleanPageAttachments, writeAttachmentCache } from '../../domains/confluence/services/attachment-handler.js';
import { logAuditEvent } from '../../core/services/audit-service.js';
import {
  startBulkJob,
  runBulkInChunks,
} from '../../core/services/bulk-page-progress.js';
import {
  BulkPageFilterSchema,
  resolveBulkSelection,
  BulkSelectionError,
  type BulkSelection,
} from '../../core/services/bulk-page-selection.js';
import { emitWebhookEvent } from '../../core/services/webhook-emit-hook.js';
import { processDirtyPages, isProcessingUser } from '../../domains/llm/services/embedding-service.js';
import { getUserAccessibleSpaces } from '../../core/services/rbac-service.js';
import { PageListQuerySchema, PageTreeQuerySchema, CreatePageSchema, UpdatePageSchema, SaveDraftSchema } from '@compendiq/contracts';
import { z } from 'zod';
import { logger } from '../../core/utils/logger.js';
import pLimit from 'p-limit';
import { readFile } from 'fs/promises';
import path from 'path';
import type { ConfluenceClient } from '../../domains/confluence/services/confluence-client.js';
import type { FastifyBaseLogger } from 'fastify';

/** Escape ILIKE metacharacters so user input like "100%" doesn't match all rows. */
function escapeIlikeTerm(term: string): string {
  return term.replace(/[%_\\]/g, '\\$&');
}

const ATTACHMENTS_BASE = process.env.ATTACHMENTS_DIR ?? 'data/attachments';

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
};

/**
 * Scan editor HTML for locally-pasted images (those with /api/attachments/ src
 * but missing data-confluence-filename). Upload each to Confluence as a page
 * attachment, then add data-confluence-filename so htmlToConfluence() generates
 * a valid ri:attachment reference.
 */
async function uploadLocalImagesToConfluence(
  html: string,
  confluencePageId: string,
  client: ConfluenceClient,
  log: FastifyBaseLogger,
): Promise<string> {
  // Quick check — skip DOM parsing if no pasted images
  if (!html.includes('/api/attachments/')) return html;

  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM(`<body>${html}</body>`, { contentType: 'text/html' });
  const doc = dom.window.document;

  const localImages = doc.querySelectorAll('img[src^="/api/attachments/"]');
  let changed = false;

  for (const img of localImages) {
    // Skip images that already have a Confluence filename (synced from Confluence)
    if (img.getAttribute('data-confluence-filename')) continue;
    if (img.getAttribute('data-confluence-image-source')) continue;

    const src = img.getAttribute('src') ?? '';
    // src = /api/attachments/{pageId}/{filename}
    const parts = src.split('/');
    const filename = decodeURIComponent(parts[parts.length - 1] ?? '');
    const pageId = parts[parts.length - 2] ?? '';
    if (!filename || !pageId) continue;

    // Read the file from local attachment cache.
    // Both `pageId` and `filename` are parsed out of the `src` attribute of
    // an <img> tag produced by our own editor and are passed through
    // `path.basename()` to strip any `..` / path separators before
    // concatenation with the trusted `ATTACHMENTS_BASE` root.
    // nosemgrep
    const filePath = path.join(ATTACHMENTS_BASE, path.basename(pageId), path.basename(filename));
    let fileData: Buffer;
    try {
      fileData = await readFile(filePath);
    } catch {
      log.warn({ filePath, filename }, 'Local pasted image not found, skipping upload');
      continue;
    }

    const ext = path.extname(filename).toLowerCase();
    const mimeType = MIME_BY_EXT[ext] ?? 'application/octet-stream';

    try {
      await client.updateAttachment(confluencePageId, filename, fileData, mimeType);
      // Mark as a Confluence attachment so htmlToConfluence() uses the right filename
      img.setAttribute('data-confluence-filename', filename);
      img.setAttribute('data-confluence-image-source', 'attachment');
      changed = true;
      log.info({ confluencePageId, filename }, 'Uploaded pasted image to Confluence');
    } catch (err) {
      log.error({ err, confluencePageId, filename }, 'Failed to upload pasted image to Confluence');
    }
  }

  return changed ? doc.body.innerHTML : html;
}

/**
 * Shared schema for the 4 existing bulk routes (delete/sync/embed/tag). Either
 * `ids` (legacy wire shape) OR `filter + expectedCount` (filter-mode added in
 * EE #117 slice 1c). Optional `jobId` enables SSE progress observation.
 */
const BulkIdsOrFilterSchema = z
  .object({
    ids: z.array(z.string().min(1)).min(1).max(1000).optional(),
    filter: BulkPageFilterSchema.optional(),
    expectedCount: z.coerce.number().int().min(0).optional(),
    driftToleranceFraction: z.coerce.number().min(0).max(1).optional(),
    jobId: z.string().uuid().optional(),
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
/**
 * Bulk-action selection mode (EE #117 slice 1b). Either `ids` (existing wire
 * shape) OR `filter` + `expectedCount` (new). The two are mutually exclusive
 * and refined-validated below; the existing `ids` clients keep working.
 */
const BulkTagSchema = z
  .object({
    ids: z.array(z.string().min(1)).min(1).max(1000).optional(),
    filter: BulkPageFilterSchema.optional(),
    expectedCount: z.coerce.number().int().min(0).optional(),
    driftToleranceFraction: z.coerce.number().min(0).max(1).optional(),
    addTags: z.array(z.string()).default([]),
    removeTags: z.array(z.string()).default([]),
    jobId: z.string().uuid().optional(),
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
/**
 * `bulk/replace-tags` (EE #117) — REPLACES the entire label set on each page.
 * Higher-risk than additive tag (`bulk/tag`), so the audit emission gets its
 * own action: `BULK_PAGE_TAGS_REPLACED`. Tags are normalised (lowercased,
 * trimmed, de-duplicated) at input to match the existing auto-tagger
 * convention.
 */
const BulkReplaceTagsSchema = z
  .object({
    ids: z.array(z.string().min(1)).min(1).max(1000).optional(),
    filter: BulkPageFilterSchema.optional(),
    expectedCount: z.coerce.number().int().min(0).optional(),
    driftToleranceFraction: z.coerce.number().min(0).max(1).optional(),
    tags: z.array(z.string()).max(50),
    jobId: z.string().uuid().optional(),
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
const IdParamSchema = z.object({ id: z.string().min(1) });

const ImageUploadSchema = z.object({
  dataUri: z.string().max(15_000_000), // ~10MB in base64
  filename: z.string().regex(/^[\w.-]+$/).max(255),
});

/** Allowed MIME types for pasted/dropped image uploads */
const ALLOWED_IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
]);

export async function pagesCrudRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);
  const cache = new RedisCache(fastify.redis);

  // GET /api/pages - list/search pages
  fastify.get('/pages', async (request) => {
    const userId = request.userId;
    const params = PageListQuerySchema.parse(request.query);
    const { spaceKey, search, author, labels, freshness, embeddingStatus, qualityMin, qualityMax, qualityStatus, source, dateFrom, dateTo, page = 1, limit = 50, sort = 'title' } = params;

    // Cache all page list queries. Filtered queries use a shorter TTL (2 min) vs
    // unfiltered (15 min) since filter results change more frequently (e.g. search
    // results after edits, embedding status during processing).
    const hasFilters = !!(search || author || labels || freshness || embeddingStatus || qualityMin !== undefined || qualityMax !== undefined || qualityStatus || source || dateFrom || dateTo);
    const filterParts = [spaceKey ?? '', search ?? '', author ?? '', labels ?? '', freshness ?? '', embeddingStatus ?? '', qualityMin ?? '', qualityMax ?? '', qualityStatus ?? '', source ?? '', dateFrom ?? '', dateTo ?? '', page, limit, sort].join(':');
    const cacheKey = `list:${filterParts}`;
    const cacheTtl = hasFilters ? 120 : 900; // 2 min for filtered, 15 min for unfiltered

    const cached = await cache.get(userId, 'pages', cacheKey);
    if (cached) return cached;

    const ftsLang = await getFtsLanguage();

    // Build WHERE clause from parts array for reuse in count query.
    // Using an array lets us swap the FTS condition for ILIKE on fallback
    // without fragile string replacement.
    // Access control: RBAC-based space access check
    //   - Confluence pages from user's accessible spaces (via RBAC)
    //   - Shared standalone articles (visible to all)
    //   - Their own private standalone articles
    const accessibleSpaces = await getUserAccessibleSpaces(userId);
    const whereBase = `WHERE (
        (cp.source = 'confluence' AND cp.space_key = ANY($1::text[]))
        OR (cp.source = 'standalone' AND cp.visibility = 'shared')
        OR (cp.source = 'standalone' AND cp.visibility = 'private' AND cp.created_by_user_id = $2)
      )`;
    const values: unknown[] = [accessibleSpaces, userId];
    let paramIdx = 3;

    // Collect additional AND conditions in an array so we can swap entries by index
    const whereParts: string[] = [];

    // Exclude soft-deleted pages from normal listings
    whereParts.push('cp.deleted_at IS NULL');

    if (spaceKey) {
      whereParts.push(`cp.space_key = $${paramIdx++}`);
      values.push(spaceKey);
    }

    // Track search clause index so we can swap FTS for ILIKE fallback later
    let searchClauseParamIdx = -1;
    let ftsWhereIndex = -1;
    let usedIlikeFallback = false;
    if (search && search.trim()) {
      // Full-text search using plainto_tsquery for safe handling of arbitrary user input
      searchClauseParamIdx = paramIdx;
      ftsWhereIndex = whereParts.length;
      whereParts.push(`cp.tsv @@ plainto_tsquery('${ftsLang}', $${paramIdx++})`);
      values.push(search.trim());
    }

    if (author) {
      whereParts.push(`cp.author = $${paramIdx++}`);
      values.push(author);
    }

    if (labels) {
      // labels is a comma-separated string; filter pages that contain ALL specified labels
      const labelList = labels.split(',').map((l) => l.trim()).filter(Boolean);
      if (labelList.length > 0) {
        whereParts.push(`cp.labels @> $${paramIdx++}`);
        values.push(labelList);
      }
    }

    if (freshness) {
      // Map freshness levels to day ranges based on FreshnessBadge logic
      const freshnessMap: Record<string, [string, string | null]> = {
        fresh:  [`NOW() - INTERVAL '7 days'`, null],
        recent: [`NOW() - INTERVAL '30 days'`, `NOW() - INTERVAL '7 days'`],
        aging:  [`NOW() - INTERVAL '90 days'`, `NOW() - INTERVAL '30 days'`],
        stale:  [null as unknown as string, `NOW() - INTERVAL '90 days'`],
      };
      const entry = freshnessMap[freshness];
      if (!entry) throw fastify.httpErrors.badRequest(`Unknown freshness level: ${freshness}`);
      const [after, before] = entry;
      if (after) {
        whereParts.push(`cp.last_modified_at >= ${after}`);
      }
      if (before) {
        whereParts.push(`cp.last_modified_at < ${before}`);
      }
    }

    if (embeddingStatus) {
      whereParts.push(`cp.embedding_dirty = $${paramIdx++}`);
      values.push(embeddingStatus === 'pending');
    }

    if (qualityMin !== undefined) {
      whereParts.push(`cp.quality_score >= $${paramIdx++}`);
      values.push(qualityMin);
    }

    if (qualityMax !== undefined) {
      whereParts.push(`cp.quality_score <= $${paramIdx++}`);
      values.push(qualityMax);
    }

    if (qualityStatus) {
      whereParts.push(`cp.quality_status = $${paramIdx++}`);
      values.push(qualityStatus);
    }

    if (source) {
      whereParts.push(`cp.source = $${paramIdx++}`);
      values.push(source);
    }

    if (dateFrom) {
      whereParts.push(`cp.last_modified_at >= $${paramIdx++}`);
      values.push(dateFrom);
    }

    if (dateTo) {
      whereParts.push(`cp.last_modified_at <= $${paramIdx++}`);
      values.push(dateTo);
    }

    // Build the final WHERE clause from base + parts
    const buildWhereClause = (parts: string[]) =>
      parts.length > 0 ? `${whereBase} AND ${parts.join(' AND ')}` : whereBase;

    const whereClause = buildWhereClause(whereParts);

    // Sort — 'relevance' uses ts_rank when a search term is present, falls back to 'title'
    const sortMap: Record<string, string> = {
      title: 'cp.title ASC',
      modified: 'cp.last_modified_at DESC NULLS LAST',
      author: 'cp.author ASC NULLS LAST',
      quality: 'cp.quality_score DESC NULLS LAST',
    };
    let orderBy: string;
    // For relevance sorting, ts_rank needs the search term as a parameter.
    // We track it separately so the count query (which doesn't use ORDER BY)
    // doesn't receive extra parameters that cause a bind mismatch.
    const orderByValues: unknown[] = [];
    if (sort === 'relevance' && search && search.trim()) {
      orderBy = `ts_rank(cp.tsv, plainto_tsquery('${ftsLang}', $${paramIdx++})) DESC`;
      orderByValues.push(search.trim());
    } else {
      orderBy = sortMap[sort] ?? sortMap.title!;
    }

    // --- Execute count + data query (with ILIKE fallback) ---

    type PageRow = {
      id: number;
      confluence_id: string | null;
      space_key: string | null;
      title: string;
      version: number;
      parent_id: string | null;
      labels: string[];
      author: string | null;
      last_modified_at: Date | null;
      last_synced: Date;
      embedding_dirty: boolean;
      embedding_status: string;
      embedded_at: Date | null;
      embedding_error: string | null;
      quality_score: number | null;
      quality_status: string | null;
      quality_completeness: number | null;
      quality_clarity: number | null;
      quality_structure: number | null;
      quality_accuracy: number | null;
      quality_readability: number | null;
      quality_summary: string | null;
      quality_analyzed_at: Date | null;
      quality_error: string | null;
      summary_status: string;
      source: string;
      visibility: string;
    };

    async function executeSearchQuery(wc: string, vals: unknown[], ob: string, pi: number, obVals: unknown[] = []) {
      // Count query uses only WHERE params (no ORDER BY params)
      const countSql = `SELECT COUNT(*) as count FROM pages cp ${wc}`;
      const countResult = await query<{ count: string }>(countSql, [...vals]);
      const countRow = countResult.rows[0];
      if (!countRow) throw new Error('Expected a row from COUNT query');
      const total = parseInt(countRow.count, 10);

      if (total === 0) {
        return { total: 0, rows: [] as PageRow[] };
      }

      const offset = (page - 1) * limit;
      const dataSql = `
        SELECT cp.id, cp.confluence_id, cp.space_key, cp.title, cp.version,
               cp.parent_id, cp.labels, cp.author, cp.last_modified_at, cp.last_synced,
               cp.embedding_dirty, cp.embedding_status, cp.embedded_at, cp.embedding_error,
               cp.quality_score, cp.quality_status, cp.quality_completeness, cp.quality_clarity,
               cp.quality_structure, cp.quality_accuracy, cp.quality_readability,
               cp.quality_summary, cp.quality_analyzed_at, cp.quality_error,
               cp.summary_status, cp.source, cp.visibility
        FROM pages cp
        ${wc}
        ORDER BY ${ob}
        LIMIT $${pi} OFFSET $${pi + 1}
      `;
      // Data query includes WHERE params + ORDER BY params + LIMIT/OFFSET
      const dataVals = [...vals, ...obVals, limit, offset];
      const result = await query<PageRow>(dataSql, dataVals);
      return { total, rows: result.rows };
    }

    // First attempt: FTS query
    let { total, rows } = await executeSearchQuery(whereClause, values, orderBy, paramIdx, orderByValues);

    // ILIKE fallback: when FTS returns 0 results and search term >= 3 chars,
    // retry with a broader ILIKE match on title + body_text.
    // Swap the FTS condition in the whereParts array by index (no fragile string replace).
    if (total === 0 && search && search.trim().length >= 3 && ftsWhereIndex !== -1) {
      const ilikeTerm = `%${escapeIlikeTerm(search.trim())}%`;
      const ilikeParts = [...whereParts];
      ilikeParts[ftsWhereIndex] = `(cp.title ILIKE $${searchClauseParamIdx} OR cp.body_text ILIKE $${searchClauseParamIdx})`;
      const ilikeWhereClause = buildWhereClause(ilikeParts);
      const ilikeValues = [...values];
      ilikeValues[searchClauseParamIdx - 1] = ilikeTerm;
      let ilikeOrderBy = orderBy;
      let ilikeObVals = orderByValues;
      if (sort === 'relevance') {
        ilikeOrderBy = 'cp.last_modified_at DESC NULLS LAST';
        ilikeObVals = [];
      }
      const fallbackResult = await executeSearchQuery(ilikeWhereClause, ilikeValues, ilikeOrderBy, paramIdx, ilikeObVals);
      total = fallbackResult.total;
      rows = fallbackResult.rows;
      usedIlikeFallback = true;
    }

    const response = {
      items: rows.map((row) => ({
        id: String(row.id),
        confluenceId: row.confluence_id,
        spaceKey: row.space_key,
        title: row.title,
        version: row.version,
        parentId: row.parent_id,
        labels: row.labels,
        author: row.author,
        lastModifiedAt: row.last_modified_at,
        lastSynced: row.last_synced,
        embeddingDirty: row.embedding_dirty,
        embeddingStatus: row.embedding_status,
        embeddedAt: row.embedded_at,
        embeddingError: row.embedding_error,
        qualityScore: row.quality_score,
        qualityStatus: row.quality_status,
        qualityCompleteness: row.quality_completeness,
        qualityClarity: row.quality_clarity,
        qualityStructure: row.quality_structure,
        qualityAccuracy: row.quality_accuracy,
        qualityReadability: row.quality_readability,
        qualitySummary: row.quality_summary,
        qualityAnalyzedAt: row.quality_analyzed_at,
        qualityError: row.quality_error,
        summaryStatus: row.summary_status,
        source: row.source,
        visibility: row.visibility,
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      ...(usedIlikeFallback ? { fuzzyMatch: true } : {}),
    };

    await cache.set(userId, 'pages', cacheKey, response, cacheTtl);

    return response;
  });

  // GET /api/pages/tree - all pages with minimal fields for hierarchy view
  fastify.get('/pages/tree', async (request) => {
    const userId = request.userId;
    const params = PageTreeQuerySchema.parse(request.query);

    const cacheKey = `tree:${params.spaceKey ?? 'all'}`;
    const cached = await cache.get(userId, 'pages', cacheKey);
    if (cached) return cached;

    // Access control via RBAC + local spaces (local spaces bypass RBAC)
    const rbacSpaces = await getUserAccessibleSpaces(userId);
    const localSpacesResult = await query<{ space_key: string }>(
      `SELECT space_key FROM spaces WHERE source = 'local'`,
    );
    const localSpaceKeys = localSpacesResult.rows.map((r) => r.space_key);
    const treeSpaces = Array.from(new Set([...rbacSpaces, ...localSpaceKeys]));
    const values: unknown[] = [treeSpaces];
    let treeWhereClause = 'WHERE cp.space_key = ANY($1::text[]) AND cp.deleted_at IS NULL';

    if (params.spaceKey) {
      treeWhereClause += ' AND cp.space_key = $2';
      values.push(params.spaceKey);
    }

    const result = await query<{
      id: number;
      confluence_id: string;
      space_key: string;
      title: string;
      page_type: string;
      parent_numeric_id: number | null;
      labels: string[];
      last_modified_at: Date | null;
      embedding_dirty: boolean;
      embedding_status: string;
      embedded_at: Date | null;
      embedding_error: string | null;
    }>(
      `SELECT cp.id, cp.confluence_id, cp.space_key, cp.title, cp.page_type,
              parent_page.id as parent_numeric_id,
              cp.labels, cp.last_modified_at,
              cp.embedding_dirty, cp.embedding_status, cp.embedded_at, cp.embedding_error
       FROM pages cp
       LEFT JOIN pages parent_page ON (
         parent_page.confluence_id = cp.parent_id
         OR CAST(parent_page.id AS TEXT) = cp.parent_id
       ) AND parent_page.deleted_at IS NULL
       ${treeWhereClause}
       ORDER BY cp.title ASC`,
      values,
    );

    const response = {
      items: result.rows.map((row) => ({
        id: String(row.id),
        spaceKey: row.space_key,
        title: row.title,
        pageType: row.page_type ?? 'page',
        parentId: row.parent_numeric_id ? String(row.parent_numeric_id) : null,
        labels: row.labels,
        lastModifiedAt: row.last_modified_at,
        embeddingDirty: row.embedding_dirty,
        embeddingStatus: row.embedding_status,
        embeddedAt: row.embedded_at,
        embeddingError: row.embedding_error,
      })),
      total: result.rows.length,
    };

    await cache.set(userId, 'pages', cacheKey, response);
    return response;
  });

  // GET /api/pages/filters - get available filter options (distinct authors, labels)
  // Cached in Redis with 5-minute TTL keyed by user's accessible space list.
  fastify.get('/pages/filters', async (request) => {
    const userId = request.userId;

    const filterSpaces = await getUserAccessibleSpaces(userId);

    // Cache key based on sorted space list to ensure consistency
    const spacesKey = [...filterSpaces].sort().join(',');
    const cacheKey = `filters:${spacesKey}`;

    const cached = await cache.get<{ authors: string[]; labels: string[] }>(userId, 'pages', cacheKey);
    if (cached) return cached;

    const [authorsResult, labelsResult] = await Promise.all([
      query<{ author: string }>(
        `SELECT DISTINCT cp.author FROM pages cp
         WHERE cp.space_key = ANY($1::text[])
           AND cp.author IS NOT NULL ORDER BY cp.author ASC`,
        [filterSpaces],
      ),
      query<{ label: string }>(
        `SELECT DISTINCT unnest(cp.labels) AS label FROM pages cp
         WHERE cp.space_key = ANY($1::text[])
         ORDER BY label ASC`,
        [filterSpaces],
      ),
    ]);

    const response = {
      authors: authorsResult.rows.map((r) => r.author),
      labels: labelsResult.rows.map((r) => r.label),
    };

    await cache.set(userId, 'pages', cacheKey, response, 300); // 5-minute TTL

    return response;
  });

  // GET /api/pages/trash - list soft-deleted standalone articles for the current user
  // Registered before /pages/:id to avoid Fastify treating "trash" as an :id param
  fastify.get('/pages/trash', async (request) => {
    const userId = request.userId;

    const result = await query<{
      id: number; title: string; source: string; visibility: string;
      deleted_at: Date; last_synced: Date;
    }>(
      `SELECT id, title, source, visibility, deleted_at, last_synced
       FROM pages
       WHERE source = 'standalone' AND deleted_at IS NOT NULL AND created_by_user_id = $1
       ORDER BY deleted_at DESC`,
      [userId],
    );

    return {
      items: result.rows.map((row) => ({
        id: String(row.id),
        title: row.title,
        source: row.source,
        visibility: row.visibility,
        deletedAt: row.deleted_at,
        createdAt: row.last_synced,
      })),
      total: result.rows.length,
    };
  });

  // GET /api/pages/:id - get page with content
  // Accepts integer page id (universal) or confluence_id string (backward compat)
  fastify.get('/pages/:id', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const userId = request.userId;

    // Determine lookup strategy: numeric ids use the integer PK, strings use confluence_id
    const isNumericId = /^\d+$/.test(id);

    const result = await query<{
      id: number;
      confluence_id: string | null;
      space_key: string | null;
      title: string;
      page_type: string;
      body_storage: string;
      body_html: string;
      body_text: string;
      version: number;
      parent_id: string | null;
      labels: string[];
      author: string | null;
      last_modified_at: Date | null;
      last_synced: Date;
      embedding_dirty: boolean;
      embedding_status: string;
      embedded_at: Date | null;
      embedding_error: string | null;
      has_children: boolean;
      quality_score: number | null;
      quality_status: string | null;
      quality_completeness: number | null;
      quality_clarity: number | null;
      quality_structure: number | null;
      quality_accuracy: number | null;
      quality_readability: number | null;
      quality_summary: string | null;
      quality_analyzed_at: Date | null;
      quality_error: string | null;
      summary_html: string | null;
      summary_status: string;
      summary_generated_at: Date | null;
      summary_model: string | null;
      summary_error: string | null;
      source: string;
      visibility: string;
      created_by_user_id: string | null;
      has_draft: boolean;
      draft_updated_at: Date | null;
    }>(
      `SELECT cp.id, cp.confluence_id, cp.space_key, cp.title, cp.page_type,
              cp.body_storage, cp.body_html, cp.body_text,
              cp.version, cp.parent_id, cp.labels, cp.author, cp.last_modified_at, cp.last_synced,
              cp.embedding_dirty, cp.embedding_status, cp.embedded_at, cp.embedding_error,
              cp.quality_score, cp.quality_status, cp.quality_completeness, cp.quality_clarity,
              cp.quality_structure, cp.quality_accuracy, cp.quality_readability,
              cp.quality_summary, cp.quality_analyzed_at, cp.quality_error,
              EXISTS(SELECT 1 FROM pages c2 WHERE c2.parent_id = cp.confluence_id AND cp.confluence_id IS NOT NULL AND c2.deleted_at IS NULL) as has_children,
              cp.summary_html, cp.summary_status, cp.summary_generated_at, cp.summary_model, cp.summary_error,
              cp.source, cp.visibility, cp.created_by_user_id,
              (cp.draft_body_html IS NOT NULL) as has_draft, cp.draft_updated_at
       FROM pages cp
       WHERE ${isNumericId ? 'cp.id = $1' : 'cp.confluence_id = $1'}
         AND cp.deleted_at IS NULL`,
      [isNumericId ? parseInt(id, 10) : id],
    );

    if (result.rows.length === 0) {
      throw fastify.httpErrors.notFound('Page not found');
    }

    const row = result.rows[0]!;

    // Access control: Confluence pages require RBAC space access; standalone pages
    // require ownership or shared visibility
    if (row.source === 'confluence') {
      const spaces = await getUserAccessibleSpaces(userId);
      if (!row.space_key || !spaces.includes(row.space_key)) {
        throw fastify.httpErrors.notFound('Page not found');
      }
    } else {
      // Standalone: owner or shared
      if (row.created_by_user_id !== userId && row.visibility !== 'shared') {
        throw fastify.httpErrors.notFound('Page not found');
      }
    }

    return {
      id: String(row.id),
      confluenceId: row.confluence_id,
      spaceKey: row.space_key,
      title: row.title,
      pageType: row.page_type ?? 'page',
      bodyHtml: row.body_html,
      bodyText: row.body_text,
      version: row.version,
      parentId: row.parent_id,
      labels: row.labels,
      author: row.author,
      lastModifiedAt: row.last_modified_at,
      lastSynced: row.last_synced,
      hasChildren: row.has_children,
      embeddingDirty: row.embedding_dirty,
      embeddingStatus: row.embedding_status,
      embeddedAt: row.embedded_at,
      embeddingError: row.embedding_error,
      qualityScore: row.quality_score,
      qualityStatus: row.quality_status,
      qualityCompleteness: row.quality_completeness,
      qualityClarity: row.quality_clarity,
      qualityStructure: row.quality_structure,
      qualityAccuracy: row.quality_accuracy,
      qualityReadability: row.quality_readability,
      qualitySummary: row.quality_summary,
      qualityAnalyzedAt: row.quality_analyzed_at,
      qualityError: row.quality_error,
      summaryHtml: row.summary_html,
      summaryStatus: row.summary_status,
      summaryGeneratedAt: row.summary_generated_at,
      summaryModel: row.summary_model,
      summaryError: row.summary_error,
      source: row.source,
      visibility: row.visibility,
      hasDraft: row.has_draft,
      draftUpdatedAt: row.draft_updated_at?.toISOString() ?? null,
    };
  });

  /**
   * @deprecated Use the `hasChildren` field from GET /api/pages/:id instead.
   * This dedicated endpoint is kept for backwards compatibility and will be
   * removed in a future release.
   */
  // GET /api/pages/:id/has-children - check if a page has sub-pages
  fastify.get('/pages/:id/has-children', async (request) => {
    const { id } = IdParamSchema.parse(request.params);

    const result = await query<{ count: string }>(
      'SELECT COUNT(*) as count FROM pages WHERE parent_id = $1 AND deleted_at IS NULL',
      [id],
    );

    const row = result.rows[0];
    if (!row) throw new Error('Expected a row from COUNT query');
    return { hasChildren: parseInt(row.count, 10) > 0 };
  });

  // GET /api/pages/:id/children - list child pages for the Confluence Children macro
  const ChildrenQuerySchema = z.object({
    sort: z.enum(['title', 'created_at']).default('title'),
    order: z.enum(['asc', 'desc']).default('asc'),
    depth: z.coerce.number().int().min(1).max(3).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  });

  fastify.get('/pages/:id/children', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const userId = request.userId;
    const params = ChildrenQuerySchema.parse(request.query);
    const { sort, order, depth } = params;

    // Resolve page: try confluence_id first, then integer id
    const isNumericId = /^\d+$/.test(id);
    const pageResult = await query<{ id: number; confluence_id: string | null; space_key: string | null; source: string; visibility: string; created_by_user_id: string | null }>(
      `SELECT id, confluence_id, space_key, source, visibility, created_by_user_id FROM pages
       WHERE ${isNumericId ? '(confluence_id = $1 OR id = $1::int)' : 'confluence_id = $1'}
         AND deleted_at IS NULL
       LIMIT 1`,
      [isNumericId ? id : id],
    );

    if (pageResult.rows.length === 0) {
      throw fastify.httpErrors.notFound('Page not found');
    }

    const page = pageResult.rows[0]!;

    // Access control: same pattern as GET /pages/:id
    if (page.source === 'confluence') {
      const spaces = await getUserAccessibleSpaces(userId);
      if (!page.space_key || !spaces.includes(page.space_key)) {
        throw fastify.httpErrors.notFound('Page not found');
      }
    } else {
      if (page.created_by_user_id !== userId && page.visibility !== 'shared') {
        throw fastify.httpErrors.notFound('Page not found');
      }
    }

    // Children are linked via parent_id which stores the confluence_id string
    const parentLookupId = page.confluence_id ?? String(page.id);

    // Validate sort column to prevent SQL injection (only allow whitelisted values)
    const sortColumn = sort === 'created_at' ? 'created_at' : 'title';
    const sortOrder = order === 'desc' ? 'DESC' : 'ASC';

    // Cap total nodes to prevent unbounded recursive queries (DoS protection)
    const MAX_TOTAL_NODES = 200;

    // Single recursive CTE replaces the N+1 fetchChildren() function.
    // Fetches the entire subtree in one round-trip, then assembles the
    // tree structure in application code.
    type FlatChildRow = {
      id: number;
      confluence_id: string | null;
      title: string;
      space_key: string | null;
      parent_id: string | null;
      depth: number;
    };

    const treeResult = await query<FlatChildRow>(
      `WITH RECURSIVE tree AS (
         SELECT p.id, p.confluence_id, p.title, p.space_key, p.parent_id, 1 AS depth
         FROM pages p
         WHERE p.parent_id = $1 AND p.deleted_at IS NULL
         UNION ALL
         SELECT p.id, p.confluence_id, p.title, p.space_key, p.parent_id, t.depth + 1
         FROM pages p
         JOIN tree t ON p.parent_id = COALESCE(t.confluence_id, t.id::text)
         WHERE p.deleted_at IS NULL AND t.depth < $2
       )
       SELECT * FROM tree ORDER BY depth, ${sortColumn} ${sortOrder}
       LIMIT $3`,
      [parentLookupId, depth, MAX_TOTAL_NODES],
    );

    // Assemble flat rows into nested tree structure
    type ChildNode = { id: number; confluenceId: string | null; title: string; spaceKey: string | null; children?: ChildNode[] };
    const nodeMap = new Map<string, ChildNode>();
    const roots: ChildNode[] = [];

    for (const row of treeResult.rows) {
      const node: ChildNode = {
        id: row.id,
        confluenceId: row.confluence_id,
        title: row.title,
        spaceKey: row.space_key,
      };
      const nodeKey = row.confluence_id ?? String(row.id);
      nodeMap.set(nodeKey, node);

      if (row.parent_id === parentLookupId) {
        roots.push(node);
      } else if (row.parent_id) {
        const parent = nodeMap.get(row.parent_id);
        if (parent) {
          if (!parent.children) parent.children = [];
          parent.children.push(node);
        }
      }
    }

    return { children: roots };
  });

  // POST /api/pages/:id/restore - restore a soft-deleted standalone article from trash
  fastify.post('/pages/:id/restore', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const userId = request.userId;

    const existing = await query<{
      id: number; title: string; source: string;
      created_by_user_id: string | null; deleted_at: Date | null;
    }>(
      'SELECT id, title, source, created_by_user_id, deleted_at FROM pages WHERE id = $1',
      [id],
    );
    if (existing.rows.length === 0) {
      throw fastify.httpErrors.notFound('Page not found');
    }

    const page = existing.rows[0]!;
    if (page.source !== 'standalone') {
      throw fastify.httpErrors.badRequest('Only standalone articles can be restored');
    }
    if (page.created_by_user_id !== userId) {
      throw fastify.httpErrors.forbidden('Not the owner');
    }
    if (!page.deleted_at) {
      throw fastify.httpErrors.badRequest('Page is not in trash');
    }

    await query('UPDATE pages SET deleted_at = NULL WHERE id = $1', [page.id]);

    await cache.invalidate(userId, 'pages');
    await logAuditEvent(userId, 'PAGE_RESTORED', 'page', String(id),
      { source: 'standalone', title: page.title }, request);

    return { id: page.id, title: page.title, restored: true };
  });

  // POST /api/pages - create page (standalone local or Confluence + local cache)
  fastify.post('/pages', async (request) => {
    const body = CreatePageSchema.parse(request.body);
    const pageType: 'page' | 'folder' = (body as Record<string, unknown>).pageType === 'folder' ? 'folder' : 'page';
    const userId = request.userId;

    // Auto-detect whether this is a Confluence or standalone page based on the
    // space source. This fixes #468 where the frontend defaults source to
    // 'standalone' but the user selected a Confluence space.
    // The frontend sends '__local__' as a sentinel for local articles (e.g.
    // NewPagePage, SidebarTreeView). Skip the space lookup for sentinels.
    let spaceSource: string | null = null;
    if (body.spaceKey && body.spaceKey !== '__local__') {
      const spaceRow = await query<{ source: string }>(
        'SELECT source FROM spaces WHERE space_key = $1',
        [body.spaceKey],
      );
      if (spaceRow.rows.length > 0) {
        spaceSource = spaceRow.rows[0]!.source;
      }
    }

    // Explicit source takes precedence over auto-detection
    let isStandalone: boolean;
    if (body.source === 'standalone') {
      isStandalone = true;
    } else if (body.source === 'confluence') {
      isStandalone = false;
    } else {
      // Auto-detect from space source
      isStandalone = spaceSource !== 'confluence';
    }

    if (isStandalone) {
      // --- Standalone article: no Confluence call, store locally ---
      const isFolder = pageType === 'folder';
      const effectiveBodyHtml = isFolder ? '' : body.bodyHtml;
      const { htmlToText } = await import('../../core/services/content-converter.js');
      const bodyText = isFolder ? '' : htmlToText(effectiveBodyHtml);

      // Use space key only for local spaces (already looked up above)
      const spaceKey: string | null = spaceSource === 'local' ? body.spaceKey! : null;

      // Validate and compute path if parentId is provided
      let parentPath: string | null = null;
      if (body.parentId) {
        const parentResult = await query<{ path: string | null; space_key: string | null }>(
          'SELECT path, space_key FROM pages WHERE id = $1 AND deleted_at IS NULL',
          [body.parentId],
        );
        if (parentResult.rows.length === 0) {
          throw fastify.httpErrors.badRequest('Parent page not found');
        }
        // Verify parent belongs to the same space (when a space is specified)
        if (spaceKey && parentResult.rows[0]!.space_key !== spaceKey) {
          throw fastify.httpErrors.badRequest('Parent page must belong to the same space');
        }
        parentPath = parentResult.rows[0]!.path;
      }

      const result = await query<{ id: number; title: string; version: number }>(
        `INSERT INTO pages
           (title, body_html, body_text, body_storage, source, created_by_user_id,
            visibility, version, space_key, confluence_id, parent_id,
            page_type, embedding_dirty, embedding_status, last_synced)
         VALUES ($1, $2, $3, NULL, 'standalone', $4, $5, 1, $6, NULL, $7,
                 $8, $9, 'not_embedded', NOW())
         RETURNING id, title, version`,
        [body.title, effectiveBodyHtml, bodyText, userId,
         body.visibility ?? 'shared', spaceKey, body.parentId ?? null,
         pageType, !isFolder],
      );

      const newPage = result.rows[0]!;

      // Compute and set materialized path now that we have the page id
      const newPath = parentPath ? `${parentPath}/${newPage.id}` : `/${newPage.id}`;
      const depth = newPath.split('/').filter(Boolean).length - 1;
      await query('UPDATE pages SET path = $1, depth = $2 WHERE id = $3',
        [newPath, depth, newPage.id]);

      await cache.invalidate(userId, 'pages');
      await logAuditEvent(userId, 'PAGE_CREATED', 'page', String(newPage.id),
        { source: 'standalone', title: body.title, visibility: body.visibility ?? 'shared', spaceKey, pageType }, request);

      emitWebhookEvent({
        eventType: 'page.created',
        payload: {
          pageId: newPage.id,
          title: newPage.title,
          spaceKey,
          isLocal: true,
          createdAt: new Date().toISOString(),
        },
      });

      return { id: newPage.id, title: newPage.title, version: newPage.version, source: 'standalone', pageType };
    }

    // --- Confluence article: existing flow ---
    const client = await getClientForUser(userId);
    if (!client) {
      throw fastify.httpErrors.badRequest('Confluence not configured');
    }

    // Convert TipTap HTML to Confluence storage format
    const storageBody = htmlToConfluence(body.bodyHtml);

    // Resolve parentId: frontend may send internal DB id (numeric) instead of confluence_id
    let confluenceParentId = body.parentId;
    if (confluenceParentId && /^\d+$/.test(confluenceParentId)) {
      const parentLookup = await query<{ confluence_id: string | null }>(
        'SELECT confluence_id FROM pages WHERE id = $1::int OR confluence_id = $2',
        [confluenceParentId, confluenceParentId],
      );
      if (parentLookup.rows[0]?.confluence_id) {
        confluenceParentId = parentLookup.rows[0].confluence_id;
      }
    }

    const page = await client.createPage(body.spaceKey!, body.title, storageBody, confluenceParentId);

    // Convert back to clean HTML for local cache
    const bodyHtml = confluenceToHtml(page.body?.storage?.value ?? storageBody, page.id, body.spaceKey!);
    const { htmlToText } = await import('../../core/services/content-converter.js');
    const bodyText = htmlToText(bodyHtml);

    // Store in local cache (shared table, no user_id)
    await query(
      `INSERT INTO pages
         (confluence_id, space_key, title, body_storage, body_html, body_text,
          version, parent_id, source, embedding_dirty, embedding_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'confluence', TRUE, 'not_embedded')
       ON CONFLICT (confluence_id) WHERE confluence_id IS NOT NULL DO UPDATE SET
         title = EXCLUDED.title, body_storage = EXCLUDED.body_storage, body_html = EXCLUDED.body_html,
         body_text = EXCLUDED.body_text, version = EXCLUDED.version, last_synced = NOW()`,
      [page.id, body.spaceKey, body.title, page.body?.storage?.value ?? storageBody,
       bodyHtml, bodyText, page.version.number, body.parentId ?? null],
    );

    // Invalidate cache
    await cache.invalidate(userId, 'pages');
    await cache.invalidate(userId, 'spaces');

    await logAuditEvent(userId, 'PAGE_CREATED', 'page', page.id, { spaceKey: body.spaceKey, title: body.title }, request);

    emitWebhookEvent({
      eventType: 'page.created',
      payload: {
        pageId: page.id,
        title: page.title,
        spaceKey: body.spaceKey ?? null,
        isLocal: false,
        createdAt: new Date().toISOString(),
      },
    });

    return { id: page.id, title: page.title, version: page.version.number, source: 'confluence' };
  });

  // PUT /api/pages/:id - update page (standalone local or Confluence + local cache)
  // Accepts integer page id (universal) or confluence_id string (backward compat)
  fastify.put('/pages/:id', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const body = UpdatePageSchema.parse(request.body);
    const userId = request.userId;

    const isNumericId = /^\d+$/.test(id);

    // Load the page to determine source
    const existing = await query<{
      id: number; version: number; space_key: string | null;
      source: string; created_by_user_id: string | null;
      visibility: string; confluence_id: string | null; deleted_at: Date | null;
      page_type: string;
    }>(
      `SELECT id, version, space_key, source, created_by_user_id, visibility, confluence_id, deleted_at, page_type FROM pages WHERE ${isNumericId ? 'id = $1' : 'confluence_id = $1'}`,
      [isNumericId ? parseInt(id, 10) : id],
    );
    if (existing.rows.length === 0) {
      throw fastify.httpErrors.notFound('Page not found');
    }
    const existingPage = existing.rows[0]!;

    if (existingPage.deleted_at) {
      throw fastify.httpErrors.badRequest('Cannot edit a page that is in the trash');
    }

    // Folders are title-only containers; reject body content updates
    if (existingPage.page_type === 'folder' && body.bodyHtml && body.bodyHtml.trim() !== '') {
      throw fastify.httpErrors.badRequest('Folder pages cannot have body content. Only the title can be updated.');
    }

    if (existingPage.source === 'standalone') {
      // --- Standalone article: no Confluence call ---

      // Access control: only owner or shared pages can be edited
      if (existingPage.created_by_user_id !== userId && existingPage.visibility !== 'shared') {
        throw fastify.httpErrors.forbidden('Not authorized to edit this page');
      }

      // Optimistic concurrency check
      if (body.version !== undefined && body.version < existingPage.version) {
        throw fastify.httpErrors.conflict('Page has been modified since you loaded it. Please refresh and try again.');
      }

      const { htmlToText } = await import('../../core/services/content-converter.js');
      const bodyText = htmlToText(body.bodyHtml);
      const newVersion = existingPage.version + 1;

      // Parameter-index layout (must stay in sync with the two branches
      // of the values array below):
      //   $1 = id, $2 = title, $3 = bodyHtml, $4 = bodyText, $5 = newVersion
      // When body.visibility is set   → $6 = visibility, $7 = userId  (7 params)
      // When body.visibility is unset → $6 = userId                   (6 params)
      // The `$${body.visibility ? 7 : 6}` expression picks the correct
      // index for local_modified_by based on whether the visibility
      // column is being written in the same statement.
      const userIdParamIndex = body.visibility ? 7 : 6;
      await query(
        `UPDATE pages SET
           title = $2, body_html = $3, body_text = $4,
           version = $5, last_modified_at = NOW(), embedding_dirty = TRUE,
           embedding_status = 'not_embedded', embedded_at = NULL,
           -- Stamp the local-edit markers (#305). Standalone pages have no
           -- upstream so the markers never clear — they just record who
           -- touched the page last.
           local_modified_at = NOW(), local_modified_by = $${userIdParamIndex}
           ${body.visibility ? ', visibility = $6' : ''}
         WHERE id = $1`,
        body.visibility
          ? [id, body.title, body.bodyHtml, bodyText, newVersion, body.visibility, userId]
          : [id, body.title, body.bodyHtml, bodyText, newVersion, userId],
      );

      await cache.invalidate(userId, 'pages');
      await logAuditEvent(userId, 'PAGE_UPDATED', 'page', String(id), { source: 'standalone', title: body.title }, request);

      emitWebhookEvent({
        eventType: 'page.updated',
        payload: {
          pageId: existingPage.id,
          title: body.title,
          spaceKey: existingPage.space_key,
          updatedAt: new Date().toISOString(),
        },
      });

      return { id: existingPage.id, title: body.title, version: newVersion, source: 'standalone' };
    }

    // --- Confluence article: existing flow ---
    const client = await getClientForUser(userId);
    if (!client) {
      throw fastify.httpErrors.badRequest('Confluence not configured');
    }

    // Version conflict check
    if (body.version !== undefined && body.version < existingPage.version) {
      throw fastify.httpErrors.conflict('Page has been modified since you loaded it. Please refresh and try again.');
    }

    // Upload locally-pasted images to Confluence before converting HTML.
    // Pasted images have src="/api/attachments/{pageId}/{filename}" but lack
    // data-confluence-filename, meaning they only exist locally and Confluence
    // doesn't know about them. We upload them as Confluence attachments so the
    // ri:attachment reference resolves correctly after save.
    const uploadedBodyHtml = await uploadLocalImagesToConfluence(
      body.bodyHtml, existingPage.confluence_id!, client, request.log,
    );

    const storageBody = htmlToConfluence(uploadedBodyHtml);
    const currentVersion = existingPage.version ?? body.version ?? 1;

    const confPage = await client.updatePage(existingPage.confluence_id!, body.title, storageBody, currentVersion);

    // Update local cache
    const bodyHtml = confluenceToHtml(
      confPage.body?.storage?.value ?? storageBody,
      existingPage.confluence_id!,
      existingPage.space_key ?? undefined,
    );
    const { htmlToText } = await import('../../core/services/content-converter.js');
    const bodyText = htmlToText(bodyHtml);

    await query(
      `UPDATE pages SET
         title = $2, body_storage = $3, body_html = $4, body_text = $5,
         version = $6, last_synced = NOW(), embedding_dirty = TRUE,
         embedding_status = 'not_embedded', embedded_at = NULL,
         -- Clear local-edit markers (#305): the Confluence push has
         -- succeeded, so the local state is now in sync with the remote.
         local_modified_at = NULL, local_modified_by = NULL
       WHERE id = $1`,
      [id, body.title, confPage.body?.storage?.value ?? storageBody,
       bodyHtml, bodyText, confPage.version.number],
    );

    // Invalidate cache
    await cache.invalidate(userId, 'pages');

    await logAuditEvent(userId, 'PAGE_UPDATED', 'page', String(id), { title: body.title }, request);

    emitWebhookEvent({
      eventType: 'page.updated',
      payload: {
        pageId: existingPage.id,
        title: body.title,
        spaceKey: existingPage.space_key,
        updatedAt: new Date().toISOString(),
      },
    });

    return { id: existingPage.id, title: body.title, version: confPage.version.number, source: 'confluence' };
  });

  // DELETE /api/pages/:id
  // Accepts integer page id (universal) or confluence_id string (backward compat)
  fastify.delete('/pages/:id', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const userId = request.userId;

    // Parse query for permanent flag
    const queryParams = z.object({ permanent: z.string().optional() }).parse(request.query);
    const isNumericId = /^\d+$/.test(id);

    // Load the page to determine source
    const existing = await query<{
      id: number; source: string; created_by_user_id: string | null;
      confluence_id: string | null; space_key: string | null;
    }>(
      `SELECT id, source, created_by_user_id, confluence_id, space_key FROM pages WHERE ${isNumericId ? 'id = $1' : 'confluence_id = $1'}`,
      [isNumericId ? parseInt(id, 10) : id],
    );
    if (existing.rows.length === 0) {
      throw fastify.httpErrors.notFound('Page not found');
    }
    const existingPage = existing.rows[0]!;

    if (existingPage.source === 'standalone') {
      // --- Standalone article ---
      // Access control: only owner can delete
      if (existingPage.created_by_user_id !== userId) {
        throw fastify.httpErrors.forbidden('Not authorized to delete this page');
      }

      if (queryParams.permanent === 'true') {
        // Hard delete
        await query('DELETE FROM pinned_pages WHERE user_id = $1 AND page_id = $2', [userId, existingPage.id]);
        await query('DELETE FROM pages WHERE id = $1', [existingPage.id]);
      } else {
        // Soft delete — move to trash
        await query('UPDATE pages SET deleted_at = NOW() WHERE id = $1', [existingPage.id]);
      }

      await cache.invalidate(userId, 'pages');
      await logAuditEvent(userId, 'PAGE_DELETED', 'page', String(id),
        { source: 'standalone', permanent: queryParams.permanent === 'true' }, request);

      emitWebhookEvent({
        eventType: 'page.deleted',
        payload: {
          pageId: existingPage.id,
          isHardDelete: queryParams.permanent === 'true',
        },
      });

      return { message: queryParams.permanent === 'true' ? 'Page permanently deleted' : 'Page moved to trash' };
    }

    // --- Confluence article: existing flow ---
    // RBAC: verify user has access to this page's space before allowing delete
    if (existingPage.space_key) {
      const accessibleSpaces = await getUserAccessibleSpaces(userId);
      if (!accessibleSpaces.includes(existingPage.space_key)) {
        throw fastify.httpErrors.forbidden('Access denied to this space');
      }
    }

    const client = await getClientForUser(userId);
    if (!client) {
      throw fastify.httpErrors.badRequest('Confluence not configured');
    }

    await client.deletePage(existingPage.confluence_id!);

    // Clean up local data (page_embeddings cascade-deleted via FK)
    await query('DELETE FROM pinned_pages WHERE user_id = $1 AND page_id = $2', [userId, existingPage.id]);
    await query('DELETE FROM pages WHERE id = $1', [existingPage.id]);
    if (existingPage.confluence_id) {
      await cleanPageAttachments(userId, existingPage.confluence_id);
    }

    // Invalidate cache
    await cache.invalidate(userId, 'pages');
    await cache.invalidate(userId, 'spaces');

    await logAuditEvent(userId, 'PAGE_DELETED', 'page', String(id), {}, request);

    emitWebhookEvent({
      eventType: 'page.deleted',
      payload: {
        pageId: existingPage.id,
        isHardDelete: true,
      },
    });

    return { message: 'Page deleted' };
  });

  // ======== Draft-while-published (#362) ========

  // PUT /api/pages/:id/draft — save draft (does not affect live content)
  fastify.put('/pages/:id/draft', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const body = SaveDraftSchema.parse(request.body);
    const userId = request.userId;
    const pageId = parseInt(id, 10);

    const existing = await query<{
      id: number; source: string; created_by_user_id: string | null;
      visibility: string; deleted_at: Date | null;
    }>(
      'SELECT id, source, created_by_user_id, visibility, deleted_at FROM pages WHERE id = $1 AND deleted_at IS NULL',
      [pageId],
    );
    if (!existing.rows.length) throw fastify.httpErrors.notFound('Page not found');

    const page = existing.rows[0]!;

    // Access control: standalone pages require ownership or shared visibility
    if (page.source === 'standalone' && page.created_by_user_id !== userId && page.visibility !== 'shared') {
      throw fastify.httpErrors.forbidden('Not authorized to edit this page');
    }

    const { htmlToText } = await import('../../core/services/content-converter.js');
    const draftText = htmlToText(body.bodyHtml);

    await query(
      `UPDATE pages SET draft_body_html = $1, draft_body_text = $2, draft_updated_at = NOW(), draft_updated_by = $3 WHERE id = $4`,
      [body.bodyHtml, draftText, userId, page.id],
    );

    return { id: page.id, hasDraft: true, draftUpdatedAt: new Date().toISOString() };
  });

  // GET /api/pages/:id/draft — get draft content
  fastify.get('/pages/:id/draft', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const userId = request.userId;
    const pageId = parseInt(id, 10);

    const result = await query<{
      id: number; source: string; created_by_user_id: string | null;
      visibility: string; draft_body_html: string | null;
      draft_body_text: string | null; draft_updated_at: Date | null;
      draft_updated_by: string | null;
    }>(
      `SELECT id, source, created_by_user_id, visibility, draft_body_html, draft_body_text, draft_updated_at, draft_updated_by FROM pages WHERE id = $1 AND deleted_at IS NULL`,
      [pageId],
    );
    if (!result.rows.length) throw fastify.httpErrors.notFound('Page not found');

    const row = result.rows[0]!;

    // Access control
    if (row.source === 'standalone' && row.created_by_user_id !== userId && row.visibility !== 'shared') {
      throw fastify.httpErrors.notFound('Page not found');
    }

    if (!row.draft_body_html) throw fastify.httpErrors.notFound('No draft exists');

    return {
      id: row.id,
      bodyHtml: row.draft_body_html,
      bodyText: row.draft_body_text,
      updatedAt: row.draft_updated_at,
      updatedBy: row.draft_updated_by,
    };
  });

  // POST /api/pages/:id/draft/publish — atomically publish draft to live
  fastify.post('/pages/:id/draft/publish', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const userId = request.userId;
    const pageId = parseInt(id, 10);

    const existing = await query<{
      id: number; version: number; title: string;
      body_html: string | null; body_text: string | null; body_storage: string | null;
      source: string; created_by_user_id: string | null;
      visibility: string; confluence_id: string | null; space_key: string | null;
      draft_body_html: string | null; draft_body_storage: string | null;
    }>(
      `SELECT id, version, title, body_html, body_text, body_storage, source, created_by_user_id, visibility, confluence_id, space_key, draft_body_html, draft_body_storage FROM pages WHERE id = $1 AND deleted_at IS NULL`,
      [pageId],
    );
    if (!existing.rows.length) throw fastify.httpErrors.notFound('Page not found');

    const page = existing.rows[0]!;

    // Access control
    if (page.source === 'standalone' && page.created_by_user_id !== userId && page.visibility !== 'shared') {
      throw fastify.httpErrors.forbidden('Not authorized to publish this page');
    }

    if (!page.draft_body_html) throw fastify.httpErrors.badRequest('No draft to publish');

    // Atomically: save current live to page_versions, swap draft -> live, clear draft.
    // Must use a dedicated client — pool.query() draws random connections per call,
    // so BEGIN/COMMIT would run on different connections (non-atomic).
    const txClient = await getPool().connect();
    try {
      await txClient.query('BEGIN');

      // Save current live version to page_versions
      await txClient.query(
        `INSERT INTO page_versions (page_id, version_number, title, body_html, body_text, synced_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT DO NOTHING`,
        [page.id, page.version, page.title, page.body_html, page.body_text],
      );

      // Swap draft -> live, increment version, mark embedding dirty, clear draft
      await txClient.query(
        `UPDATE pages SET
          body_html = draft_body_html, body_text = draft_body_text,
          body_storage = COALESCE(draft_body_storage, body_storage),
          version = version + 1, embedding_dirty = TRUE,
          embedding_status = 'not_embedded', embedded_at = NULL,
          last_modified_at = NOW(),
          -- Stamp local-edit markers (#305): publishing a draft is a local
          -- edit — the content hits the live columns for the first time
          -- here, not through sync. Credit goes to the draft author.
          local_modified_at = NOW(),
          local_modified_by = COALESCE(draft_updated_by, local_modified_by),
          draft_body_html = NULL, draft_body_text = NULL, draft_body_storage = NULL,
          draft_updated_at = NULL, draft_updated_by = NULL
         WHERE id = $1`,
        [page.id],
      );

      await txClient.query('COMMIT');
    } catch (err) {
      await txClient.query('ROLLBACK');
      throw err;
    } finally {
      txClient.release();
    }

    // For Confluence articles, push updated content upstream (best-effort)
    if (page.source === 'confluence' && page.confluence_id) {
      try {
        const client = await getClientForUser(userId);
        if (client) {
          const storageBody = htmlToConfluence(page.draft_body_html!);
          await client.updatePage(page.confluence_id, page.title, storageBody, page.version + 1);
        }
      } catch (err) {
        // Log but don't fail — local publish succeeded
        request.log.error({ err }, 'Failed to push draft to Confluence');
      }
    }

    await cache.invalidate(userId, 'pages');
    await logAuditEvent(userId, 'DRAFT_PUBLISHED', 'page', String(page.id),
      { version: page.version + 1 }, request);

    emitWebhookEvent({
      eventType: 'page.updated',
      payload: {
        pageId: page.id,
        title: page.title,
        spaceKey: page.space_key,
        updatedAt: new Date().toISOString(),
      },
    });

    return { id: page.id, version: page.version + 1, published: true };
  });

  // DELETE /api/pages/:id/draft — discard draft
  fastify.delete('/pages/:id/draft', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const userId = request.userId;
    const pageId = parseInt(id, 10);

    const existing = await query<{
      id: number; source: string; created_by_user_id: string | null;
      visibility: string;
    }>(
      'SELECT id, source, created_by_user_id, visibility FROM pages WHERE id = $1 AND deleted_at IS NULL',
      [pageId],
    );
    if (!existing.rows.length) throw fastify.httpErrors.notFound('Page not found');

    const page = existing.rows[0]!;

    // Access control
    if (page.source === 'standalone' && page.created_by_user_id !== userId && page.visibility !== 'shared') {
      throw fastify.httpErrors.forbidden('Not authorized to discard this draft');
    }

    await query(
      `UPDATE pages SET draft_body_html = NULL, draft_body_text = NULL, draft_body_storage = NULL, draft_updated_at = NULL, draft_updated_by = NULL WHERE id = $1`,
      [page.id],
    );

    return { id: page.id, hasDraft: false };
  });

  // ======== Bulk Operations (Issue #28, parallelized #192) ========

  // POST /api/pages/bulk/delete - delete multiple pages by IDs
  fastify.post('/pages/bulk/delete', async (request, reply) => {
    const parsed = BulkIdsOrFilterSchema.parse(request.body);
    const userId = request.userId;

    const bulkAccessSpaces = await getUserAccessibleSpaces(userId);
    const selection: BulkSelection = {
      ids: parsed.ids,
      filter: parsed.filter,
      expectedCount: parsed.expectedCount,
      driftToleranceFraction: parsed.driftToleranceFraction,
    };

    let resolved;
    try {
      // delete accepts the legacy mixed wire shape (PK for standalone,
      // confluence_id for synced) so the resolver runs in 'mixed' mode.
      resolved = await resolveBulkSelection(userId, selection, bulkAccessSpaces);
    } catch (err) {
      if (err instanceof BulkSelectionError && err.detail.kind === 'count_drift') {
        return reply.status(409).send({
          error: 'CountDrift',
          message: err.detail.message,
          expected: err.detail.expected,
          actual: err.detail.actual,
        });
      }
      throw err;
    }

    const errors: string[] = resolved.notFoundIds.map((id) => `Page ${id} not found`);
    let failed = resolved.notFoundIds.length;

    // --- Partition by source ---
    const standalonePages = resolved.rows.filter((r) => r.source === 'standalone')
      .map((r) => ({ id: r.id, source: 'standalone', confluence_id: r.confluenceId, space_key: r.spaceKey }));
    const confluencePages = resolved.rows.filter((r) => r.source !== 'standalone')
      .map((r) => ({ id: r.id, source: r.source, confluence_id: r.confluenceId, space_key: r.spaceKey }));

    // Soft-delete standalone pages (move to trash)
    const standaloneNumericIds = standalonePages.map((r) => r.id);
    if (standaloneNumericIds.length > 0) {
      await Promise.all([
        query('UPDATE pages SET deleted_at = NOW() WHERE id = ANY($1::int[])', [standaloneNumericIds]),
        query('DELETE FROM pinned_pages WHERE user_id = $1 AND page_id = ANY($2::int[])', [userId, standaloneNumericIds]),
      ]);
      // Bulk delete is a soft-delete (move to trash) for standalone pages.
      for (const pageId of standaloneNumericIds) {
        emitWebhookEvent({
          eventType: 'page.deleted',
          payload: { pageId, isHardDelete: false },
        });
      }
    }
    const standaloneSucceeded = standaloneNumericIds.length;

    // Delete Confluence pages via API
    const bulkLimit = pLimit(5);
    let confluenceSucceeded = 0;
    if (confluencePages.length > 0) {
      const client = await getClientForUser(userId);
      if (!client) {
        confluencePages.forEach((p) => {
          failed++;
          errors.push(`Page ${p.confluence_id ?? p.id}: Confluence not configured`);
        });
      } else {
        const deleteResults = await Promise.allSettled(
          confluencePages.map((p) => bulkLimit(() => client.deletePage(p.confluence_id!))),
        );

        const deletedConfluenceIds: string[] = [];
        const deletedConfluenceNumericIds: number[] = [];
        for (let i = 0; i < deleteResults.length; i++) {
          const result = deleteResults[i]!;
          if (result.status === 'fulfilled') {
            deletedConfluenceIds.push(confluencePages[i]!.confluence_id!);
            deletedConfluenceNumericIds.push(confluencePages[i]!.id);
            confluenceSucceeded++;
          } else {
            failed++;
            errors.push(
              `Page ${confluencePages[i]!.confluence_id}: ${result.reason instanceof Error ? result.reason.message : 'Unknown error'}`,
            );
          }
        }

        // Batch cleanup: page_embeddings cascade-deleted via FK
        if (deletedConfluenceNumericIds.length > 0) {
          await Promise.all([
            query('DELETE FROM pinned_pages WHERE user_id = $1 AND page_id = ANY($2::int[])', [userId, deletedConfluenceNumericIds]),
            query('DELETE FROM pages WHERE confluence_id = ANY($1)', [deletedConfluenceIds]),
          ]);
          await Promise.allSettled(deletedConfluenceIds.map((id) => bulkLimit(() => cleanPageAttachments(userId, id))));
          // Confluence bulk delete is always a hard delete (Confluence API + local row removal).
          for (const pageId of deletedConfluenceNumericIds) {
            emitWebhookEvent({
              eventType: 'page.deleted',
              payload: { pageId, isHardDelete: true },
            });
          }
        }
      }
    }

    const succeeded = standaloneSucceeded + confluenceSucceeded;
    await cache.invalidate(userId, 'pages');
    await cache.invalidate(userId, 'spaces');
    await logAuditEvent(
      userId,
      'PAGE_DELETED',
      'page',
      undefined,
      {
        ...(parsed.ids ? { bulkIds: parsed.ids } : { filter: parsed.filter, expectedCount: parsed.expectedCount }),
        affectedCount: resolved.rows.length,
        succeeded,
        failed,
      },
      request,
    );

    return { succeeded, failed, errors };
  });

  // POST /api/pages/bulk/sync - re-sync multiple pages from Confluence
  fastify.post('/pages/bulk/sync', async (request, reply) => {
    const parsed = BulkIdsOrFilterSchema.parse(request.body);
    const userId = request.userId;

    const client = await getClientForUser(userId);
    if (!client) {
      throw fastify.httpErrors.badRequest('Confluence not configured');
    }

    const bulkAccessSpaces = await getUserAccessibleSpaces(userId);
    const selection: BulkSelection = {
      ids: parsed.ids,
      filter: parsed.filter,
      expectedCount: parsed.expectedCount,
      driftToleranceFraction: parsed.driftToleranceFraction,
    };

    let resolved;
    try {
      resolved = await resolveBulkSelection(userId, selection, bulkAccessSpaces);
    } catch (err) {
      if (err instanceof BulkSelectionError && err.detail.kind === 'count_drift') {
        return reply.status(409).send({
          error: 'CountDrift',
          message: err.detail.message,
          expected: err.detail.expected,
          actual: err.detail.actual,
        });
      }
      throw err;
    }

    // Sync only operates on Confluence-sourced pages (standalone pages have no
    // upstream to re-sync from).
    const syncableRows = resolved.rows.filter((r) => r.confluenceId !== null);
    const ownedIds = new Set(syncableRows.map((r) => r.confluenceId as string));
    const spaceKeysById = new Map(
      syncableRows.map((r) => [r.confluenceId as string, r.spaceKey ?? '']),
    );
    const errors: string[] = resolved.notFoundIds.map((id) => `Page ${id} not found`);
    let failed = resolved.notFoundIds.length;

    // Eager-load htmlToText once (avoid repeated dynamic import)
    const { htmlToText } = await import('../../core/services/content-converter.js');

    // Fetch latest from Confluence in parallel with concurrency control
    const bulkLimit = pLimit(5);
    const syncResults = await Promise.allSettled(
      [...ownedIds].map((id) =>
        bulkLimit(async () => {
          const page = await client.getPage(id);
          const bodyHtml = confluenceToHtml(
            page.body?.storage?.value ?? '',
            id,
            spaceKeysById.get(id),
          );
          const bodyText = htmlToText(bodyHtml);

          await query(
            `UPDATE pages SET
               title = $2, body_storage = $3, body_html = $4, body_text = $5,
               version = $6, last_synced = NOW(), embedding_dirty = TRUE,
               embedding_status = 'not_embedded', embedded_at = NULL,
               -- Clear local-edit markers (#305): this is a bulk
               -- refresh-from-Confluence path (sync-side).
               local_modified_at = NULL, local_modified_by = NULL
             WHERE confluence_id = $1`,
            [id, page.title, page.body?.storage?.value ?? '', bodyHtml, bodyText, page.version.number],
          );
          return id;
        }),
      ),
    );

    let succeeded = 0;
    const ownedIdArray = [...ownedIds];
    for (let i = 0; i < syncResults.length; i++) {
      const result = syncResults[i]!;
      if (result.status === 'fulfilled') {
        succeeded++;
      } else {
        failed++;
        errors.push(
          `Page ${ownedIdArray[i]!}: ${result.reason instanceof Error ? result.reason.message : 'Unknown error'}`,
        );
      }
    }

    await cache.invalidate(userId, 'pages');

    return { succeeded, failed, errors };
  });

  // POST /api/pages/bulk/embed - re-embed multiple pages
  fastify.post('/pages/bulk/embed', async (request, reply) => {
    const parsed = BulkIdsOrFilterSchema.parse(request.body);
    const userId = request.userId;

    // Return 409 if embedding is already in progress for this user
    if (await isProcessingUser(userId)) {
      throw fastify.httpErrors.conflict('Embedding processing is already in progress for this user');
    }

    const embedSpaces = await getUserAccessibleSpaces(userId);
    const selection: BulkSelection = {
      ids: parsed.ids,
      filter: parsed.filter,
      expectedCount: parsed.expectedCount,
      driftToleranceFraction: parsed.driftToleranceFraction,
    };

    let resolved;
    try {
      resolved = await resolveBulkSelection(userId, selection, embedSpaces);
    } catch (err) {
      if (err instanceof BulkSelectionError && err.detail.kind === 'count_drift') {
        return reply.status(409).send({
          error: 'CountDrift',
          message: err.detail.message,
          expected: err.detail.expected,
          actual: err.detail.actual,
        });
      }
      throw err;
    }

    // Embedding requires a confluence_id — standalone pages are skipped (their
    // embeddings live separately).
    const eligibleIds = resolved.rows
      .filter((r) => r.confluenceId !== null)
      .map((r) => r.confluenceId as string);

    let succeeded = 0;
    if (eligibleIds.length > 0) {
      const result = await query<{ confluence_id: string }>(
        `UPDATE pages SET embedding_dirty = TRUE
         WHERE confluence_id = ANY($1)
         RETURNING confluence_id`,
        [eligibleIds],
      );
      succeeded = result.rows.length;
    }

    const errors: string[] = resolved.notFoundIds.map((id) => `Page ${id} not found`);
    const failed = resolved.notFoundIds.length;

    // Fire-and-forget: trigger processing of dirty pages (same pattern as POST /embeddings/process)
    if (succeeded > 0) {
      processDirtyPages(userId).catch((err) => {
        logger.error({ err, userId }, 'Bulk embed: embedding processing failed');
      });
    }

    return { succeeded, failed, errors };
  });

  // POST /api/pages/bulk/tag - add/remove tags on multiple pages
  fastify.post('/pages/bulk/tag', async (request, reply) => {
    const parsed = BulkTagSchema.parse(request.body);
    const { addTags, removeTags } = parsed;
    const userId = request.userId;

    if (addTags.length === 0 && removeTags.length === 0) {
      throw fastify.httpErrors.badRequest('At least one of addTags or removeTags must be provided');
    }

    const client = await getClientForUser(userId);
    const tagSpaces = await getUserAccessibleSpaces(userId);

    const selection: BulkSelection = {
      ids: parsed.ids,
      filter: parsed.filter,
      expectedCount: parsed.expectedCount,
      driftToleranceFraction: parsed.driftToleranceFraction,
    };

    let resolved;
    try {
      resolved = await resolveBulkSelection(userId, selection, tagSpaces, {
        idMode: 'numeric-only',
      });
    } catch (err) {
      if (err instanceof BulkSelectionError && err.detail.kind === 'count_drift') {
        return reply.status(409).send({
          error: 'CountDrift',
          message: err.detail.message,
          expected: err.detail.expected,
          actual: err.detail.actual,
        });
      }
      throw err;
    }

    const pageMap = new Map(
      resolved.rows.map((r) => [String(r.id), { confluenceId: r.confluenceId, labels: r.labels }]),
    );
    const errors: string[] = resolved.notFoundIds.map((id) => `Page ${id} not found`);
    let failed = resolved.notFoundIds.length;

    // Process each owned page: compute new labels, update DB, sync to Confluence
    const bulkLimit = pLimit(5);
    const tagResults = await Promise.allSettled(
      [...pageMap.entries()].map(([id, pageInfo]) =>
        bulkLimit(async () => {
          let labels = [...pageInfo.labels];

          // Remove tags
          if (removeTags && removeTags.length > 0) {
            const removeSet = new Set(removeTags);
            labels = labels.filter((l) => !removeSet.has(l));
          }

          // Add tags (deduplicating)
          if (addTags && addTags.length > 0) {
            const labelSet = new Set(labels);
            for (const tag of addTags) {
              labelSet.add(tag);
            }
            labels = [...labelSet];
          }

          await query('UPDATE pages SET labels = $2 WHERE id = $1', [
            parseInt(id, 10),
            labels,
          ]);

          // Sync label changes to Confluence (requires confluence_id)
          if (client && pageInfo.confluenceId) {
            try {
              if (addTags && addTags.length > 0) {
                await client.addLabels(pageInfo.confluenceId, addTags);
              }
              if (removeTags && removeTags.length > 0) {
                for (const label of removeTags) {
                  await client.removeLabel(pageInfo.confluenceId, label);
                }
              }
            } catch (err) {
              logger.error({ err, pageId: id, confluenceId: pageInfo.confluenceId, userId }, 'Failed to sync labels to Confluence');
            }
          }

          return id;
        }),
      ),
    );

    let succeeded = 0;
    const ownedIdArray = [...pageMap.keys()];
    for (let i = 0; i < tagResults.length; i++) {
      const result = tagResults[i]!;
      if (result.status === 'fulfilled') {
        succeeded++;
      } else {
        failed++;
        errors.push(
          `Page ${ownedIdArray[i]!}: ${result.reason instanceof Error ? result.reason.message : 'Unknown error'}`,
        );
      }
    }

    await cache.invalidate(userId, 'pages');

    // Audit: one event per bulk action, not per row (epic v0.4 §3.6 / R8).
    await logAuditEvent(
      userId,
      'BULK_PAGE_TAGGED',
      'page',
      undefined,
      {
        ...(parsed.ids ? { bulkIds: parsed.ids } : { filter: parsed.filter, expectedCount: parsed.expectedCount }),
        affectedCount: pageMap.size,
        addTags,
        removeTags,
        succeeded,
        failed,
      },
      request,
    );

    return { succeeded, failed, errors };
  });

  // POST /api/pages/bulk/replace-tags — REPLACE entire tag set on N pages
  //
  // Distinct from /bulk/tag (additive) so admins can wipe tags atomically and
  // the audit log can distinguish the higher-risk operation
  // (BULK_PAGE_TAGS_REPLACED). Optional `jobId` enables SSE progress; when
  // absent the route still chunks for memory but skips the publish/cancel
  // path. Tags are normalised (lower-cased, trimmed, de-duplicated) at the
  // boundary to match the existing auto-tagger convention.
  fastify.post('/pages/bulk/replace-tags', async (request, reply) => {
    const parsed = BulkReplaceTagsSchema.parse(request.body);
    const { tags, jobId } = parsed;
    const userId = request.userId;

    // Normalise input tags
    const normTags = Array.from(
      new Set(
        tags
          .map((t) => t.trim().toLowerCase())
          .filter((t) => t.length > 0),
      ),
    );

    const accessSpaces = await getUserAccessibleSpaces(userId);
    const selection: BulkSelection = {
      ids: parsed.ids,
      filter: parsed.filter,
      expectedCount: parsed.expectedCount,
      driftToleranceFraction: parsed.driftToleranceFraction,
    };

    let resolved;
    try {
      resolved = await resolveBulkSelection(userId, selection, accessSpaces, {
        idMode: 'numeric-only',
      });
    } catch (err) {
      if (err instanceof BulkSelectionError && err.detail.kind === 'count_drift') {
        return reply.status(409).send({
          error: 'CountDrift',
          message: err.detail.message,
          expected: err.detail.expected,
          actual: err.detail.actual,
        });
      }
      throw err;
    }

    const errors: string[] = resolved.notFoundIds.map((id) => `Page ${id} not found`);
    const initialFailed = resolved.notFoundIds.length;
    const eligible = resolved.rows.map((r) => ({
      id: r.id,
      confluenceId: r.confluenceId,
      oldLabels: r.labels,
    }));

    if (jobId) {
      await startBulkJob(jobId, eligible.length, userId, 'replace-tags');
    }

    const client = await getClientForUser(userId);
    const bulkLimit = pLimit(5);

    const result = await runBulkInChunks(eligible, 100, jobId ?? null, async (chunk) => {
      let chunkSucceeded = 0;
      let chunkFailed = 0;
      const chunkErrors: string[] = [];

      const settled = await Promise.allSettled(
        chunk.map((page) =>
          bulkLimit(async () => {
            await query('UPDATE pages SET labels = $2 WHERE id = $1', [page.id, normTags]);

            // Sync to Confluence: remove labels not in new set, add the rest
            if (client && page.confluenceId) {
              const oldSet = new Set(page.oldLabels);
              const newSet = new Set(normTags);
              const toAdd = normTags.filter((t) => !oldSet.has(t));
              const toRemove = page.oldLabels.filter((t) => !newSet.has(t));
              try {
                if (toAdd.length > 0) await client.addLabels(page.confluenceId, toAdd);
                for (const label of toRemove) {
                  await client.removeLabel(page.confluenceId, label);
                }
              } catch (err) {
                logger.error(
                  { err, pageId: page.id, confluenceId: page.confluenceId, userId },
                  'replace-tags: Confluence label sync failed',
                );
              }
            }
            return page.id;
          }),
        ),
      );

      for (let i = 0; i < settled.length; i++) {
        const r = settled[i]!;
        if (r.status === 'fulfilled') {
          chunkSucceeded++;
        } else {
          chunkFailed++;
          chunkErrors.push(
            `Page ${chunk[i]!.id}: ${r.reason instanceof Error ? r.reason.message : 'Unknown error'}`,
          );
        }
      }

      return { succeeded: chunkSucceeded, failed: chunkFailed, errors: chunkErrors };
    });

    errors.push(...result.errors);
    const succeeded = result.succeeded;
    const failed = initialFailed + result.failed;
    const cancelled = result.cancelled;

    await cache.invalidate(userId, 'pages');

    await logAuditEvent(
      userId,
      'BULK_PAGE_TAGS_REPLACED',
      'page',
      undefined,
      {
        ...(parsed.ids ? { bulkIds: parsed.ids } : { filter: parsed.filter, expectedCount: parsed.expectedCount }),
        affectedCount: eligible.length,
        tags: normTags,
        succeeded,
        failed,
        cancelled,
        ...(jobId ? { jobId } : {}),
      },
      request,
    );

    return { succeeded, failed, errors, cancelled, ...(jobId ? { jobId } : {}) };
  });

  // POST /api/pages/:id/images - upload a pasted/dropped image for a page
  // Accepts JSON body: { dataUri: "data:image/png;base64,...", filename: "paste-123-abcd.png" }
  // Stores the image in the local attachment cache and returns the serving URL.
  fastify.post('/pages/:id/images', { bodyLimit: 15_000_000 }, async (request, reply) => {
    const { id } = IdParamSchema.parse(request.params);
    const userId = request.userId;

    // Validate request body
    const parseResult = ImageUploadSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: parseResult.error.issues[0]?.message ?? 'Invalid request body',
      });
    }
    const { dataUri, filename } = parseResult.data;

    // Validate data URI format: must be data:image/<type>;base64,<data>
    const dataUriMatch = dataUri.match(/^data:(image\/[\w+.-]+);base64,(.+)$/s);
    if (!dataUriMatch) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Invalid data URI format. Expected data:image/<type>;base64,<data>',
      });
    }

    const mimeType = dataUriMatch[1]!;
    const base64Data = dataUriMatch[2]!;

    // Validate MIME type
    if (!ALLOWED_IMAGE_MIMES.has(mimeType)) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: `Unsupported image type: ${mimeType}. Allowed: png, jpg, gif, webp`,
      });
    }

    // Decode base64 and validate size (10MB max)
    let imageBuffer: Buffer;
    try {
      imageBuffer = Buffer.from(base64Data, 'base64');
    } catch {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Invalid base64 data in dataUri',
      });
    }

    const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
    if (imageBuffer.length > MAX_IMAGE_BYTES) {
      return reply.status(413).send({
        statusCode: 413,
        error: 'Payload Too Large',
        message: `Image exceeds maximum size of ${MAX_IMAGE_BYTES / (1024 * 1024)} MB`,
      });
    }

    // Verify the page exists and the user has access
    // Support both integer PK (standalone pages) and confluence_id (Confluence pages)
    const isNumericId = /^\d+$/.test(id);
    const pageResult = await query<{
      id: number; source: string; confluence_id: string | null;
      created_by_user_id: string | null; space_key: string | null;
    }>(
      `SELECT p.id, p.source, p.confluence_id, p.created_by_user_id, p.space_key
       FROM pages p
       WHERE ${isNumericId ? 'p.id = $1' : 'p.confluence_id = $1'}
         AND p.deleted_at IS NULL`,
      [isNumericId ? Number(id) : id],
    );

    if (pageResult.rows.length === 0) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Page not found',
      });
    }

    const page = pageResult.rows[0]!;

    // Access control: standalone pages require ownership; Confluence pages require space access
    if (page.source === 'standalone') {
      if (page.created_by_user_id !== userId) {
        return reply.status(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Not authorized to upload images to this page',
        });
      }
    } else if (page.space_key) {
      const accessibleSpaces = await getUserAccessibleSpaces(userId);
      if (!accessibleSpaces.includes(page.space_key)) {
        return reply.status(403).send({
          statusCode: 403,
          error: 'Forbidden',
          message: 'Not authorized to upload images to this page',
        });
      }
    } else {
      // No space_key and not standalone — deny access
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: 'Access denied',
      });
    }

    // Determine the attachment directory key:
    // Standalone pages use integer id (string); Confluence pages use confluence_id
    const attachmentPageId = page.source === 'standalone'
      ? String(page.id)
      : (page.confluence_id ?? String(page.id));

    try {
      await writeAttachmentCache(userId, attachmentPageId, filename, imageBuffer);

      const url = `/api/attachments/${encodeURIComponent(attachmentPageId)}/${encodeURIComponent(filename)}`;
      logger.info({ userId, pageId: id, attachmentPageId, filename, size: imageBuffer.length }, 'Image uploaded via paste/drop');

      return { url };
    } catch (err) {
      logger.error({ err, userId, pageId: id, filename }, 'Failed to save pasted image');
      throw fastify.httpErrors.internalServerError('Failed to save image');
    }
  });
}
