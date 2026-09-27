import { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import { query, getPool } from '../../core/db/postgres.js';
import { getFtsLanguage } from '../../core/services/fts-language.js';
import { RedisCache } from '../../core/services/redis-cache.js';
import { isConfluenceEnabled } from '../../core/services/confluence-integration.js';
import { getClientForUser } from '../../domains/confluence/services/sync-service.js';
import {
  CONFLUENCE_DISABLED_MESSAGE,
  pageWriteStaysLocal,
} from '../../domains/confluence/services/standalone-mode.js';
import { htmlToConfluence, confluenceToHtml, htmlToText } from '../../core/services/content-converter.js';
import { cleanPageAttachments } from '../../domains/confluence/services/attachment-handler.js';
import { uploadLocalImagesToConfluence } from '../../domains/confluence/services/pasted-image-uploader.js';
import { assertNonSsrfUrl, SsrfError } from '../../core/utils/ssrf-guard.js';
import { toPageIdText } from '../../core/utils/page-id-text.js';
import { logAuditEvent } from '../../core/services/audit-service.js';
import {
  startBulkJob,
  runBulkInChunks,
} from '../../core/services/bulk-page-progress.js';
import {
  BulkPageFilterSchema,
  resolveBulkSelection,
  bulkResolutionFailures,
  BulkSelectionError,
  type BulkSelection,
} from '../../core/services/bulk-page-selection.js';
import { emitWebhookEvent } from '../../core/services/webhook-emit-hook.js';
import { cleanupStandalonePageAttachmentDirs } from '../../core/services/standalone-attachment-cleanup.js';
import { withLocalAttachmentMutationLock } from '../../core/services/attachment-snapshot-lock.js';
import { discardPageIconForDeletedPage } from '../../core/services/page-icon-store.js';
import { tombstoneCollabRoomAfterCommit } from '../../core/services/collab-tombstone.js';
import {
  authorizedSubtreeComponents,
  activeDescendantCount,
  findSubtreeKeyAmbiguity,
  resolveParentOf,
  trashBatchIds,
  type AuthorizedSubtreeComponent,
  type SubtreeKeyAmbiguity,
  PageSubtreeFrozenError,
} from '../../core/services/page-subtree.js';
import { invalidateCollabDocAfterBodyWrite, rejectIfLiveCollabRoom } from '../../core/services/collab-guard.js';
import { STANDALONE_TRASH_RETENTION_DAYS } from '../../core/services/data-retention-service.js';
import {
  ATTACHMENT_SNAPSHOT_LOCK_ID,
  PAGE_HIERARCHY_LOCK_ID,
} from '../../core/db/advisory-locks.js';
import { processDirtyPages, isProcessingUser, assertShadowRollbackWindowClear } from '../../domains/llm/services/embedding-service.js';
import { triggerQualityBatch } from '../../domains/knowledge/services/quality-worker.js';
import { getUserAccessibleSpaces, userCanAccessPage } from '../../core/services/rbac-service.js';
import { visiblePagesPredicate } from '../../core/services/page-visibility.js';
import { toPageIcon } from '../../core/services/page-icon.js';
import { PageListQuerySchema, PageTreeQuerySchema, CreatePageSchema, UpdatePageSchema, SaveDraftSchema, TrashListResponseSchema, type PageLifecycleState } from '@compendiq/contracts';
import { z } from 'zod';
import { logger } from '../../core/utils/logger.js';
import pLimit from 'p-limit';
import { ConfluenceError, type ConfluenceClient } from '../../domains/confluence/services/confluence-client.js';
import {
  confirmPagePublication,
  pagePublicationReceipt,
  publishCreatedConfluencePage,
  type PublishedConfluencePage,
} from '../../domains/confluence/services/ordinary-page-write-reconciler.js';
import {
  freezeSummary,
  getPageLifecycleState,
  renderedFrozenPageBodyHtml,
} from '../../core/services/page-baseline-service.js';
import {
  type PageWriteIntent,
  type PageRevision,
  PageWriteError,
  advancePageWriteIntent,
  advancePageWriteIntentInTransaction,
  assertPageHierarchyParentsAvailable,
  completePageWriteIntent,
  cancelPageWriteIntentBeforeEffect,
  getPageWriterRuntimeId,
  lockPageLifecycle,
  lockPageWriterRuntime,
  lockPageWrites,
  reservePageWriteIntent,
  reservePageWriteIntentInTransaction,
  withPageHierarchyWriteTransaction,
  runPageWriteIntentEffect,
  withPageWriteTransaction,
} from '../../core/services/page-write-admission.js';
import { enqueuePageWriteInvalidation } from '../../core/services/page-write-invalidation.js';
import {
  imageAttachmentPageKey,
  loadAuthorizedImagePage,
  userCanUploadPageImage,
  writePageImageCache,
  type ImageUploadPage,
} from '../../core/services/page-image-cache.js';

/** Escape ILIKE metacharacters so user input like "100%" doesn't match all rows. */
function escapeIlikeTerm(term: string): string {
  return term.replace(/[%_\\]/g, '\\$&');
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

const ImportImageSchema = z.object({
  url: z.string().url().max(2048),
});


/** Capture authority/revisions under admission; later phases must present that original pair. */
async function loadAuthorizedContentWriteState(
  client: PoolClient,
  pageId: number,
  userId: string,
  expected: PageRevision | null,
  allowDeleted = false,
): Promise<PageRevision & {
  source: string;
  confluenceId: string | null;
  spaceKey: string | null;
  visibility: string;
}> {
  const actor = await client.query(
    'SELECT 1 FROM users WHERE id = $1 AND deactivated_at IS NULL',
    [userId],
  );
  if (actor.rowCount !== 1) {
    throw new PageWriteError(403, 'not_authorized', 'Not authorized to edit this page');
  }
  const result = await client.query<PageRevision & {
    source: string;
    confluenceId: string | null;
    created_by_user_id: string | null;
    visibility: string;
    spaceKey: string | null;
  }>(
    `SELECT source, confluence_id AS "confluenceId", created_by_user_id, visibility,
            space_key AS "spaceKey", content_revision::text AS "contentRevision",
            lifecycle_revision::text AS "lifecycleRevision"
       FROM pages WHERE id = $1 AND ($2::boolean OR deleted_at IS NULL) FOR UPDATE`,
    [pageId, allowDeleted],
  );
  const current = result.rows[0];
  if (!current) throw new PageWriteError(404, 'page_not_found', 'Page not found');
  if (current.source === 'confluence') {
    const spaces = await getUserAccessibleSpaces(userId, client);
    if (!current.spaceKey || !spaces.includes(current.spaceKey)) {
      throw new PageWriteError(403, 'not_authorized', 'Access denied to this space');
    }
  } else if (current.created_by_user_id !== userId && current.visibility !== 'shared') {
    throw new PageWriteError(403, 'not_authorized', 'Not authorized to edit this page');
  }
  if (!(await userCanAccessPage(userId, pageId, client, allowDeleted))) {
    throw new PageWriteError(403, 'not_authorized', 'Not authorized to edit this page');
  }
  if (expected && current.lifecycleRevision !== expected.lifecycleRevision) {
    throw new PageWriteError(409, 'stale_lifecycle', 'The page lifecycle changed after the content was read');
  }
  if (expected && current.contentRevision !== expected.contentRevision) {
    throw new PageWriteError(409, 'stale_content_revision', 'The page content changed after the content was read');
  }
  return current;
}

/** A captured PAT is not authority to dispatch after an admission wait. */
async function loadCurrentConfluenceWriteClient(
  client: PoolClient,
  intent: PageWriteIntent,
  pageId: number,
  userId: string,
  confluenceId: string,
  allowDeleted = false,
): Promise<ConfluenceClient> {
  const current = await loadAuthorizedContentWriteState(
    client, pageId, userId, intent.revisions[pageId]!, allowDeleted,
  );
  if (current.source !== 'confluence' || current.confluenceId !== confluenceId) {
    throw new PageWriteError(409, 'page_source_changed', 'The page source changed before the remote write');
  }
  if (!(await isConfluenceEnabled(userId, client))) {
    throw new PageWriteError(
      409,
      'confluence_integration_disabled',
      CONFLUENCE_DISABLED_MESSAGE,
    );
  }
  const confluence = await getClientForUser(userId, client);
  if (!confluence) {
    throw new PageWriteError(
      409,
      'confluence_connection_changed',
      'Confluence credentials changed before the remote write',
    );
  }
  return confluence;
}

/** Magic-byte signatures for each allowed import MIME. The leading bytes must
 *  match the declared `Content-Type` from the upstream — otherwise a malicious
 *  server could serve arbitrary bytes labelled as `image/png` and we'd store
 *  them. The signatures here only need to cover the formats `ALLOWED_IMAGE_MIMES`
 *  permits; SVG and other text-based image formats are intentionally absent
 *  (sniffing them by leading bytes is unreliable). */
const MAGIC_BYTE_SIGNATURES: Record<string, Array<readonly number[]>> = {
  'image/png': [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  'image/jpeg': [[0xff, 0xd8, 0xff]],
  'image/jpg': [[0xff, 0xd8, 0xff]],
  'image/gif': [
    [0x47, 0x49, 0x46, 0x38, 0x37, 0x61], // GIF87a
    [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], // GIF89a
  ],
  'image/webp': [
    // RIFF....WEBP — first 4 bytes are "RIFF", bytes 8-11 are "WEBP".
    // We check the "RIFF" prefix here; the full "WEBP" check is done by
    // `bufferMatchesMime` because it spans a non-prefix range.
    [0x52, 0x49, 0x46, 0x46],
  ],
};

function bufferMatchesMime(buf: Buffer, mime: string): boolean {
  const sigs = MAGIC_BYTE_SIGNATURES[mime];
  if (!sigs) return false;
  for (const sig of sigs) {
    if (buf.length < sig.length) continue;
    let ok = true;
    for (let i = 0; i < sig.length; i++) {
      if (buf[i] !== sig[i]) { ok = false; break; }
    }
    if (!ok) continue;
    // WEBP needs an extra check for the "WEBP" magic at bytes 8-11. (Bytes
    // 4-7 are the little-endian file size — also untrusted, so we don't
    // assert against it.)
    if (mime === 'image/webp') {
      if (buf.length < 12) continue;
      if (buf[8] !== 0x57 || buf[9] !== 0x45 || buf[10] !== 0x42 || buf[11] !== 0x50) continue;
    }
    return true;
  }
  return false;
}

/** Filename for an imported image — sanitised path basename, or a fallback. */
function pickImportFilename(sourceUrl: string, contentType: string): string {
  const extByType: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
  };
  const fallbackExt = extByType[contentType] ?? 'png';
  try {
    const parsed = new URL(sourceUrl);
    const last = parsed.pathname.split('/').filter(Boolean).pop() ?? '';
    // Allow only ASCII word chars, dots, and hyphens — same constraint as
    // `ImageUploadSchema`. Strip anything else.
    const sanitised = last.replace(/[^\w.-]/g, '').replace(/^\.+/, '').slice(0, 200);
    if (sanitised && /\.[a-z0-9]{2,5}$/i.test(sanitised)) {
      return sanitised;
    }
  } catch {
    // Unparseable URL — fall through to a generated name.
  }
  const hex = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
  return `imported-${Date.now()}-${hex}.${fallbackExt}`;
}

/** Maximum bytes accepted from any single upstream import. */
const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
/** Hard cap on redirect hops. Every Location header is re-validated against
 *  the SSRF guard before refetching. */
const MAX_IMPORT_REDIRECTS = 5;
/** Per-attempt fetch timeout. The full import budget is up to (timeout × hops). */
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Server-side `fetch` with manual redirect chain validation. Each `Location`
 * header is validated through `assertNonSsrfUrl` before the next request
 * fires — so an upstream that returns `302 Location: http://192.168.1.1/`
 * (or any other private/internal target) is blocked, not transparently
 * followed.
 *
 * Returns the final non-redirect response, or throws if the chain exceeds
 * `MAX_IMPORT_REDIRECTS` or any hop fails the SSRF check.
 */
async function safeFetchWithSsrfGuardedRedirects(initialUrl: string): Promise<Response> {
  let currentUrl = initialUrl;
  for (let hop = 0; hop <= MAX_IMPORT_REDIRECTS; hop++) {
    // Validate the URL we are about to hit. The initial URL was already
    // validated by the caller; we re-validate redirects (hop > 0).
    if (hop > 0) {
      await assertNonSsrfUrl(currentUrl);
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(currentUrl, {
        method: 'GET',
        signal: controller.signal,
        redirect: 'manual',
        headers: { 'user-agent': 'Compendiq-ImageImporter/1.0' },
      });
    } finally {
      clearTimeout(timeoutId);
    }
    // Manual-redirect mode surfaces 3xx responses with the Location header.
    // Any 3xx-with-Location → re-validate and re-fetch. 3xx-without-Location
    // is treated as a regular response (caller will handle non-2xx).
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location) {
        // Resolve relative redirects against the current URL.
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
    }
    return response;
  }
  throw new Error(`Too many redirects (exceeded ${MAX_IMPORT_REDIRECTS} hops)`);
}

/**
 * Read a response body chunk-by-chunk, aborting if the accumulated size
 * exceeds `MAX_IMPORT_BYTES`. Defends against upstreams that lie about
 * Content-Length (or omit it) and stream arbitrary amounts of data.
 *
 * Returns `{ ok: true, buffer }` on success or `{ ok: false, reason }`
 * when the size cap fires.
 */
async function readBodyWithSizeCap(
  response: Response,
): Promise<{ ok: true; buffer: Buffer } | { ok: false; reason: 'too-large' | 'read-failed' }> {
  if (!response.body) {
    // Older fetch implementations expose null `.body` for empty responses.
    return { ok: true, buffer: Buffer.alloc(0) };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_IMPORT_BYTES) {
        // Best-effort cancel — frees the upstream socket.
        try { await reader.cancel(); } catch { /* upstream already gone */ }
        return { ok: false, reason: 'too-large' };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: 'read-failed' };
  }
  return { ok: true, buffer: Buffer.concat(chunks) };
}

/**
 * The 409 body a delete or restore answers when the subtree it would walk
 * contains a page whose parent key is also another page's identifier (#1636).
 *
 * Refusing rather than resolving is the rule every other `parent_id` reader
 * follows — `assertIdentifierUnambiguous` for `/move` and `/relocate` (#1166),
 * `resolveBulkSelection` for the bulk routes (#1167) — because the stored key
 * stays ambiguous whichever candidate is picked, so a cascade that guessed
 * would trash or destroy rows in an unrelated tree.
 *
 * The response names no page, key, id, or title: an ambiguity can be reached
 * through an inaccessible traversal row, so even the member inside the walk
 * is not necessarily visible to the caller. Operator-only detail stays in the
 * log. `reason` is a slug the client branches on, distinct from the transient
 * `restore_ancestor_trashed`, because this refusal is not retryable.
 */
function ambiguousSubtreeConflict(
  ambiguity: SubtreeKeyAmbiguity,
  log: FastifyInstance['log'],
) {
  log.warn(
    {
      pageId: ambiguity.pageId,
      key: ambiguity.key,
      conflictingPageId: ambiguity.conflictingPageId,
      conflictingTitle: ambiguity.conflictingTitle,
    },
    'pages: refused a subtree operation on an ambiguous parent identifier (#1636)',
  );
  return {
    statusCode: 409,
    error: 'Conflict',
    message:
      'Cannot act on this subtree because its stored parent identifiers are ambiguous. ' +
      'Move or relocate the affected pages first.',
    reason: 'subtree_identifier_ambiguous',
  };
}



function assertSingleCascadeEditable(component: AuthorizedSubtreeComponent, rootId: number): void {
  const frozenCount = component.members
    .filter((member) => member.baselineId !== null)
    .length;
  if (frozenCount === 0) return;
  if (component.members.some((member) => member.id === rootId && member.baselineId !== null)) {
    throw new PageWriteError(423, 'page_is_frozen', 'Protected page content is frozen');
  }
  throw new PageSubtreeFrozenError(frozenCount);
}

/**
 * Hierarchy cascades take the process epoch first, then the global hierarchy
 * fence exclusively. Expansion, lifecycle admission and the SQL mutation (or
 * durable whole-component intent reservation) all happen before this commits.
 */
async function withHierarchyCascadeTransaction<T>(
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const runtimeId = await getPageWriterRuntimeId();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await lockPageWriterRuntime(client, runtimeId);
    await client.query('SELECT pg_advisory_xact_lock($1)', [PAGE_HIERARCHY_LOCK_ID]);
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

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

    const { value: cached, generation } = await cache.getWithGeneration(userId, 'pages', cacheKey);
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
    const whereBase = `WHERE ${visiblePagesPredicate(1, 2)}`;
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
      icon_kind: string | null;
      icon_value: string | null;
      icon_color: string | null;
      icon_filled: boolean | null;
      baseline_id: string | null;
      frozen_version: number | null;
    };

    async function executeSearchQuery(wc: string, vals: unknown[], ob: string, obVals: unknown[] = []) {
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
      // Derive the LIMIT/OFFSET placeholder index from the actual bound-value
      // count (WHERE params + ORDER BY params) so it never goes stale when the
      // relevance ORDER BY param is dropped in the ILIKE fallback (#862).
      const pi = vals.length + obVals.length + 1;
      const dataSql = `
        SELECT cp.id, cp.confluence_id, cp.space_key, cp.title, cp.version,
               cp.parent_id, cp.labels, cp.author, cp.last_modified_at, cp.last_synced,
               cp.embedding_dirty, cp.embedding_status, cp.embedded_at, cp.embedding_error,
               cp.quality_score, cp.quality_status, cp.quality_completeness, cp.quality_clarity,
               cp.quality_structure, cp.quality_accuracy, cp.quality_readability,
               cp.quality_summary, cp.quality_analyzed_at, cp.quality_error,
               cp.summary_status, cp.source, cp.visibility,
               cp.icon_kind, cp.icon_value, cp.icon_color, cp.icon_filled,
               cp.baseline_id, cp.frozen_version
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
    let { total, rows } = await executeSearchQuery(whereClause, values, orderBy, orderByValues);

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
      const fallbackResult = await executeSearchQuery(ilikeWhereClause, ilikeValues, ilikeOrderBy, ilikeObVals);
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
        icon: toPageIcon(row.icon_kind, row.icon_value, row.icon_color, row.icon_filled),
        ...freezeSummary(row),
      })),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      ...(usedIlikeFallback ? { fuzzyMatch: true } : {}),
    };

    await cache.setIfCurrent(userId, 'pages', cacheKey, generation, response, cacheTtl);

    return response;
  });

  // GET /api/pages/tree - all pages with minimal fields for hierarchy view
  fastify.get('/pages/tree', async (request) => {
    const userId = request.userId;
    const params = PageTreeQuerySchema.parse(request.query);

    const cacheKey = `tree:${params.spaceKey ?? 'all'}`;
    const { value: cached, generation } = await cache.getWithGeneration(userId, 'pages', cacheKey);
    if (cached) return cached;

    // Access control: same visibility predicate as the list route —
    //   - Confluence pages from user's accessible spaces (via RBAC)
    //   - Shared standalone articles (visible to all)
    //   - Their own private standalone articles
    // Local-space pages are always standalone, so they surface through the
    // visibility branches (#527/#528); local space keys are still merged into
    // the Confluence branch as belt-and-braces against legacy data drift.
    const rbacSpaces = await getUserAccessibleSpaces(userId);
    const localSpacesResult = await query<{ space_key: string }>(
      `SELECT space_key FROM spaces WHERE source = 'local'`,
    );
    const localSpaceKeys = localSpacesResult.rows.map((r) => r.space_key);
    const treeSpaces = Array.from(new Set([...rbacSpaces, ...localSpaceKeys]));
    const values: unknown[] = [treeSpaces, userId];
    let treeWhereClause = `WHERE ${visiblePagesPredicate(1, 2)} AND cp.deleted_at IS NULL`;

    if (params.spaceKey) {
      treeWhereClause += ' AND cp.space_key = $3';
      values.push(params.spaceKey);
    }

    const result = await query<{
      id: number;
      confluence_id: string;
      space_key: string;
      title: string;
      page_type: string;
      parent_numeric_id: number | null;
      sort_order: number;
      labels: string[];
      last_modified_at: Date | null;
      embedding_dirty: boolean;
      embedding_status: string;
      embedded_at: Date | null;
      embedding_error: string | null;
      icon_kind: string | null;
      icon_value: string | null;
      icon_color: string | null;
      icon_filled: boolean | null;
      baseline_id: string | null;
      frozen_version: number | null;
    }>(
      // #959: order by sort_order first so a persisted drag-reorder (written by
      // PUT /pages/:id/reorder) survives the tree refetch instead of snapping
      // back to alphabetical order. Confluence pages default to sort_order 0,
      // so they still fall back to title order within each sibling group.
      `SELECT cp.id, cp.confluence_id, cp.space_key, cp.title, cp.page_type,
              parent_page.id as parent_numeric_id, cp.sort_order,
              cp.labels, cp.last_modified_at,
              cp.embedding_dirty, cp.embedding_status, cp.embedded_at, cp.embedding_error,
              cp.icon_kind, cp.icon_value, cp.icon_color, cp.icon_filled,
              cp.baseline_id, cp.frozen_version
       FROM pages cp
       LEFT JOIN pages parent_page ON (
         parent_page.confluence_id = cp.parent_id
         OR CAST(parent_page.id AS TEXT) = cp.parent_id
       ) AND parent_page.deleted_at IS NULL
       ${treeWhereClause}
       ORDER BY cp.sort_order ASC, cp.title ASC`,
      values,
    );

    const response = {
      items: result.rows.map((row) => ({
        id: String(row.id),
        spaceKey: row.space_key,
        title: row.title,
        pageType: row.page_type ?? 'page',
        parentId: row.parent_numeric_id ? String(row.parent_numeric_id) : null,
        sortOrder: row.sort_order,
        labels: row.labels,
        lastModifiedAt: row.last_modified_at,
        embeddingDirty: row.embedding_dirty,
        embeddingStatus: row.embedding_status,
        embeddedAt: row.embedded_at,
        embeddingError: row.embedding_error,
        icon: toPageIcon(row.icon_kind, row.icon_value, row.icon_color, row.icon_filled),
        ...freezeSummary(row),
      })),
      total: result.rows.length,
    };

    await cache.setIfCurrent(userId, 'pages', cacheKey, generation, response);
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

    const { value: cached, generation } = await cache.getWithGeneration<{
      authors: string[]; labels: string[];
    }>(userId, 'pages', cacheKey);
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

    await cache.setIfCurrent(userId, 'pages', cacheKey, generation, response, 300); // 5-minute TTL

    return response;
  });

  // GET /api/pages/trash - list soft-deleted standalone articles for the current user
  // Registered before /pages/:id to avoid Fastify treating "trash" as an :id param
  fastify.get('/pages/trash', async (request) => {
    const userId = request.userId;

    // JOIN users for the deleter's username: only the owner can soft-delete a
    // standalone article (see DELETE /pages/:id), so owner == deleter.
    const result = await query<{
      id: number; title: string; source: string; visibility: string;
      deleted_at: Date; last_synced: Date; deleted_by: string;
    }>(
      `SELECT p.id, p.title, p.source, p.visibility, p.deleted_at, p.last_synced,
              u.username AS deleted_by
       FROM pages p
       JOIN users u ON u.id = p.created_by_user_id
       WHERE p.source = 'standalone' AND p.deleted_at IS NOT NULL AND p.created_by_user_id = $1
       ORDER BY p.deleted_at DESC`,
      [userId],
    );

    return TrashListResponseSchema.parse({
      items: result.rows.map((row) => ({
        id: String(row.id),
        title: row.title,
        source: row.source,
        visibility: row.visibility,
        deletedAt: row.deleted_at.toISOString(),
        createdAt: row.last_synced.toISOString(),
        deletedBy: row.deleted_by,
        // Mirrors the maintenance purge (purgeExpiredStandalonePages) so the
        // date shown in the Trash UI matches when the row actually disappears.
        autoPurgeAt: new Date(
          row.deleted_at.getTime() + STANDALONE_TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000,
        ).toISOString(),
      })),
      total: result.rows.length,
    });
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
      verified_at: Date | null;
      icon_kind: string | null;
      icon_value: string | null;
      icon_color: string | null;
      icon_filled: boolean | null;
      baseline_id: string | null;
      frozen_version: number | null;
    }>(
      `SELECT cp.id, cp.confluence_id, cp.space_key, cp.title, cp.page_type,
              cp.body_storage, cp.body_html, cp.body_text,
              cp.version, cp.parent_id, cp.labels, cp.author, cp.last_modified_at, cp.last_synced,
              cp.embedding_dirty, cp.embedding_status, cp.embedded_at, cp.embedding_error,
              cp.quality_score, cp.quality_status, cp.quality_completeness, cp.quality_clarity,
              cp.quality_structure, cp.quality_accuracy, cp.quality_readability,
              cp.quality_summary, cp.quality_analyzed_at, cp.quality_error,
              -- Same predicate as GET /pages/tree's LEFT JOIN (#1636): the dual
              -- identifier join, so a synced child (parent_id = parent's
              -- confluence_id) and a standalone child (parent_id = parent's PK)
              -- are both found. The old form carried a cp.confluence_id IS NOT
              -- NULL guard, which made every standalone parent answer false
              -- however many sub-articles it had.
              --
              -- Another user's PRIVATE standalone child does not count. This
              -- page is served to any reader of a shared page, and the tree
              -- this flag drives an expander for hides those rows
              -- (visiblePagesPredicate), so counting them both disclosed their
              -- existence and offered an expander that yields nothing.
              -- IS DISTINCT FROM, because a NULL creator must not make the
              -- comparison NULL and silently drop the child.
              EXISTS(SELECT 1 FROM pages c2
                      WHERE (c2.parent_id = cp.confluence_id OR CAST(cp.id AS TEXT) = c2.parent_id)
                        AND c2.deleted_at IS NULL
                        AND NOT (c2.source = 'standalone' AND c2.visibility = 'private'
                                 AND c2.created_by_user_id IS DISTINCT FROM $2)) as has_children,
              cp.summary_html, cp.summary_status, cp.summary_generated_at, cp.summary_model, cp.summary_error,
              cp.source, cp.visibility, cp.created_by_user_id,
              (cp.draft_body_html IS NOT NULL) as has_draft, cp.draft_updated_at,
              cp.verified_at, cp.icon_kind, cp.icon_value, cp.icon_color, cp.icon_filled,
              cp.baseline_id, cp.frozen_version
       FROM pages cp
       WHERE ${isNumericId ? 'cp.id = $1' : 'cp.confluence_id = $1'}
         AND cp.deleted_at IS NULL`,
      [isNumericId ? parseInt(id, 10) : id, userId],
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

    // Counted through the same walk the delete cascade uses (#1636), from the
    // page's own PK — so it cannot drift from the ids the trash actually
    // takes, and a Confluence-id lookup still gets the row's numeric root.
    // Owner-scoped for the same reason the cascade is: it counts what a trash
    // by THIS caller would move, which is never another user's article.
    const descendantCount = await activeDescendantCount(row.id, userId);
    const lifecycleClient = await getPool().connect();
    let lifecycleState: PageLifecycleState;
    let renderedBodyHtml: string | null;
    try {
      await lifecycleClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      lifecycleState = await getPageLifecycleState(lifecycleClient, row.id, userId);
      renderedBodyHtml = await renderedFrozenPageBodyHtml(lifecycleClient, row.id, userId);
      await lifecycleClient.query('COMMIT');
    } catch (err) {
      await lifecycleClient.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      lifecycleClient.release();
    }

    return {
      id: String(row.id),
      confluenceId: row.confluence_id,
      spaceKey: row.space_key,
      title: row.title,
      pageType: row.page_type ?? 'page',
      bodyHtml: row.body_html,
      renderedBodyHtml,
      bodyText: row.body_text,
      version: row.version,
      parentId: row.parent_id,
      labels: row.labels,
      author: row.author,
      lastModifiedAt: row.last_modified_at,
      lastSynced: row.last_synced,
      hasChildren: row.has_children,
      // Live STANDALONE descendants, the page itself excluded (#1636): what the
      // confirm dialog names and what a trash of this page moves. Deliberately
      // not a restatement of `hasChildren` — the tree shows a Confluence
      // subtree the cascade will not take.
      descendantCount,
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
      // Creator's user id (standalone pages only; null for Confluence-synced).
      // Benign for viewers — lets the UI detect "own page" (e.g. to hide the
      // helpfulness widget on pages the current user authored).
      createdByUserId: row.created_by_user_id,
      hasDraft: row.has_draft,
      draftUpdatedAt: row.draft_updated_at?.toISOString() ?? null,
      verifiedAt: row.verified_at,
      icon: toPageIcon(row.icon_kind, row.icon_value, row.icon_color, row.icon_filled),
      ...lifecycleState,
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
    const userId = request.userId;

    // #1636: this used to match `parent_id = $1` alone, which disagrees with
    // both the tree and the `hasChildren` field for a synced child (linked by
    // confluence_id, not by the parent's PK). Resolve the page and ask the same
    // dual-identifier question `GET /api/pages/:id` asks, with the same numeric
    // normalisation its sibling routes apply to the id arm (#1167).
    //
    // The access decision below reads ONE row, so that row must be the one the
    // caller named. The id arm is a dual-identifier lookup, and a page whose PK
    // equals another page's `confluence_id` matches BOTH — with no ordering, the
    // answer came from whichever row the scan reached first, so a Confluence
    // decoy in a space the caller cannot read 404'd an id `GET /api/pages/:id`
    // serves 200. PK-first is the same resolution the detail route applies to a
    // numeric id (`cp.id = $1`), so the two can no longer disagree; the ordering
    // only breaks a tie — a numeric `confluence_id` with no PK match still
    // resolves through the confluence_id arm. LIMIT 1 states the single-row
    // contract the handler already relied on by reading `rows[0]`.
    const isNumericId = /^\d+$/.test(id);
    // The caller's id is the LAST parameter either way, so its placeholder
    // moves with the shape of the lookup above it.
    const userParam = isNumericId ? '$3' : '$2';
    const result = await query<{
      has_children: boolean;
      source: string;
      space_key: string | null;
      visibility: string;
      created_by_user_id: string | null;
    }>(
      `SELECT EXISTS(
                SELECT 1 FROM pages c2
                 WHERE (c2.parent_id = cp.confluence_id OR CAST(cp.id AS TEXT) = c2.parent_id)
                   AND c2.deleted_at IS NULL
                   AND NOT (c2.source = 'standalone' AND c2.visibility = 'private'
                            AND c2.created_by_user_id IS DISTINCT FROM ${userParam})
              ) as has_children,
              cp.source, cp.space_key, cp.visibility, cp.created_by_user_id
         FROM pages cp
        WHERE ${isNumericId ? '(cp.confluence_id = $1 OR cp.id::text = $2)' : 'cp.confluence_id = $1'}
          AND cp.deleted_at IS NULL
        ${isNumericId ? 'ORDER BY (cp.id::text = $2) DESC' : ''}
        LIMIT 1`,
      isNumericId ? [id, toPageIdText(id), userId] : [id, userId],
    );

    const row = result.rows[0];
    if (!row) throw fastify.httpErrors.notFound('Page not found');

    // Access control: same pattern as GET /pages/:id — 404, no existence
    // oracle. Resolving the row is new here (#1636): without this check the
    // 404-vs-200 split tells any authenticated caller that a page it cannot
    // read exists, and whether that page has children.
    if (row.source === 'confluence') {
      const spaces = await getUserAccessibleSpaces(userId);
      if (!row.space_key || !spaces.includes(row.space_key)) {
        throw fastify.httpErrors.notFound('Page not found');
      }
    } else {
      if (row.created_by_user_id !== userId && row.visibility !== 'shared') {
        throw fastify.httpErrors.notFound('Page not found');
      }
    }

    return { hasChildren: row.has_children };
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

    // Resolve page: try confluence_id first, then integer id.
    //
    // The id arm compares `id::text`, not `$1::int` (#1167). `pages.id` is
    // SERIAL (int4), so casting the *parameter* overflows on any Confluence
    // content id above 2^31 — and the `confluence_id` arm does not rescue it,
    // because the cast aborts the statement before the OR can match. Casting
    // the column instead cannot overflow, and migration 084 indexes exactly
    // this expression (`pages_id_text_idx ON pages ((id::text))`), so the arm
    // stays index-served. The numeric guard keeps a non-numeric id off that
    // arm, where it could never match anyway.
    //
    // `toPageIdText` restores the numeric normalisation the `::int` cast used
    // to provide: text comparison is literal, so a zero-padded '007' would no
    // longer find page 7. It applies to the id arm ONLY — confluence_id is a
    // text column and must still be matched verbatim.
    const isNumericId = /^\d+$/.test(id);
    const pageResult = await query<{ id: number; confluence_id: string | null; space_key: string | null; source: string; visibility: string; created_by_user_id: string | null }>(
      `SELECT id, confluence_id, space_key, source, visibility, created_by_user_id FROM pages
       WHERE ${isNumericId ? '(confluence_id = $1 OR id::text = $2)' : 'confluence_id = $1'}
         AND deleted_at IS NULL
       LIMIT 1`,
      isNumericId ? [id, toPageIdText(id)] : [id],
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
      icon_kind: string | null;
      icon_value: string | null;
      icon_color: string | null;
      icon_filled: boolean | null;
    };

    const treeResult = await query<FlatChildRow>(
      `WITH RECURSIVE tree AS (
         SELECT p.id, p.confluence_id, p.title, p.space_key, p.parent_id, 1 AS depth,
                p.icon_kind, p.icon_value, p.icon_color, p.icon_filled
         FROM pages p
         WHERE p.parent_id = $1 AND p.deleted_at IS NULL
         UNION ALL
         SELECT p.id, p.confluence_id, p.title, p.space_key, p.parent_id, t.depth + 1,
                p.icon_kind, p.icon_value, p.icon_color, p.icon_filled
         FROM pages p
         JOIN tree t ON p.parent_id = COALESCE(t.confluence_id, t.id::text)
         WHERE p.deleted_at IS NULL AND t.depth < $2
       )
       SELECT * FROM tree ORDER BY depth, ${sortColumn} ${sortOrder}
       LIMIT $3`,
      [parentLookupId, depth, MAX_TOTAL_NODES],
    );

    // Assemble flat rows into nested tree structure
    type ChildNode = {
      id: number;
      confluenceId: string | null;
      title: string;
      spaceKey: string | null;
      icon: ReturnType<typeof toPageIcon>;
      children?: ChildNode[];
    };
    const nodeMap = new Map<string, ChildNode>();
    const roots: ChildNode[] = [];

    for (const row of treeResult.rows) {
      const node: ChildNode = {
        id: row.id,
        confluenceId: row.confluence_id,
        title: row.title,
        spaceKey: row.space_key,
        icon: toPageIcon(row.icon_kind, row.icon_value, row.icon_color, row.icon_filled),
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
  fastify.post('/pages/:id/restore', async (request, reply) => {
    const { id } = IdParamSchema.parse(request.params);
    const userId = request.userId;

    const restored = await withHierarchyCascadeTransaction(async (client) => {
      const existing = await client.query<{
        id: number; title: string; source: string; parent_id: string | null;
        created_by_user_id: string | null; deleted_at: Date | null; visibility: string;
        notion_page_id: string | null;
      }>(
        `SELECT id, title, source, parent_id, created_by_user_id, deleted_at, visibility,
                notion_page_id
           FROM pages WHERE id = $1`,
        [id],
      );
      const page = existing.rows[0];
      if (!page) throw new PageWriteError(404, 'page_not_found', 'Page not found');
      if (page.source !== 'standalone') {
        throw new PageWriteError(400, 'restore_source_invalid', 'Only standalone articles can be restored');
      }
      if (page.created_by_user_id !== userId) {
        throw new PageWriteError(403, 'not_authorized', 'Not the owner');
      }
      if (!page.deleted_at) {
        return { page, restored: false, restoredCount: 0, rows: [] as Array<{ visibility: string }> };
      }

      const parentResolution = await resolveParentOf(page.parent_id, client);
      if (parentResolution.kind === 'ambiguous') {
        fastify.log.warn(
          { pageId: page.id, key: parentResolution.key, candidateIds: parentResolution.candidateIds },
          'pages: refused a restore whose parent identifier names more than one page (#1636)',
        );
        return {
          refusal: {
            statusCode: 409,
            error: 'Conflict',
            message:
              'Cannot restore because the stored parent identifier is ambiguous. ' +
              'Move or relocate the affected pages first.',
            reason: 'restore_parent_ambiguous',
          },
        };
      }
      if (
        parentResolution.kind === 'resolved' &&
        parentResolution.parent.deletedAt &&
        parentResolution.parent.source === 'standalone' &&
        parentResolution.parent.createdByUserId === userId
      ) {
        return {
          refusal: {
            statusCode: 409,
            error: 'Conflict',
            message: `Restore "${parentResolution.parent.title}" first`,
            reason: 'restore_ancestor_trashed',
          },
        };
      }
      if (
        parentResolution.kind === 'resolved' &&
        parentResolution.parent.deletedAt === null
      ) {
        await assertPageHierarchyParentsAvailable(client, [parentResolution.parent.id]);
      }

      if (page.notion_page_id) {
        const clash = await client.query<{ id: number }>(
          `SELECT id FROM pages
            WHERE created_by_user_id = $1
              AND deleted_at IS NULL
              AND id <> $2
              AND notion_page_id IS NOT NULL
              AND lower(replace(notion_page_id, '-', '')) = lower(replace($3, '-', ''))
            LIMIT 1`,
          [page.created_by_user_id, page.id, page.notion_page_id],
        );
        if (clash.rows.length > 0) {
          throw new PageWriteError(409, 'restore_import_conflict', 'A live import of this page already exists');
        }
      }

      const ambiguity = await findSubtreeKeyAmbiguity(page.id, client);
      if (ambiguity) {
        return { refusal: ambiguousSubtreeConflict(ambiguity, fastify.log) };
      }
      const batchIds = await trashBatchIds(page.id, userId, client);
      await lockPageLifecycle(client, batchIds);
      const batch = await client.query<{
        id: number;
        visibility: string;
        baseline_id: string | null;
      }>(
        `SELECT id, visibility, baseline_id
           FROM pages
          WHERE id = ANY($1::int[])
          ORDER BY id`,
        [batchIds],
      );
      const component: AuthorizedSubtreeComponent = {
        rootIds: [page.id],
        members: batch.rows.map((row) => ({
          id: row.id,
          visibility: row.visibility,
          baselineId: row.baseline_id,
        })),
      };
      assertSingleCascadeEditable(component, page.id);
      await lockPageWrites(client, batchIds);
      const rows = await client.query<{ visibility: string }>(
        'UPDATE pages SET deleted_at = NULL WHERE id = ANY($1::int[]) RETURNING visibility',
        [batchIds],
      );
      return { page, restored: true, restoredCount: batchIds.length, rows: rows.rows };
    });

    if (restored.refusal) {
      return reply.status(restored.refusal.statusCode).send(restored.refusal);
    }
    if (!restored.restored) {
      return { id: restored.page.id, title: restored.page.title, restored: false };
    }
    if (restored.rows.some((row) => row.visibility === 'shared')) {
      await cache.invalidateAcrossUsers('pages');
    } else {
      await cache.invalidate(userId, 'pages');
    }
    await logAuditEvent(userId, 'PAGE_RESTORED', 'page', String(id), {
      source: 'standalone',
      title: restored.page.title,
      restoredCount: restored.restoredCount,
    }, request);
    return { id: restored.page.id, title: restored.page.title, restored: true };
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
      const visibility = body.visibility ?? 'shared';
      const isFolder = pageType === 'folder';
      const effectiveBodyHtml = isFolder ? '' : body.bodyHtml;
      const { htmlToText } = await import('../../core/services/content-converter.js');
      const bodyText = isFolder ? '' : htmlToText(effectiveBodyHtml);

      // Use space key only for local spaces (already looked up above)
      const spaceKey: string | null = spaceSource === 'local' ? body.spaceKey! : null;

      // Creation is a hierarchy write even though it has no existing page id.
      // The empty protected transaction holds hierarchy SHARE; only then do we
      // resolve the parent and reject a pending destructive component.
      const newPage = await withPageWriteTransaction([], async (client) => {
        let parentPath: string | null = null;
        if (body.parentId) {
          const parentResult = await client.query<{
            id: number;
            path: string | null;
            space_key: string | null;
          }>(
            'SELECT id, path, space_key FROM pages WHERE id = $1 AND deleted_at IS NULL',
            [body.parentId],
          );
          const parent = parentResult.rows[0];
          if (!parent) throw fastify.httpErrors.badRequest('Parent page not found');
          if (spaceKey && parent.space_key !== spaceKey) {
            throw fastify.httpErrors.badRequest('Parent page must belong to the same space');
          }
          await assertPageHierarchyParentsAvailable(client, [parent.id]);
          parentPath = parent.path;
        }

        const result = await client.query<{ id: number; title: string; version: number }>(
          `INSERT INTO pages
             (title, body_html, body_text, body_storage, source, created_by_user_id,
              visibility, version, space_key, confluence_id, parent_id,
              page_type, embedding_dirty, image_analysis_dirty, embedding_status, last_synced, labels)
           VALUES ($1, $2, $3, NULL, 'standalone', $4, $5, 1, $6, NULL, $7,
                   $8, $9, $9, 'not_embedded', NOW(), $10)
           RETURNING id, title, version`,
          [body.title, effectiveBodyHtml, bodyText, userId,
           visibility, spaceKey, body.parentId ?? null,
           pageType, !isFolder, body.labels ?? []],
        );
        const created = result.rows[0]!;
        const newPath = parentPath ? `${parentPath}/${created.id}` : `/${created.id}`;
        const depth = newPath.split('/').filter(Boolean).length - 1;
        await client.query('UPDATE pages SET path = $1, depth = $2 WHERE id = $3',
          [newPath, depth, created.id]);
        return created;
      });

      // A new shared page appears in every user's lists/trees (#893) — clear
      // all users' caches so it isn't missing for them until the TTL expires.
      // Private pages only concern the creator.
      if (visibility === 'shared') {
        await cache.invalidateAcrossUsers('pages');
      } else {
        await cache.invalidate(userId, 'pages');
      }
      await logAuditEvent(userId, 'PAGE_CREATED', 'page', String(newPage.id),
        { source: 'standalone', title: body.title, visibility, spaceKey, pageType }, request);

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
    // RBAC: verify the caller may operate on the target space before creating
    // a page upstream. The Confluence PAT can permit more spaces than the
    // app-level RBAC scope, so mirror the PUT/DELETE guard here (#892).
    if (body.spaceKey) {
      const accessibleSpaces = await getUserAccessibleSpaces(userId);
      if (!accessibleSpaces.includes(body.spaceKey)) {
        throw fastify.httpErrors.forbidden('Access denied to this space');
      }
    }

    // #1623 — creating a page IN Confluence is Confluence work, not a local
    // write: a standalone row cannot even hold a Confluence space key (see the
    // local branch above), so there is no local path to fall back to. Refuse by
    // naming the integration, never by asking for credentials. Local spaces and
    // spaceless articles stay fully available while the integration is off.
    if (!(await isConfluenceEnabled(userId))) {
      throw fastify.httpErrors.badRequest(CONFLUENCE_DISABLED_MESSAGE);
    }

    const client = await getClientForUser(userId);
    if (!client) {
      throw fastify.httpErrors.badRequest('Confluence not configured');
    }

    // Convert TipTap HTML to Confluence storage format
    const storageBody = htmlToConfluence(body.bodyHtml);

    // A child create claims the resolved local parent as a hierarchy reference
    // before dispatch. The source-aware parent key is the Confluence id for a
    // synced parent and the local PK for a standalone parent. The reference is
    // not an authored target, so a frozen unchanged parent remains a legal
    // place to create a child; its revision and competing destructive intents
    // are still fenced.
    let remoteParentConfluenceId: string | null = null;
    let localParentReferenceId: string | null = null;
    let createIntent: PageWriteIntent | undefined;
    if (body.parentId) {
      const rawParentId = body.parentId;
      createIntent = await withPageWriteTransaction([], async (writeClient) => {
        const lookupId = /^\d+$/.test(rawParentId) ? toPageIdText(rawParentId) : rawParentId;
        const parentLookup = await writeClient.query<{
          id: number;
          confluence_id: string | null;
          space_key: string | null;
          source: string;
          deleted_at: Date | null;
        }>(
          `SELECT id, confluence_id, space_key, source, deleted_at
             FROM pages
            WHERE id::text = $1 OR confluence_id = $2
            ORDER BY id`,
          [lookupId, rawParentId],
        );
        if (parentLookup.rows.length !== 1) {
          throw new PageWriteError(
            409,
            parentLookup.rows.length === 0 ? 'parent_not_found' : 'parent_identifier_ambiguous',
            'The requested parent is unavailable',
          );
        }
        const parent = parentLookup.rows[0]!;
        const parentIsConfluence = parent.source === 'confluence';
        const resolvedLocalParentReference = parentIsConfluence
          ? parent.confluence_id
          : parent.source === 'standalone'
            ? String(parent.id)
            : null;
        if (
          !resolvedLocalParentReference ||
          parent.deleted_at !== null ||
          parent.space_key !== body.spaceKey
        ) {
          throw new PageWriteError(
            409,
            'parent_identity_mismatch',
            'The requested parent is unavailable',
          );
        }
        if (!(await userCanAccessPage(userId, parent.id, writeClient))) {
          throw new PageWriteError(403, 'parent_access_denied', 'Access denied to the parent page');
        }
        await assertPageHierarchyParentsAvailable(writeClient, [parent.id]);
        remoteParentConfluenceId = parentIsConfluence ? parent.confluence_id : null;
        localParentReferenceId = resolvedLocalParentReference;
        return reservePageWriteIntentInTransaction(writeClient, {
          pageIds: [parent.id],
          kind: 'pages.create.confluence',
          actorId: userId,
          effect: {
            effectClass: 'remote',
            parentPageId: parent.id,
            parentConfluenceId: remoteParentConfluenceId,
            spaceKey: body.spaceKey!,
            titleSha256: createHash('sha256').update(body.title).digest('hex'),
            storageSha256: createHash('sha256').update(storageBody).digest('hex'),
          },
        });
      });
    }

    const page = createIntent
      ? await runPageWriteIntentEffect(
          createIntent,
          {
            kind: 'remote',
            completesRemoteWork: true,
            terminalResult: (created) =>
              pagePublicationReceipt(created.id, created.version.number, created),
          },
          () => client.createPage(
            body.spaceKey!,
            body.title,
            storageBody,
            remoteParentConfluenceId ?? undefined,
          ),
        )
      : await client.createPage(body.spaceKey!, body.title, storageBody, undefined);
    const publishedStorage = page.body?.storage?.value ?? storageBody;
    if (
      createIntent &&
      (createHash('sha256').update(page.title).digest('hex') !==
        createHash('sha256').update(body.title).digest('hex') ||
        createHash('sha256').update(publishedStorage).digest('hex') !==
          createHash('sha256').update(storageBody).digest('hex'))
    ) {
      throw new PageWriteError(
        409,
        'intent_terminal_evidence_mismatch',
        'The acknowledged Confluence child differs from the requested publication',
      );
    }
    const publication = {
      confluenceId: page.id,
      spaceKey: body.spaceKey!,
      parentConfluenceId: localParentReferenceId,
      title: page.title,
      storage: publishedStorage,
      version: page.version.number,
    };
    let createdPageState: PublishedConfluencePage;
    if (createIntent) {
      const admittedCreateIntent = createIntent;
      createdPageState = await completePageWriteIntent(
        admittedCreateIntent,
        async (writeClient) => {
          const actor = await writeClient.query<{ active: boolean }>(
            'SELECT deactivated_at IS NULL AS active FROM users WHERE id = $1',
            [userId],
          );
          if (
            actor.rows[0]?.active !== true ||
            !(await userCanAccessPage(
              userId,
              admittedCreateIntent.pageIds[0]!,
              writeClient,
            ))
          ) {
            throw new PageWriteError(
              403,
              'parent_access_changed',
              'Access to the Confluence parent changed before local publication',
            );
          }
          const published = await publishCreatedConfluencePage(writeClient, publication);
          await enqueuePageWriteInvalidation(writeClient, admittedCreateIntent.id);
          return published;
        },
      );
    } else {
      createdPageState = await withPageWriteTransaction([], (writeClient) =>
        publishCreatedConfluencePage(writeClient, publication));
    }
    const localPageId = createdPageState.id;

    // A new Confluence page is visible to every user with space access (#893),
    // and the cached spaces payload carries per-space pageCount which this
    // create just changed — clear both caches for every user.
    await cache.invalidateAcrossUsers('pages');
    await cache.invalidateAcrossUsers('spaces');

    // Labels supplied at creation (#1133). Confluence owns them for a synced
    // page, so they go upstream first and the local row mirrors what stuck. A
    // failure here must not fail the create: the page exists and is correct.
    const createLabels = body.labels;
    if (createLabels?.length && localPageId !== undefined && createdPageState) {
      const targetLabels = [...new Set([...(createdPageState.labels ?? []), ...createLabels])];
      let labelsIntent: PageWriteIntent | undefined;
      try {
        labelsIntent = await reservePageWriteIntent({
          pageIds: [localPageId],
          expectedRevisions: {
            [localPageId]: {
              contentRevision: createdPageState.contentRevision,
              lifecycleRevision: createdPageState.lifecycleRevision,
            },
          },
          kind: 'pages.create.labels',
          actorId: userId,
          effect: {
            effectClass: 'remote',
            confluenceId: page.id,
            labelsSha256: createHash('sha256').update(JSON.stringify(targetLabels)).digest('hex'),
            priorLabels: createdPageState.labels ?? [],
            targetLabels,
          },
        });
        const admittedLabelsIntent = labelsIntent;
        let labelsClient: ConfluenceClient;
        try {
          labelsClient = await withPageWriteTransaction(
            [localPageId],
            (writeClient) => loadCurrentConfluenceWriteClient(
              writeClient, admittedLabelsIntent, localPageId, userId, page.id,
            ),
            { intent: admittedLabelsIntent },
          );
        } catch (error) {
          await cancelPageWriteIntentBeforeEffect(admittedLabelsIntent);
          throw error;
        }
        await runPageWriteIntentEffect(
          labelsIntent,
          { kind: 'remote', completesRemoteWork: true },
          () => labelsClient.addLabels(page.id, createLabels),
        );
        const labelsIntentId = labelsIntent.id;
        await completePageWriteIntent(labelsIntent, async (writeClient) => {
          await loadAuthorizedContentWriteState(
            writeClient, localPageId, userId, admittedLabelsIntent.revisions[localPageId]!,
          );
          await writeClient.query(
            'UPDATE pages SET labels = $2 WHERE id = $1',
            [localPageId, targetLabels],
          );
          await enqueuePageWriteInvalidation(writeClient, labelsIntentId);
        });
      } catch (err) {
        // The create itself succeeded. Keep a possibly-effectful labels intent
        // for reconciliation rather than guessing whether the remote call stuck.
        logger.warn(
          { err, confluenceId: page.id, intentId: labelsIntent?.id },
          'Page created but its labels outcome requires reconciliation',
        );
      }
    }

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
      content_revision: string; lifecycle_revision: string;
    }>(
      `SELECT id, version, space_key, source, created_by_user_id, visibility,
              confluence_id, deleted_at, page_type, content_revision::text,
              lifecycle_revision::text
         FROM pages WHERE ${isNumericId ? 'id = $1' : 'confluence_id = $1'}`,
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

    // #1623 — ONE rule: an article with no upstream, and a synced article whose
    // owner switched the integration off, take the SAME local write path. No
    // remote version check, no image upload, no `updatePage`.
    if (await pageWriteStaysLocal(userId, existingPage.source)) {
      // --- Local write: no Confluence call ---

      // Access control. A Confluence-sourced article is space-scoped no matter
      // which mode this user is in, so it keeps the space check the remote path
      // applies below instead of the standalone owner rule (its
      // `created_by_user_id` is NULL — sync created the row).
      if (existingPage.source === 'confluence') {
        if (existingPage.space_key) {
          const accessibleSpaces = await getUserAccessibleSpaces(userId);
          if (!accessibleSpaces.includes(existingPage.space_key)) {
            throw fastify.httpErrors.forbidden('Access denied to this space');
          }
        }
      } else if (existingPage.created_by_user_id !== userId && existingPage.visibility !== 'shared') {
        throw fastify.httpErrors.forbidden('Not authorized to edit this page');
      }

      // Visibility is security metadata and stays mutable while frozen. Classify
      // against the persisted authored payload under the lifecycle lock: a stale
      // client cannot smuggle old title/body bytes through a visibility request.
      const runtimeId = await getPageWriterRuntimeId();
      const writeClient = await getPool().connect();
      let newVersion = existingPage.version;
      let authoredContentChanged = false;
      let visibilityChanged = false;
      let committedVisibility = existingPage.visibility;
      let committedSource = existingPage.source;
      let committedSpaceKey = existingPage.space_key;
      try {
        await writeClient.query('BEGIN');
        await lockPageWriterRuntime(writeClient, runtimeId);
        await lockPageLifecycle(writeClient, [existingPage.id]);
        const actor = await writeClient.query(
          'SELECT 1 FROM users WHERE id = $1 AND deactivated_at IS NULL',
          [userId],
        );
        if (actor.rowCount !== 1) {
          throw new PageWriteError(403, 'not_authorized', 'Not authorized to edit this page');
        }
        const locked = await writeClient.query<{
          title: string;
          body_html: string;
          version: number;
          visibility: string;
          deleted_at: Date | null;
          source: string;
          created_by_user_id: string | null;
          space_key: string | null;
          page_type: string;
        }>(
          `SELECT title, body_html, version, visibility, deleted_at,
                  source, created_by_user_id, space_key, page_type
             FROM pages
            WHERE id = $1
            FOR UPDATE`,
          [existingPage.id],
        );
        const current = locked.rows[0];
        if (!current) throw fastify.httpErrors.notFound('Page not found');
        if (current.deleted_at) {
          throw fastify.httpErrors.badRequest('Cannot edit a page that is in the trash');
        }
        if (current.source !== existingPage.source) {
          throw fastify.httpErrors.conflict(
            'Page source changed while you were editing it. Please refresh and try again.',
          );
        }
        if (current.source === 'confluence') {
          if (current.space_key) {
            const accessibleSpaces = await getUserAccessibleSpaces(userId, writeClient);
            if (!accessibleSpaces.includes(current.space_key)) {
              throw fastify.httpErrors.forbidden('Access denied to this space');
            }
          }
        } else if (
          current.created_by_user_id !== userId
          && current.visibility !== 'shared'
        ) {
          throw fastify.httpErrors.forbidden('Not authorized to edit this page');
        }
        if (!(await userCanAccessPage(userId, existingPage.id, writeClient))) {
          throw new PageWriteError(403, 'not_authorized', 'Not authorized to edit this page');
        }
        if (current.page_type === 'folder' && body.bodyHtml && body.bodyHtml.trim() !== '') {
          throw fastify.httpErrors.badRequest(
            'Folder pages cannot have body content. Only the title can be updated.',
          );
        }
        committedVisibility = current.visibility;
        committedSource = current.source;
        committedSpaceKey = current.space_key;

        const protectedPayloadUnchanged =
          current.title === body.title && current.body_html === body.bodyHtml;
        visibilityChanged =
          body.visibility !== undefined && body.visibility !== current.visibility;

        if (protectedPayloadUnchanged) {
          if (visibilityChanged) {
            await writeClient.query(
              'UPDATE pages SET visibility = $2 WHERE id = $1',
              [existingPage.id, body.visibility],
            );
          }
          newVersion = current.version;
        } else {
          await lockPageWrites(writeClient, [existingPage.id]);
          await rejectIfLiveCollabRoom(
            existingPage.id,
            (message) => fastify.httpErrors.conflict(message),
          );
          if (body.version !== undefined && body.version < current.version) {
            throw fastify.httpErrors.conflict(
              'Page has been modified since you loaded it. Please refresh and try again.',
            );
          }

          const bodyText = htmlToText(body.bodyHtml);
          newVersion = current.version + 1;
          const userIdParamIndex = body.visibility ? 7 : 6;
          const versionGuardIndex = body.visibility ? 8 : 7;
          const updateResult = await writeClient.query(
            `UPDATE pages SET
               title = $2, body_html = $3, body_text = $4,
               version = $5, last_modified_at = NOW(), embedding_dirty = TRUE,
               image_analysis_dirty = CASE
                 WHEN body_html IS DISTINCT FROM $3 THEN TRUE
                 ELSE image_analysis_dirty
               END,
               embedding_status = 'not_embedded', embedded_at = NULL,
               summary_status = 'pending', summary_retry_count = 0,
               quality_status = 'pending', quality_retry_count = 0,
               local_modified_at = NOW(), local_modified_by = $${userIdParamIndex}
               ${body.visibility ? ', visibility = $6' : ''}
             WHERE id = $1 AND version = $${versionGuardIndex}`,
            body.visibility
              ? [existingPage.id, body.title, body.bodyHtml, bodyText, newVersion, body.visibility, userId, current.version]
              : [existingPage.id, body.title, body.bodyHtml, bodyText, newVersion, userId, current.version],
          );
          if ((updateResult.rowCount ?? 0) === 0) {
            throw fastify.httpErrors.conflict(
              'Page has been modified since you loaded it. Please refresh and try again.',
            );
          }
          authoredContentChanged = true;
        }
        await writeClient.query('COMMIT');
      } catch (err) {
        await writeClient.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        writeClient.release();
      }

      if (authoredContentChanged) {
        await invalidateCollabDocAfterBodyWrite(existingPage.id);
      }

      // A shared page's list rows (title/snippet) and a visibility flip both
      // change what OTHER users see (#893) — their cached trees/lists would
      // serve stale data for up to the cache TTL (15 min) if we only
      // invalidated the editor's own cache. Private edits stay per-user.
      // A Confluence-sourced article is visible to every user with space
      // access (#893), so a local write to one clears what the remote path
      // would have cleared.
      if (visibilityChanged || committedVisibility === 'shared' || committedSource === 'confluence') {
        await cache.invalidateAcrossUsers('pages');
      } else {
        await cache.invalidate(userId, 'pages');
      }
      await logAuditEvent(userId, 'PAGE_UPDATED', 'page', String(id),
        // `pushedToConfluence: false` on a synced article is the audit trail's
        // record that the edit stayed local (#1623).
        {
          source: committedSource,
          title: body.title,
          ...(committedSource === 'confluence' ? { pushedToConfluence: false } : {}),
        }, request);

      emitWebhookEvent({
        eventType: 'page.updated',
        payload: {
          pageId: existingPage.id,
          title: body.title,
          spaceKey: committedSpaceKey,
          updatedAt: new Date().toISOString(),
        },
      });

      return { id: existingPage.id, title: body.title, version: newVersion, source: committedSource };
    }

    // --- Confluence article: existing flow ---
    // RBAC: verify user has access to this page's space before allowing edit
    if (existingPage.space_key) {
      const accessibleSpaces = await getUserAccessibleSpaces(userId);
      if (!accessibleSpaces.includes(existingPage.space_key)) {
        throw fastify.httpErrors.forbidden('Access denied to this space');
      }
    }

    await rejectIfLiveCollabRoom(existingPage.id, (m) => fastify.httpErrors.conflict(m));

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
    const expectedRevision: PageRevision = {
      contentRevision: existingPage.content_revision,
      lifecycleRevision: existingPage.lifecycle_revision,
    };
    const runtimeId = await getPageWriterRuntimeId();
    const reservationClient = await getPool().connect();
    let writeIntent: PageWriteIntent;
    try {
      await reservationClient.query('BEGIN');
      await lockPageWriterRuntime(reservationClient, runtimeId);
      await lockPageLifecycle(reservationClient, [existingPage.id]);
      await loadAuthorizedContentWriteState(reservationClient, existingPage.id, userId, expectedRevision);
      writeIntent = await reservePageWriteIntentInTransaction(reservationClient, {
        pageIds: [existingPage.id],
        kind: 'pages.update.confluence',
        actorId: userId,
        expectedRevisions: { [existingPage.id]: expectedRevision },
        effect: {
          effectClass: 'remote',
          confluenceId: existingPage.confluence_id,
          expectedVersion: existingPage.version,
          targetTitle: body.title,
          targetBodyHtmlSha256: createHash('sha256').update(body.bodyHtml).digest('hex'),
        },
      });
      await reservationClient.query('COMMIT');
    } catch (error) {
      await reservationClient.query('ROLLBACK');
      throw error;
    } finally {
      reservationClient.release();
    }

    let admittedClient: ConfluenceClient;
    try {
      admittedClient = await withPageWriteTransaction(
        [existingPage.id],
        (writeClient) => loadCurrentConfluenceWriteClient(
          writeClient, writeIntent, existingPage.id, userId, existingPage.confluence_id!,
        ),
        { intent: writeIntent },
      );
    } catch (error) {
      await cancelPageWriteIntentBeforeEffect(writeIntent);
      throw error;
    }

    const publication = await runPageWriteIntentEffect(
      writeIntent,
      {
        kind: 'remote',
        completesRemoteWork: true,
        terminalResult: (result) => result.receipt,
      },
      async () => {
        const uploadedBodyHtml = await uploadLocalImagesToConfluence(
          body.bodyHtml,
          existingPage.confluence_id!,
          admittedClient,
          request.log,
        );
        const nextStorageBody = htmlToConfluence(uploadedBodyHtml);
        const currentVersion = existingPage.version ?? body.version ?? 1;
        const nextPage = await admittedClient.updatePage(
          existingPage.confluence_id!,
          body.title,
          nextStorageBody,
          currentVersion,
        );
        return {
          confPage: nextPage,
          receipt: pagePublicationReceipt(existingPage.confluence_id!, currentVersion + 1, nextPage),
        };
      },
    );
    const confPage = await withPageWriteTransaction([existingPage.id], async (writeClient) => {
      const currentClient = await loadCurrentConfluenceWriteClient(
        writeClient, writeIntent, existingPage.id, userId, existingPage.confluence_id!,
      );
      return confirmPagePublication(currentClient, publication.receipt, publication.confPage);
    }, { intent: writeIntent });

    // Update local cache
    const bodyHtml = confluenceToHtml(
      confPage.body.storage.value,
      existingPage.confluence_id!,
      existingPage.space_key ?? undefined,
    );
    const bodyText = htmlToText(bodyHtml);

    await completePageWriteIntent(writeIntent, async (writeClient) => {
      await loadAuthorizedContentWriteState(
        writeClient, existingPage.id, userId, writeIntent.revisions[existingPage.id]!,
      );
      await writeClient.query(
        `UPDATE pages SET
           title = $2, body_storage = $3, body_html = $4, body_text = $5,
           version = $6, last_synced = NOW(), embedding_dirty = TRUE,
           image_analysis_dirty = CASE
             WHEN body_html IS DISTINCT FROM $4 THEN TRUE
             ELSE image_analysis_dirty
           END,
           embedding_status = 'not_embedded', embedded_at = NULL,
           last_modified_at = NOW(),
           summary_status = 'pending', summary_retry_count = 0,
           quality_status = 'pending', quality_retry_count = 0,
           local_modified_at = NULL, local_modified_by = NULL
         WHERE id = $1`,
        [existingPage.id, confPage.title, confPage.body.storage.value,
         bodyHtml, bodyText, confPage.version.number],
      );
      await enqueuePageWriteInvalidation(writeClient, writeIntent.id);
    });

    await invalidateCollabDocAfterBodyWrite(existingPage.id);

    // Confluence pages are visible to every user with space access (#893), so
    // clear every user's cached lists/trees, not just the editor's.
    await cache.invalidateAcrossUsers('pages');

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
  fastify.delete('/pages/:id', async (request, reply) => {
    const { id } = IdParamSchema.parse(request.params);
    const userId = request.userId;

    // Parse query for permanent flag
    const queryParams = z.object({ permanent: z.string().optional() }).parse(request.query);
    const isNumericId = /^\d+$/.test(id);

    // Load the page to determine source
    const existing = await query<{
      id: number; source: string; created_by_user_id: string | null;
      confluence_id: string | null; space_key: string | null; visibility: string;
      content_revision: string; lifecycle_revision: string;
    }>(
      `SELECT id, source, created_by_user_id, confluence_id, space_key, visibility,
              content_revision::text, lifecycle_revision::text
         FROM pages WHERE ${isNumericId ? 'id = $1' : 'confluence_id = $1'}`,
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

      const isPermanent = queryParams.permanent === 'true';

      // Expansion, ambiguity/freeze checks and either the SQL mutation or the
      // durable whole-component reservation share one hierarchy-exclusive
      // transaction. Foreign-owned and synced descendants remain traversal
      // links only and therefore cannot block or leak through the refusal.
      const admitted = await withHierarchyCascadeTransaction(async (client) => {
        const root = await client.query<{
          id: number;
          source: string;
          created_by_user_id: string | null;
          baseline_id: string | null;
        }>(
          'SELECT id, source, created_by_user_id, baseline_id FROM pages WHERE id = $1',
          [existingPage.id],
        );
        const currentRoot = root.rows[0];
        if (!currentRoot) throw new PageWriteError(404, 'page_not_found', 'Page not found');
        if (currentRoot.source !== 'standalone' || currentRoot.created_by_user_id !== userId) {
          throw new PageWriteError(403, 'not_authorized', 'Not authorized to delete this page');
        }
        if (currentRoot.baseline_id !== null) {
          throw new PageWriteError(423, 'page_is_frozen', 'Protected page content is frozen');
        }
        const ambiguity = await findSubtreeKeyAmbiguity(existingPage.id, client);
        if (ambiguity) {
          return { refusal: ambiguousSubtreeConflict(ambiguity, fastify.log) };
        }
        const component = (await authorizedSubtreeComponents(
          client,
          [existingPage.id],
          userId,
          isPermanent,
        ))[0];
        if (!component) throw new PageWriteError(404, 'page_not_found', 'Page not found');
        const targetIds = component.members.map((member) => member.id);
        await lockPageLifecycle(client, targetIds);
        assertSingleCascadeEditable(component, existingPage.id);

        if (isPermanent) {
          const intent = await reservePageWriteIntentInTransaction(client, {
            pageIds: targetIds,
            kind: 'pages.delete.standalone',
            actorId: userId,
            effect: {
              effectClass: 'local',
              rootPageId: existingPage.id,
              targetCount: targetIds.length,
              attachmentStores: ['attachment-cache', 'local', 'page-icons'],
            },
          });
          return { component, intent, rows: null };
        }

        await lockPageWrites(client, targetIds);
        const result = await client.query<{ id: number; visibility: string }>(
          `UPDATE pages
              SET deleted_at = NOW()
            WHERE id = ANY($1::int[])
              AND deleted_at IS NULL
              AND source = 'standalone'
              AND created_by_user_id = $2
            RETURNING id, visibility`,
          [targetIds, userId],
        );
        if (result.rows.length !== targetIds.length) {
          throw new PageWriteError(409, 'subtree_changed', 'The authorized subtree changed before deletion');
        }
        await client.query(
          'DELETE FROM pinned_pages WHERE user_id = $1 AND page_id = ANY($2::int[])',
          [userId, targetIds],
        );
        return { component, intent: null, rows: result.rows };
      });
      if (admitted.refusal) {
        return reply.status(admitted.refusal.statusCode).send(admitted.refusal);
      }

      let affectedRows: Array<{ id: number; visibility: string }>;
      if (admitted.intent) {
        const deleteIntent = admitted.intent;
        let destroyed: Array<{ id: number; visibility: string }> = [];
        await runPageWriteIntentEffect(deleteIntent, { kind: 'local' }, async () => {
          const cleanupClient = await getPool().connect();
          let transactionOpen = false;
          let attachmentLockHeld = false;
          let discardClient: Error | undefined;
          const onClientError = (error: Error) => {
            discardClient ??= error;
          };
          cleanupClient.on('error', onClientError);
          try {
            await cleanupClient.query('SET statement_timeout = 0');
            await cleanupClient.query('BEGIN');
            transactionOpen = true;
            // Lifecycle/hierarchy acquisition precedes the filesystem barrier:
            // backup takes these in the opposite direction.
            await lockPageWrites(cleanupClient, deleteIntent.pageIds, { intent: deleteIntent });
            await cleanupClient.query('SELECT pg_advisory_lock_shared($1)', [
              ATTACHMENT_SNAPSHOT_LOCK_ID,
            ]);
            attachmentLockHeld = true;
            await withLocalAttachmentMutationLock(async (writeClient) => {
              const advanced = await advancePageWriteIntentInTransaction(
                writeClient,
                deleteIntent,
                async (client) => {
                  const result = await client.query<{ id: number; visibility: string }>(
                    `DELETE FROM pages
                      WHERE id = ANY($1::int[])
                        AND source = 'standalone'
                        AND created_by_user_id = $2
                      RETURNING id, visibility`,
                    [deleteIntent.pageIds, userId],
                  );
                  if (result.rows.length !== deleteIntent.pageIds.length) {
                    throw new PageWriteError(
                      409,
                      'subtree_changed',
                      'The admitted subtree changed before permanent deletion',
                    );
                  }
                  await client.query(
                    'DELETE FROM pinned_pages WHERE user_id = $1 AND page_id = ANY($2::int[])',
                    [userId, deleteIntent.pageIds],
                  );
                  await enqueuePageWriteInvalidation(client, deleteIntent.id);
                  return result.rows;
                },
              );
              await writeClient.query('COMMIT');
              transactionOpen = false;
              deleteIntent.revisions = advanced.revisions;
              destroyed = advanced.result;
              for (const row of destroyed) {
                await cleanupStandalonePageAttachmentDirs(row, writeClient);
              }
            }, cleanupClient);
          } catch (error) {
            if (transactionOpen) {
              try {
                await cleanupClient.query('ROLLBACK');
              } catch (rollbackError) {
                discardClient ??=
                  rollbackError instanceof Error
                    ? rollbackError
                    : new Error(String(rollbackError));
              }
            }
            throw error;
          } finally {
            if (attachmentLockHeld) {
              try {
                await cleanupClient.query('SELECT pg_advisory_unlock_shared($1)', [
                  ATTACHMENT_SNAPSHOT_LOCK_ID,
                ]);
              } catch (unlockError) {
                discardClient ??=
                  unlockError instanceof Error ? unlockError : new Error(String(unlockError));
              }
            }
            try {
              await cleanupClient.query('RESET statement_timeout');
            } catch (resetError) {
              discardClient ??=
                resetError instanceof Error ? resetError : new Error(String(resetError));
            }
            cleanupClient.removeListener('error', onClientError);
            cleanupClient.release(discardClient);
          }
        });
        await completePageWriteIntent(deleteIntent, async () => undefined);
        affectedRows = destroyed;
      } else {
        affectedRows = admitted.rows ?? [];
      }
      const affectedIds = affectedRows.map((row) => row.id);
      const touchedSharedPage = affectedRows.some((row) => row.visibility === 'shared');

      // Per-id side effects for a cascade that has ALREADY COMMITTED, so none
      // of them may abort the rest. `allSettled`, not a bare loop: an unguarded
      // await here meant one failing tombstone — `closeRoomSockets` and the
      // Redis publish inside it are not best-effort — skipped every later id's
      // tombstone and webhook AND jumped over the cache invalidation and the
      // audit row below, leaving a destructive committed change with no trail
      // and a stale cache, reported to the client as a 500. The Confluence
      // hard-delete path in this file already uses `allSettled` for exactly
      // this.
      const sideEffects = await Promise.allSettled(
        affectedIds.map(async (pageId) => {
          await tombstoneCollabRoomAfterCommit(pageId);
          emitWebhookEvent({
            eventType: 'page.deleted',
            payload: { pageId, isHardDelete: isPermanent },
          });
        }),
      );
      for (const outcome of sideEffects) {
        if (outcome.status === 'rejected') {
          fastify.log.warn(
            { err: outcome.reason, rootPageId: existingPage.id },
            'pages: a page.deleted side effect failed after the delete had committed',
          );
        }
      }

      // A shared standalone page is visible to every user (#893), so its
      // removal must clear all users' cached lists/trees. Read off the ROWS the
      // cascade touched, not off the target: visibility is per page, so a
      // private parent can hold a shared sub-article, and keying the scope on
      // the target alone left every other user holding a stale tree.
      // ONCE per request, never per descendant: the cascade changed one tree.
      if (touchedSharedPage) {
        await cache.invalidateAcrossUsers('pages');
      } else {
        await cache.invalidate(userId, 'pages');
      }
      // ONE audit row, for the ROOT. Audit rows are read by humans and must
      // stay bounded, so the payload carries the cascade's size, not its ids.
      await logAuditEvent(userId, 'PAGE_DELETED', 'page', String(id),
        {
          source: 'standalone',
          permanent: isPermanent,
          cascadedCount: affectedIds.filter((pageId) => pageId !== existingPage.id).length,
        }, request);

      return { message: isPermanent ? 'Page permanently deleted' : 'Page moved to trash' };
    }

    // --- Confluence-sourced article ---
    // A missing space is not authority to delete an unscoped Confluence row.
    const accessibleSpaces = await getUserAccessibleSpaces(userId);
    if (!existingPage.space_key || !accessibleSpaces.includes(existingPage.space_key)) {
      throw fastify.httpErrors.forbidden('Access denied to this space');
    }

    // #1623 — ONE rule, delete flavour. With the integration off the delete
    // stays local: the local row is destroyed exactly as it is below, and
    // `deletePage` is never called. The Confluence page survives, so turning
    // the integration back on hands this page to the sync upsert that already
    // re-imports anything present upstream — no new reconciliation model.
    //
    // The row is DESTROYED rather than trashed because the trash is
    // standalone-only (`GET /pages/trash` and `/restore` both refuse a
    // Confluence-sourced row), so a soft delete here would hide the article
    // where nobody could restore it.
    const staysLocal = await pageWriteStaysLocal(userId, existingPage.source);
    const client = staysLocal ? null : await getClientForUser(userId);
    if (!staysLocal && !client) {
      throw fastify.httpErrors.badRequest('Confluence not configured');
    }

    const deleteIntent = await withPageHierarchyWriteTransaction(async (writeClient) => {
      const current = await loadAuthorizedContentWriteState(
        writeClient,
        existingPage.id,
        userId,
        {
          contentRevision: existingPage.content_revision,
          lifecycleRevision: existingPage.lifecycle_revision,
        },
        true,
      );
      if (
        current.source !== existingPage.source ||
        current.confluenceId !== existingPage.confluence_id
      ) {
        throw new PageWriteError(
          409,
          'page_source_changed',
          'The page source changed before deletion',
        );
      }
      return reservePageWriteIntentInTransaction(writeClient, {
        pageIds: [existingPage.id],
        kind: staysLocal ? 'pages.delete.local' : 'pages.delete.confluence',
        actorId: userId,
        expectedRevisions: {
          [existingPage.id]: {
            contentRevision: existingPage.content_revision,
            lifecycleRevision: existingPage.lifecycle_revision,
          },
        },
        effect: {
          effectClass: staysLocal ? 'local' : 'remote',
          confluenceId: existingPage.confluence_id,
          spaceKey: existingPage.space_key,
          upstreamDelete: !staysLocal,
          attachmentStore: 'confluence',
          iconStore: 'page-icons',
        },
      });
    });

    // Preserve the established local-first ordering, but make it a fenced,
    // durable intermediate step. Any crash or uncertain remote response leaves
    // the row hidden and the intent actionable rather than silently reviving it.
    try {
    await advancePageWriteIntent(deleteIntent, async (writeClient) => {
      const current = await loadAuthorizedContentWriteState(
        writeClient, existingPage.id, userId, deleteIntent.revisions[existingPage.id]!, true,
      );
      if (current.source !== existingPage.source || current.confluenceId !== existingPage.confluence_id) {
        throw new PageWriteError(409, 'page_source_changed', 'The page source changed before deletion');
      }
      await writeClient.query(
        'UPDATE pages SET deleted_at = COALESCE(deleted_at, NOW()) WHERE id = $1',
        [existingPage.id],
      );
    });
    } catch (error) {
      await cancelPageWriteIntentBeforeEffect(deleteIntent);
      throw error;
    }

    let alreadyGone = false;
    if (client) {
      const admittedClient = await withPageWriteTransaction(
        [existingPage.id],
        (writeClient) => loadCurrentConfluenceWriteClient(
          writeClient, deleteIntent, existingPage.id, userId, existingPage.confluence_id!, true,
        ),
        { intent: deleteIntent },
      );
      await runPageWriteIntentEffect(
        deleteIntent,
        {
          kind: 'remote',
          completesRemoteWork: true,
          terminalResult: () => ({
            confluenceId: existingPage.confluence_id,
            outcome: 'deleted',
          }),
        },
        async () => {
        try {
          await admittedClient.deletePage(existingPage.confluence_id!);
        } catch (err) {
          if (err instanceof ConfluenceError && err.statusCode === 404) {
            alreadyGone = true;
            logger.info(
              { pageId: existingPage.id, confluenceId: existingPage.confluence_id },
              'Confluence page already deleted remotely (404) — cleaning up locally',
            );
          } else {
            // The provider may have accepted the delete before the response failed.
            // Keep the intent unresolved for authenticated reconciliation.
            throw err;
          }
        }
        },
      );
    }

    // Commit destruction before touching files. The durable intent records the
    // DELETE ... RETURNING tombstone so settlement can authenticate the now-
    // absent page while a cleanup failure remains recoverable.
    const rowDestroyed = await advancePageWriteIntent(deleteIntent, async (writeClient) => {
      await writeClient.query('DELETE FROM pinned_pages WHERE page_id = $1', [existingPage.id]);
      const destroyed = await writeClient.query<{ id: number }>(
        'DELETE FROM pages WHERE id = $1 RETURNING id',
        [existingPage.id],
      );
      if (client) await enqueuePageWriteInvalidation(writeClient, deleteIntent.id);
      return (destroyed.rowCount ?? 0) > 0;
    });
    if (rowDestroyed) {
      await tombstoneCollabRoomAfterCommit(existingPage.id);
      await runPageWriteIntentEffect(deleteIntent, { kind: 'local' }, async () => {
        if (existingPage.confluence_id) await cleanPageAttachments(existingPage.confluence_id, { strict: true });
        await discardPageIconForDeletedPage({ id: existingPage.id });
      });
    }
    await completePageWriteIntent(deleteIntent, async () => undefined);

    // Confluence pages are visible to every user with space access (#893), and
    // deleting one may also drop its space — clear every user's cache.
    await cache.invalidateAcrossUsers('pages');
    await cache.invalidateAcrossUsers('spaces');

    await logAuditEvent(userId, 'PAGE_DELETED', 'page', String(id),
      // `upstreamDeleted: false` is the audit trail's record that the delete
      // stayed local because the integration is off (#1623).
      { alreadyGoneRemotely: alreadyGone, upstreamDeleted: !staysLocal }, request);

    emitWebhookEvent({
      eventType: 'page.deleted',
      payload: {
        pageId: existingPage.id,
        isHardDelete: true,
      },
    });

    return {
      message: staysLocal
        ? 'Page removed locally. Confluence is disconnected, so the Confluence page was left untouched.'
        : alreadyGone
          ? 'Page was already removed in Confluence — removed locally'
          : 'Page deleted',
    };
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
      visibility: string; space_key: string | null; deleted_at: Date | null;
      content_revision: string; lifecycle_revision: string;
    }>(
      `SELECT id, source, created_by_user_id, visibility, space_key, deleted_at,
              content_revision::text, lifecycle_revision::text
         FROM pages WHERE id = $1 AND deleted_at IS NULL`,
      [pageId],
    );
    if (!existing.rows.length) throw fastify.httpErrors.notFound('Page not found');

    const page = existing.rows[0]!;

    // Access control: Confluence pages require RBAC space access; standalone pages
    // require ownership or shared visibility
    if (page.source === 'confluence') {
      const spaces = await getUserAccessibleSpaces(userId);
      if (!page.space_key || !spaces.includes(page.space_key)) {
        throw fastify.httpErrors.forbidden('Access denied to this space');
      }
    } else if (page.created_by_user_id !== userId && page.visibility !== 'shared') {
      throw fastify.httpErrors.forbidden('Not authorized to edit this page');
    }

    const { htmlToText } = await import('../../core/services/content-converter.js');
    const draftText = htmlToText(body.bodyHtml);

    await withPageWriteTransaction([page.id], async (writeClient) => {
      await loadAuthorizedContentWriteState(writeClient, page.id, userId, {
        contentRevision: page.content_revision,
        lifecycleRevision: page.lifecycle_revision,
      });
      await writeClient.query(
        `UPDATE pages SET draft_body_html = $1, draft_body_text = $2, draft_updated_at = NOW(), draft_updated_by = $3 WHERE id = $4`,
        [body.bodyHtml, draftText, userId, page.id],
      );
    });

    return { id: page.id, hasDraft: true, draftUpdatedAt: new Date().toISOString() };
  });

  // GET /api/pages/:id/draft — get draft content
  fastify.get('/pages/:id/draft', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const userId = request.userId;
    const pageId = parseInt(id, 10);

    const result = await query<{
      id: number; source: string; created_by_user_id: string | null;
      visibility: string; space_key: string | null; draft_body_html: string | null;
      draft_body_text: string | null; draft_updated_at: Date | null;
      draft_updated_by: string | null;
    }>(
      `SELECT id, source, created_by_user_id, visibility, space_key, draft_body_html, draft_body_text, draft_updated_at, draft_updated_by FROM pages WHERE id = $1 AND deleted_at IS NULL`,
      [pageId],
    );
    if (!result.rows.length) throw fastify.httpErrors.notFound('Page not found');

    const row = result.rows[0]!;

    // Access control: Confluence pages require RBAC space access; standalone pages
    // require ownership or shared visibility. Use 404 (no existence oracle) to
    // match GET /pages/:id semantics.
    if (row.source === 'confluence') {
      const spaces = await getUserAccessibleSpaces(userId);
      if (!row.space_key || !spaces.includes(row.space_key)) {
        throw fastify.httpErrors.notFound('Page not found');
      }
    } else if (row.created_by_user_id !== userId && row.visibility !== 'shared') {
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
      content_revision: string; lifecycle_revision: string;
    }>(
      `SELECT id, version, title, body_html, body_text, body_storage, source,
              created_by_user_id, visibility, confluence_id, space_key,
              draft_body_html, draft_body_storage, content_revision::text,
              lifecycle_revision::text
         FROM pages WHERE id = $1 AND deleted_at IS NULL`,
      [pageId],
    );
    if (!existing.rows.length) throw fastify.httpErrors.notFound('Page not found');

    const page = existing.rows[0]!;

    // Access control: Confluence pages require RBAC space access; standalone pages
    // require ownership or shared visibility
    if (page.source === 'confluence') {
      const spaces = await getUserAccessibleSpaces(userId);
      if (!page.space_key || !spaces.includes(page.space_key)) {
        throw fastify.httpErrors.forbidden('Access denied to this space');
      }
    } else if (page.created_by_user_id !== userId && page.visibility !== 'shared') {
      throw fastify.httpErrors.forbidden('Not authorized to publish this page');
    }

    if (!page.draft_body_html) throw fastify.httpErrors.badRequest('No draft to publish');

    await rejectIfLiveCollabRoom(page.id, (m) => fastify.httpErrors.conflict(m));

    const expectedRevision: PageRevision = {
      contentRevision: page.content_revision,
      lifecycleRevision: page.lifecycle_revision,
    };
    let publishedVisibility = page.visibility;
    const publishDraft = async (writeClient: PoolClient): Promise<void> => {
      const current = await loadAuthorizedContentWriteState(writeClient, page.id, userId, expectedRevision);
      await invalidateCollabDocAfterBodyWrite(page.id, writeClient);
      publishedVisibility = current.visibility;
      await writeClient.query(
        `INSERT INTO page_versions (page_id, version_number, title, body_html, body_text, synced_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT DO NOTHING`,
        [page.id, page.version, page.title, page.body_html, page.body_text],
      );
      await writeClient.query(
        `UPDATE pages SET
          body_html = draft_body_html, body_text = draft_body_text,
          body_storage = COALESCE(draft_body_storage, body_storage),
          version = version + 1, embedding_dirty = TRUE,
          image_analysis_dirty = CASE
            WHEN body_html IS DISTINCT FROM draft_body_html THEN TRUE
            ELSE image_analysis_dirty
          END,
          embedding_status = 'not_embedded', embedded_at = NULL,
          last_modified_at = NOW(),
          local_modified_at = NOW(),
          local_modified_by = COALESCE(draft_updated_by, local_modified_by),
          draft_body_html = NULL, draft_body_text = NULL, draft_body_storage = NULL,
          draft_updated_at = NULL, draft_updated_by = NULL
         WHERE id = $1`,
        [page.id],
      );
    };

    const remotePublicationRequired =
      page.confluence_id !== null && !(await pageWriteStaysLocal(userId, page.source));
    let publishIntent: PageWriteIntent | null = null;
    if (remotePublicationRequired) {
      const runtimeId = await getPageWriterRuntimeId();
      const writeClient = await getPool().connect();
      try {
        await writeClient.query('BEGIN');
        await lockPageWriterRuntime(writeClient, runtimeId);
        await lockPageWrites(writeClient, [page.id]);
        await publishDraft(writeClient);
        // The original pair was checked above. Publication and reservation
        // commit together, so this revision comes only from our own SQL write.
        publishIntent = await reservePageWriteIntentInTransaction(writeClient, {
          pageIds: [page.id],
          kind: 'pages.draft.publish.confluence',
          actorId: userId,
          effect: {
            effectClass: 'remote',
            confluenceId: page.confluence_id,
            expectedVersion: page.version,
            targetBodyHtmlSha256: createHash('sha256').update(page.draft_body_html!).digest('hex'),
          },
        });
        await writeClient.query('COMMIT');
      } catch (error) {
        await writeClient.query('ROLLBACK');
        throw error;
      } finally {
        writeClient.release();
      }
    } else {
      await withPageWriteTransaction([page.id], publishDraft);
    }

    // Confluence draft publishing is intentionally local-first. The durable
    // intent commits with publication, remains unresolved through
    // the remote call, and is settled only with the final local mirror.
    let publishedVersion = page.version + 1;
    if (publishIntent && page.confluence_id) {
      const admittedIntent = publishIntent;
      let storageBody: string;
      let admittedClient: ConfluenceClient;
      try {
        storageBody = htmlToConfluence(page.draft_body_html!);
        admittedClient = await withPageWriteTransaction(
          [page.id],
          (writeClient) => loadCurrentConfluenceWriteClient(
            writeClient, admittedIntent, page.id, userId, page.confluence_id!,
          ),
          { intent: admittedIntent },
        );
      } catch (error) {
        // Publication and reservation committed together, but provider I/O has
        // not begun. Keep the authorized local publication as divergence while
        // releasing the unused reservation.
        await cancelPageWriteIntentBeforeEffect(admittedIntent);
        if (page.source === 'confluence' || publishedVisibility === 'shared') {
          await cache.invalidateAcrossUsers('pages');
        } else {
          await cache.invalidate(userId, 'pages');
        }
        throw error;
      }
      const publication = await runPageWriteIntentEffect(
        admittedIntent,
        {
          kind: 'remote',
          completesRemoteWork: true,
          terminalResult: (result) => result.receipt,
        },
        async () => {
          const confPage = await admittedClient.updatePage(
            page.confluence_id!, page.title, storageBody, page.version,
          );
          return {
            confPage,
            receipt: pagePublicationReceipt(page.confluence_id!, page.version + 1, confPage),
          };
        },
      );
      const confPage = await withPageWriteTransaction([page.id], async (writeClient) => {
        const currentClient = await loadCurrentConfluenceWriteClient(
          writeClient, admittedIntent, page.id, userId, page.confluence_id!,
        );
        return confirmPagePublication(currentClient, publication.receipt, publication.confPage);
      }, { intent: admittedIntent });
      publishedVersion = confPage.version.number;
      await completePageWriteIntent(admittedIntent, async (writeClient) => {
        await loadAuthorizedContentWriteState(
          writeClient, page.id, userId, admittedIntent.revisions[page.id]!,
        );
        await writeClient.query(
          `UPDATE pages SET body_storage = $2, version = $3, last_synced = NOW(),
             local_modified_at = NULL, local_modified_by = NULL
           WHERE id = $1`,
          [page.id, confPage.body.storage.value, publishedVersion],
        );
        await enqueuePageWriteInvalidation(writeClient, admittedIntent.id);
      });
    }

    // Publishing a draft rewrites the live content — the same mutation class
    // as PUT /pages/:id (#893): Confluence/shared pages are visible to other
    // users, so their cached lists/trees must be cleared for everyone.
    if (page.source === 'confluence' || publishedVisibility === 'shared') {
      await cache.invalidateAcrossUsers('pages');
    } else {
      await cache.invalidate(userId, 'pages');
    }
    await logAuditEvent(userId, 'DRAFT_PUBLISHED', 'page', String(page.id),
      { version: publishedVersion }, request);

    emitWebhookEvent({
      eventType: 'page.updated',
      payload: {
        pageId: page.id,
        title: page.title,
        spaceKey: page.space_key,
        updatedAt: new Date().toISOString(),
      },
    });

    return { id: page.id, version: publishedVersion, published: true };
  });

  // DELETE /api/pages/:id/draft — discard draft
  fastify.delete('/pages/:id/draft', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const userId = request.userId;
    const pageId = parseInt(id, 10);

    const existing = await query<{
      id: number; source: string; created_by_user_id: string | null;
      visibility: string; space_key: string | null;
      content_revision: string; lifecycle_revision: string;
    }>(
      `SELECT id, source, created_by_user_id, visibility, space_key,
              content_revision::text, lifecycle_revision::text
         FROM pages WHERE id = $1 AND deleted_at IS NULL`,
      [pageId],
    );
    if (!existing.rows.length) throw fastify.httpErrors.notFound('Page not found');

    const page = existing.rows[0]!;

    // Access control: Confluence pages require RBAC space access; standalone pages
    // require ownership or shared visibility
    if (page.source === 'confluence') {
      const spaces = await getUserAccessibleSpaces(userId);
      if (!page.space_key || !spaces.includes(page.space_key)) {
        throw fastify.httpErrors.forbidden('Access denied to this space');
      }
    } else if (page.created_by_user_id !== userId && page.visibility !== 'shared') {
      throw fastify.httpErrors.forbidden('Not authorized to discard this draft');
    }

    await withPageWriteTransaction([page.id], async (writeClient) => {
      await loadAuthorizedContentWriteState(writeClient, page.id, userId, {
        contentRevision: page.content_revision,
        lifecycleRevision: page.lifecycle_revision,
      });
      await writeClient.query(
        `UPDATE pages SET draft_body_html = NULL, draft_body_text = NULL, draft_body_storage = NULL, draft_updated_at = NULL, draft_updated_by = NULL WHERE id = $1`,
        [page.id],
      );
    });

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

    const { errors, failed: resolutionFailed } = bulkResolutionFailures(resolved);
    let failed = resolutionFailed;

    // --- Partition by source ---
    // #861: standalone delete is owner-only, mirroring DELETE /pages/:id.
    // Shared standalone pages resolve for every viewer (read/edit is allowed),
    // but only the owner may trash them. Non-owned standalone rows are reported
    // as failures exactly like the single-delete 403 ('not the owner').
    for (const r of resolved.rows) {
      if (r.source === 'standalone' && r.createdByUserId !== userId) {
        failed++;
        errors.push(`Page ${r.id}: not the owner`);
      }
    }
    const standalonePages = resolved.rows
      .filter((r) => r.source === 'standalone' && r.createdByUserId === userId)
      .map((r) => ({ id: r.id, source: 'standalone', confluence_id: r.confluenceId, space_key: r.spaceKey }));
    const confluencePages = resolved.rows.filter((r) => r.source !== 'standalone')
      .map((r) => ({
        id: r.id, source: r.source, confluence_id: r.confluenceId, space_key: r.spaceKey,
        contentRevision: r.contentRevision, lifecycleRevision: r.lifecycleRevision,
      }));

    // Expand and coalesce under one hierarchy-exclusive transaction. A
    // selected descendant of another selected root belongs to the same
    // component, so a frozen member refuses that component once; disjoint
    // components continue independently.
    const standaloneNumericIds = standalonePages.map((row) => row.id);
    let standaloneSucceeded = 0;
    if (standaloneNumericIds.length > 0) {
      const cascadeResult = await withHierarchyCascadeTransaction(async (client) => {
        const components = await authorizedSubtreeComponents(
          client,
          standaloneNumericIds,
          userId,
          false,
        );
        await lockPageLifecycle(
          client,
          [...new Set(components.flatMap((component) =>
            component.members.map((member) => member.id)))].sort((left, right) => left - right),
        );
        const affectedIds: number[] = [];
        let succeededRoots = 0;
        let failedRoots = 0;
        const componentErrors: string[] = [];

        for (const component of components) {
          const memberIds = component.members.map((member) => member.id);
          const memberIdSet = new Set(memberIds);
          const rootAuthorityChanged = component.rootIds.some((rootId) => !memberIdSet.has(rootId));
          if (rootAuthorityChanged) {
            failedRoots += component.rootIds.length;
            componentErrors.push(
              `${component.rootIds.length} selected page(s): the authorized subtree changed before deletion`,
            );
            continue;
          }

          const ambiguity = await findSubtreeKeyAmbiguity(component.rootIds, client);
          if (ambiguity) {
            ambiguousSubtreeConflict(ambiguity, fastify.log);
            failedRoots += component.rootIds.length;
            componentErrors.push(
              `${component.rootIds.length} selected page(s): the subtree parent identifiers are ambiguous`,
            );
            continue;
          }

          // Lifecycle locks for every authorized component were taken above in
          // global id order while the hierarchy fence remained exclusive.
          const frozenCount = component.members
            .filter((member) => member.baselineId !== null)
            .length;
          if (frozenCount > 0) {
            const refusal = new PageSubtreeFrozenError(frozenCount);
            failedRoots += component.rootIds.length;
            componentErrors.push(
              `${component.rootIds.length} selected page(s): ${refusal.message} ` +
              `Frozen page count: ${refusal.blockedCount}.`,
            );
            continue;
          }

          try {
            await lockPageWrites(client, memberIds);
          } catch (error) {
            if (!(error instanceof PageWriteError)) throw error;
            failedRoots += component.rootIds.length;
            componentErrors.push(
              `${component.rootIds.length} selected page(s): the subtree is busy and was not changed`,
            );
            continue;
          }

          const result = await client.query<{ id: number }>(
            `UPDATE pages
                SET deleted_at = NOW()
              WHERE id = ANY($1::int[])
                AND deleted_at IS NULL
                AND source = 'standalone'
                AND created_by_user_id = $2
              RETURNING id`,
            [memberIds, userId],
          );
          if (result.rows.length !== memberIds.length) {
            throw new PageWriteError(
              409,
              'subtree_changed',
              'An authorized subtree changed during bulk deletion',
            );
          }
          await client.query(
            'DELETE FROM pinned_pages WHERE user_id = $1 AND page_id = ANY($2::int[])',
            [userId, memberIds],
          );
          affectedIds.push(...result.rows.map((row) => row.id));
          succeededRoots += component.rootIds.length;
        }
        return { affectedIds, succeededRoots, failedRoots, componentErrors };
      });

      standaloneSucceeded = cascadeResult.succeededRoots;
      failed += cascadeResult.failedRoots;
      errors.push(...cascadeResult.componentErrors);
      const sideEffects = await Promise.allSettled(
        cascadeResult.affectedIds.map(async (pageId) => {
          await tombstoneCollabRoomAfterCommit(pageId);
          emitWebhookEvent({
            eventType: 'page.deleted',
            payload: { pageId, isHardDelete: false },
          });
        }),
      );
      for (const outcome of sideEffects) {
        if (outcome.status === 'rejected') {
          fastify.log.warn(
            { err: outcome.reason },
            'pages: a bulk page.deleted side effect failed after the trash had committed',
          );
        }
      }
    }

    // A Confluence-row delete is a local-first distributed write. Each row gets
    // its own durable intent so partial bulk outcomes remain independently
    // reconcilable and an uncertain provider response is never treated as a
    // definite failure that may be rolled back.
    const bulkLimit = pLimit(5);
    let confluenceSucceeded = 0;
    if (confluencePages.length > 0) {
      const staysLocal = await pageWriteStaysLocal(userId, 'confluence');
      const client = staysLocal ? null : await getClientForUser(userId);
      if (!staysLocal && !client) {
        confluencePages.forEach((page) => {
          failed++;
          errors.push(`Page ${page.confluence_id ?? page.id}: Confluence not configured`);
        });
      } else {
        const deletionResults = await Promise.allSettled(
          confluencePages.map((page) =>
            bulkLimit(async () => {
              const deleteIntent = await reservePageWriteIntent({
                pageIds: [page.id],
                kind: client === null ? 'pages.bulk.delete.local' : 'pages.bulk.delete.remote',
                actorId: userId,
                expectedRevisions: {
                  [page.id]: {
                    contentRevision: page.contentRevision,
                    lifecycleRevision: page.lifecycleRevision,
                  },
                },
                effect: {
                  effectClass: client === null ? 'local' : 'remote',
                  confluenceId: page.confluence_id,
                  spaceKey: page.space_key,
                  upstreamDelete: client !== null,
                  attachmentStore: 'confluence',
                  iconStore: 'page-icons',
                },
              });
              try {
                await advancePageWriteIntent(deleteIntent, async (writeClient) => {
                  const current = await loadAuthorizedContentWriteState(
                    writeClient, page.id, userId, deleteIntent.revisions[page.id]!,
                  );
                  if (current.source !== page.source || current.confluenceId !== page.confluence_id ||
                    current.spaceKey !== page.space_key) {
                    throw new PageWriteError(409, 'page_source_changed', 'The page source changed before deletion');
                  }
                  await writeClient.query(
                    'UPDATE pages SET deleted_at = COALESCE(deleted_at, NOW()) WHERE id = $1',
                    [page.id],
                  );
                });
              } catch (error) {
                await cancelPageWriteIntentBeforeEffect(deleteIntent);
                throw error;
              }
              if (client) {
                const admittedClient = await withPageWriteTransaction(
                  [page.id],
                  (writeClient) => loadCurrentConfluenceWriteClient(
                    writeClient, deleteIntent, page.id, userId, page.confluence_id!, true,
                  ),
                  { intent: deleteIntent },
                );
                await runPageWriteIntentEffect(
                  deleteIntent,
                  {
                    kind: 'remote',
                    completesRemoteWork: true,
                    terminalResult: () => ({
                      confluenceId: page.confluence_id,
                      outcome: 'deleted',
                    }),
                  },
                  async () => {
                  try {
                    await admittedClient.deletePage(page.confluence_id!);
                  } catch (err) {
                    if (!(err instanceof ConfluenceError && err.statusCode === 404)) {
                      throw err;
                    }
                    logger.info(
                      { pageId: page.id, confluenceId: page.confluence_id },
                      'Confluence page already deleted remotely (404) — cleaning up locally',
                    );
                  }
                  },
                );
              }
              const rowDestroyed = await advancePageWriteIntent(
                deleteIntent,
                async (writeClient) => {
                  await writeClient.query('DELETE FROM pinned_pages WHERE page_id = $1', [page.id]);
                  const destroyed = await writeClient.query<{ id: number }>(
                    'DELETE FROM pages WHERE id = $1 RETURNING id',
                    [page.id],
                  );
                  await enqueuePageWriteInvalidation(writeClient, deleteIntent.id);
                  return (destroyed.rowCount ?? 0) > 0;
                },
              );
              if (rowDestroyed) {
                await tombstoneCollabRoomAfterCommit(page.id);
                await runPageWriteIntentEffect(deleteIntent, { kind: 'local' }, async () => {
                  if (page.confluence_id) await cleanPageAttachments(page.confluence_id, { strict: true });
                  await discardPageIconForDeletedPage({ id: page.id });
                });
              }
              await completePageWriteIntent(deleteIntent, async () => undefined);
            }),
          ),
        );
        for (let index = 0; index < deletionResults.length; index++) {
          const outcome = deletionResults[index]!;
          const page = confluencePages[index]!;
          if (outcome.status === 'fulfilled') {
            confluenceSucceeded++;
          } else {
            failed++;
            errors.push(
              `Page ${page.confluence_id ?? page.id}: ${
                outcome.reason instanceof Error ? outcome.reason.message : 'Unknown error'
              }`,
            );
          }
        }
      }
    }

    const succeeded = standaloneSucceeded + confluenceSucceeded;
    // A bulk delete may include Confluence/shared pages visible to every user
    // (#893), so clear all users' cached lists/trees/spaces unconditionally.
    await cache.invalidateAcrossUsers('pages');
    await cache.invalidateAcrossUsers('spaces');
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

    // #1623 — a re-sync is Confluence work with no local equivalent: it pulls
    // upstream content. With the integration off it refuses by naming the
    // integration, never by asking for credentials that are still on file.
    if (!(await isConfluenceEnabled(userId))) {
      throw fastify.httpErrors.badRequest(CONFLUENCE_DISABLED_MESSAGE);
    }

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
    const numericIdsByConfluenceId = new Map(
      syncableRows.map((row) => [row.confluenceId as string, row.id]),
    );
    const { errors, failed: resolutionFailed } = bulkResolutionFailures(resolved);
    let failed = resolutionFailed;


    // Fetch latest from Confluence in parallel with concurrency control
    const bulkLimit = pLimit(5);
    const syncResults = await Promise.allSettled(
      [...ownedIds].map((id) =>
        bulkLimit(async () => {
          const numericPageId = numericIdsByConfluenceId.get(id);
          if (numericPageId === undefined) throw new Error(`Missing local page identity for ${id}`);
          const observed = await withPageWriteTransaction([numericPageId], async (writeClient) => {
            const state = await loadAuthorizedContentWriteState(writeClient, numericPageId, userId, null);
            if (state.source !== 'confluence' || state.confluenceId !== id) {
              throw new PageWriteError(409, 'page_source_changed', 'The page source changed before synchronization');
            }
            return state;
          });

          // GET and conversion change no protected bytes. Keep them outside the
          // transaction; a failed read must not leave a durable mutation intent.
          const page = await client.getPage(id);
          const bodyHtml = confluenceToHtml(page.body?.storage?.value ?? '', id, observed.spaceKey ?? undefined);
          const bodyText = htmlToText(bodyHtml);

          await withPageWriteTransaction([numericPageId], async (writeClient) => {
            await loadAuthorizedContentWriteState(writeClient, numericPageId, userId, observed);
            await writeClient.query(
              `UPDATE pages SET
                 title = $2, body_storage = $3, body_html = $4, body_text = $5,
                 version = $6, last_synced = NOW(), embedding_dirty = TRUE,
                 image_analysis_dirty = CASE
                   WHEN body_html IS DISTINCT FROM $4 THEN TRUE
                   ELSE image_analysis_dirty
                 END,
                 embedding_status = 'not_embedded', embedded_at = NULL,
                 local_modified_at = NULL, local_modified_by = NULL
               WHERE id = $1`,
              [numericPageId, page.title, page.body?.storage?.value ?? '', bodyHtml, bodyText, page.version.number],
            );
          });
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
    // #1116 r9: bounded but real — after a swap these rows carry no
    // `embedding_prev`, so a rollback re-dirties exactly these pages and
    // search loses them until the pipeline catches up. Only the post-swap
    // window is refused; during the backfill embedPage dual-writes.
    await assertShadowRollbackWindowClear();
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

    const { errors, failed } = bulkResolutionFailures(resolved);

    // Fire-and-forget: trigger processing of dirty pages (same pattern as POST /embeddings/process)
    if (succeeded > 0) {
      processDirtyPages(userId).catch((err) => {
        logger.error({ err, userId }, 'Bulk embed: embedding processing failed');
      });
    }

    return { succeeded, failed, errors };
  });

  // POST /api/pages/bulk/quality - re-queue multiple pages for quality re-analysis.
  // Resets quality_status to 'pending' (clearing prior score/error/retry) so the
  // background quality worker picks them up on its next batch. Fires the worker
  // immediately so the user doesn't wait for the next interval tick. Quality
  // analysis applies to both Confluence-sourced and standalone pages (the worker
  // gates on body_text length, not source).
  fastify.post('/pages/bulk/quality', async (request, reply) => {
    const parsed = BulkIdsOrFilterSchema.parse(request.body);
    const userId = request.userId;

    const qualitySpaces = await getUserAccessibleSpaces(userId);
    const selection: BulkSelection = {
      ids: parsed.ids,
      filter: parsed.filter,
      expectedCount: parsed.expectedCount,
      driftToleranceFraction: parsed.driftToleranceFraction,
    };

    let resolved;
    try {
      resolved = await resolveBulkSelection(userId, selection, qualitySpaces);
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

    const eligibleIds = resolved.rows.map((r) => r.id);
    let succeeded = 0;
    if (eligibleIds.length > 0) {
      const result = await query(
        `UPDATE pages
            SET quality_status = 'pending',
                quality_score = NULL,
                quality_error = NULL,
                quality_retry_count = 0
          WHERE id = ANY($1::int[]) AND deleted_at IS NULL`,
        [eligibleIds],
      );
      succeeded = result.rowCount ?? 0;
    }

    const { errors, failed } = bulkResolutionFailures(resolved);

    await cache.invalidate(userId, 'pages');

    // Fire-and-forget: kick the worker so the user sees results without waiting
    // for the next interval tick. triggerQualityBatch is lock-guarded and no-ops
    // if a batch is already running.
    if (succeeded > 0) {
      triggerQualityBatch().catch((err) => {
        logger.error({ err, userId }, 'Bulk quality: worker trigger failed');
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

    const confluenceEnabled = await isConfluenceEnabled(userId);
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
      resolved.rows.map((row) => [String(row.id), row]),
    );
    const { errors, failed: resolutionFailed } = bulkResolutionFailures(resolved);
    let failed = resolutionFailed;
    // Remote-backed rows commit local labels only after fresh admission and a
    // terminal provider response. Standalone-mode rows still commit directly.
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

          const numericPageId = parseInt(id, 10);
          if (confluenceEnabled && pageInfo.source === 'confluence' && pageInfo.confluenceId) {
            const targetLabelsSha256 = createHash('sha256')
              .update(JSON.stringify(labels))
              .digest('hex');
            const tagIntent = await reservePageWriteIntent({
              pageIds: [numericPageId],
              expectedRevisions: {
                [numericPageId]: {
                  contentRevision: pageInfo.contentRevision,
                  lifecycleRevision: pageInfo.lifecycleRevision,
                },
              },
              kind: 'pages.bulk.tags',
              actorId: userId,
              effect: {
                priorLabels: pageInfo.labels,
                effectClass: 'remote',
                confluenceId: pageInfo.confluenceId,
                targetLabelsSha256,
                targetLabels: labels,
              },
            });
            let admittedClient: ConfluenceClient;
            try {
              admittedClient = await withPageWriteTransaction(
                [numericPageId],
                (writeClient) => loadCurrentConfluenceWriteClient(
                  writeClient, tagIntent, numericPageId, userId, pageInfo.confluenceId!,
                ),
                { intent: tagIntent },
              );
            } catch (error) {
              await cancelPageWriteIntentBeforeEffect(tagIntent);
              throw error;
            }
            await runPageWriteIntentEffect(
              tagIntent,
              { kind: 'remote', completesRemoteWork: true },
              async () => {
                if (addTags.length > 0) {
                  await admittedClient.addLabels(pageInfo.confluenceId!, addTags);
                }
                for (const label of removeTags) {
                  await admittedClient.removeLabel(pageInfo.confluenceId!, label);
                }
              },
            );
            await completePageWriteIntent(tagIntent, async (writeClient) => {
              await loadAuthorizedContentWriteState(
                writeClient, numericPageId, userId, tagIntent.revisions[numericPageId]!,
              );
              await writeClient.query('UPDATE pages SET labels = $2 WHERE id = $1', [
                numericPageId,
                labels,
              ]);
              await enqueuePageWriteInvalidation(writeClient, tagIntent.id);
            });
          } else {
            await withPageWriteTransaction([numericPageId], async (writeClient) => {
              await loadAuthorizedContentWriteState(writeClient, numericPageId, userId, {
                contentRevision: pageInfo.contentRevision,
                lifecycleRevision: pageInfo.lifecycleRevision,
              });
              await writeClient.query('UPDATE pages SET labels = $2 WHERE id = $1', [numericPageId, labels]);
            });
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

    const { errors, failed: initialFailed } = bulkResolutionFailures(resolved);
    const eligible = resolved.rows;

    if (jobId) {
      await startBulkJob(jobId, eligible.length, userId, 'replace-tags');
    }

    const confluenceEnabled = await isConfluenceEnabled(userId);
    const bulkLimit = pLimit(5);

    const result = await runBulkInChunks(eligible, 100, jobId ?? null, async (chunk) => {
      let chunkSucceeded = 0;
      let chunkFailed = 0;
      const chunkErrors: string[] = [];

      const settled = await Promise.allSettled(
        chunk.map((page) =>
          bulkLimit(async () => {
            if (confluenceEnabled && page.source === 'confluence' && page.confluenceId) {
              const oldSet = new Set(page.labels);
              const newSet = new Set(normTags);
              const toAdd = normTags.filter((tag) => !oldSet.has(tag));
              const toRemove = page.labels.filter((tag) => !newSet.has(tag));
              const tagIntent = await reservePageWriteIntent({
                pageIds: [page.id],
                expectedRevisions: {
                  [page.id]: {
                    contentRevision: page.contentRevision,
                    lifecycleRevision: page.lifecycleRevision,
                  },
                },
                kind: 'pages.bulk.replace_tags',
                actorId: userId,
                effect: {
                  effectClass: 'remote',
                  confluenceId: page.confluenceId,
                  targetLabelsSha256: createHash('sha256')
                    .update(JSON.stringify(normTags))
                    .digest('hex'),
                  priorLabels: page.labels,
                  targetLabels: normTags,
                },
              });
              let admittedClient: ConfluenceClient;
              try {
                admittedClient = await withPageWriteTransaction(
                  [page.id],
                  (writeClient) => loadCurrentConfluenceWriteClient(
                    writeClient, tagIntent, page.id, userId, page.confluenceId!,
                  ),
                  { intent: tagIntent },
                );
              } catch (error) {
                await cancelPageWriteIntentBeforeEffect(tagIntent);
                throw error;
              }
              await runPageWriteIntentEffect(
                tagIntent,
                { kind: 'remote', completesRemoteWork: true },
                async () => {
                  if (toAdd.length > 0) await admittedClient.addLabels(page.confluenceId!, toAdd);
                  for (const label of toRemove) {
                    await admittedClient.removeLabel(page.confluenceId!, label);
                  }
                },
              );
              await completePageWriteIntent(tagIntent, async (writeClient) => {
                await loadAuthorizedContentWriteState(
                  writeClient, page.id, userId, tagIntent.revisions[page.id]!,
                );
                await writeClient.query(
                  'UPDATE pages SET labels = $2 WHERE id = $1',
                  [page.id, normTags],
                );
                await enqueuePageWriteInvalidation(writeClient, tagIntent.id);
              });
            } else {
              await withPageWriteTransaction([page.id], async (writeClient) => {
                await loadAuthorizedContentWriteState(writeClient, page.id, userId, {
                  contentRevision: page.contentRevision,
                  lifecycleRevision: page.lifecycleRevision,
                });
                await writeClient.query('UPDATE pages SET labels = $2 WHERE id = $1', [page.id, normTags]);
              });
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
    const pageResult = await query<ImageUploadPage>(
      `SELECT p.id, p.source, p.confluence_id, p.created_by_user_id,
              p.space_key, p.visibility, p.content_revision::text,
              p.lifecycle_revision::text
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

    if (!(await userCanUploadPageImage(userId, page))) {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: page.source === 'standalone' || page.space_key
          ? 'Not authorized to upload images to this page'
          : 'Access denied',
      });
    }

    const attachmentPageId = imageAttachmentPageKey(page);
    const uploadForbiddenMessage = page.source === 'standalone' || page.space_key
      ? 'Not authorized to upload images to this page'
      : 'Access denied';
    try {
      await writePageImageCache({
        page, userId, filename, bytes: imageBuffer,
        kind: 'pages.image.upload', forbiddenMessage: uploadForbiddenMessage,
      });

      const url = `/api/attachments/${encodeURIComponent(attachmentPageId)}/${encodeURIComponent(filename)}`;
      logger.info({ userId, pageId: id, attachmentPageId, filename, size: imageBuffer.length }, 'Image uploaded via paste/drop');
      return { url };
    } catch (err) {
      if (err instanceof PageWriteError) throw err;
      logger.error({ err, userId, pageId: id, filename }, 'Failed to save pasted image');
      throw fastify.httpErrors.internalServerError('Failed to save image');
    }
  });

  // POST /api/pages/:id/images/import — server-side fetch an external image
  // URL and store it as a page attachment, returning the internal URL.
  //
  // Companion to the upload-on-paste flow (#683): when a user pastes HTML
  // containing `<img src="https://...">`, the frontend can't fetch the bytes
  // itself (CORS, no auth). This route is server-side and SSRF-guarded.
  //
  // Scope:
  //  - Accepts `http(s)://` URLs only (enforced by `assertNonSsrfUrl`).
  //  - Blocks private/loopback/link-local IPs and DNS rebinding.
  //  - Re-validates every redirect hop (no SSRF-via-Location bypass).
  //  - Streams the body with a mid-flight size cap (defends against lying
  //    Content-Length) at 10 MB.
  //  - Validates `Content-Type: image/*` AND matches it against the body's
  //    magic bytes (no serving HTML/JS masquerading as image/png).
  //  - Stores through the same recoverable image cache writer as inline upload.
  fastify.post('/pages/:id/images/import', async (request, reply) => {
    const { id } = IdParamSchema.parse(request.params);
    const userId = request.userId;

    const parseResult = ImportImageSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: parseResult.error.issues[0]?.message ?? 'Invalid request body',
      });
    }
    const { url: sourceUrl } = parseResult.data;

    // SSRF guard. `assertNonSsrfUrl` enforces protocol = http(s),
    // blocks private/loopback/link-local IPs, blocks RFC 1918 / IPv6
    // private ranges, and resolves DNS to mitigate rebinding. The
    // redirect-following helper re-validates every subsequent hop.
    try {
      await assertNonSsrfUrl(sourceUrl);
    } catch (err) {
      if (err instanceof SsrfError) {
        logger.warn({ userId, pageId: id, sourceUrl, reason: err.message }, 'Image import blocked by SSRF guard');
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Source URL is not reachable or not allowed',
        });
      }
      throw err;
    }

    // Verify the page exists and the user has access. Mirrors the inline
    // upload route's logic exactly so the two stay aligned.
    const isNumericId = /^\d+$/.test(id);
    const pageResult = await query<ImageUploadPage>(
      `SELECT p.id, p.source, p.confluence_id, p.created_by_user_id,
              p.space_key, p.visibility, p.content_revision::text,
              p.lifecycle_revision::text
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
    if (!(await userCanUploadPageImage(userId, page))) {
      return reply.status(403).send({
        statusCode: 403,
        error: 'Forbidden',
        message: page.source === 'standalone' || page.space_key
          ? 'Not authorized to import images to this page'
          : 'Access denied',
      });
    }

    const attachmentPageId = imageAttachmentPageKey(page);
    const importForbiddenMessage = page.source === 'standalone' || page.space_key
      ? 'Not authorized to import images to this page'
      : 'Access denied';
    // Fetching is read-only: retain the authorized original revision pair,
    // not a durable mutation intent that could strand the page on a crash.
    const admittedPage = await withPageWriteTransaction([page.id], (writeClient) =>
      loadAuthorizedImagePage(writeClient, page.id, userId, attachmentPageId, importForbiddenMessage),
    );
    let response: Response;
    try {
      response = await safeFetchWithSsrfGuardedRedirects(sourceUrl);
    } catch (err) {
      if (err instanceof SsrfError) {
        logger.warn({ userId, pageId: id, sourceUrl, reason: err.message }, 'Image import redirect blocked by SSRF guard');
        return reply.status(400).send({
          statusCode: 400,
          error: 'Bad Request',
          message: 'Source URL redirects to a disallowed destination',
        });
      }
      logger.warn({ err, userId, pageId: id, sourceUrl }, 'Image import fetch failed');
      return reply.status(502).send({
        statusCode: 502,
        error: 'Bad Gateway',
        message: 'Failed to fetch source URL',
      });
    }

    if (!response.ok) {
      return reply.status(502).send({
        statusCode: 502,
        error: 'Bad Gateway',
        message: `Source responded with HTTP ${response.status}`,
      });
    }

    // Content-Type must be in the allowlist. We do NOT trust this completely
    // — the magic-byte check below is the real validator — but it's a cheap
    // first gate that avoids streaming non-image responses.
    const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!contentType.startsWith('image/')) {
      return reply.status(415).send({
        statusCode: 415,
        error: 'Unsupported Media Type',
        message: `Source must be an image (got Content-Type: ${contentType || 'unknown'})`,
      });
    }
    if (!ALLOWED_IMAGE_MIMES.has(contentType)) {
      return reply.status(415).send({
        statusCode: 415,
        error: 'Unsupported Media Type',
        message: `Image type not supported: ${contentType}. Allowed: png, jpg, gif, webp`,
      });
    }

    // Defends against upstreams that lie about Content-Length: read the body
    // chunk-by-chunk and abort once we cross the cap, rather than buffering
    // everything before checking.
    const declaredLength = Number(response.headers.get('content-length') ?? 0);
    if (declaredLength > MAX_IMPORT_BYTES) {
      return reply.status(413).send({
        statusCode: 413,
        error: 'Payload Too Large',
        message: `Source image exceeds maximum size of ${MAX_IMPORT_BYTES / (1024 * 1024)} MB`,
      });
    }
    const readResult = await readBodyWithSizeCap(response);
    if (!readResult.ok) {
      if (readResult.reason === 'too-large') {
        return reply.status(413).send({
          statusCode: 413,
          error: 'Payload Too Large',
          message: `Source image exceeds maximum size of ${MAX_IMPORT_BYTES / (1024 * 1024)} MB`,
        });
      }
      logger.warn({ userId, pageId: id, sourceUrl }, 'Image import body read failed');
      return reply.status(502).send({
        statusCode: 502,
        error: 'Bad Gateway',
        message: 'Failed to read source image body',
      });
    }
    const imageBuffer = readResult.buffer;
    if (imageBuffer.length === 0) {
      return reply.status(502).send({
        statusCode: 502,
        error: 'Bad Gateway',
        message: 'Source returned an empty body',
      });
    }

    // Magic-byte check: the bytes must match what the upstream said the
    // Content-Type is. Defends against upstreams returning arbitrary bytes
    // labelled as image/png (the most common "store-and-serve" abuse path).
    if (!bufferMatchesMime(imageBuffer, contentType)) {
      logger.warn(
        { userId, pageId: id, sourceUrl, declaredContentType: contentType },
        'Image import rejected: body does not match declared Content-Type',
      );
      return reply.status(415).send({
        statusCode: 415,
        error: 'Unsupported Media Type',
        message: `Source body does not match declared Content-Type (${contentType})`,
      });
    }

    // Derive a filename from the URL's path, falling back to a generated
    // name if the URL doesn't yield a usable one. Sanitise to the same
    // character class the inline-upload Zod schema enforces.
    const filename = pickImportFilename(sourceUrl, contentType);

    try {
      await writePageImageCache({
        page: admittedPage, userId, filename, bytes: imageBuffer,
        kind: 'pages.image.import.store', forbiddenMessage: importForbiddenMessage,
      });
      const internalUrl = `/api/attachments/${encodeURIComponent(attachmentPageId)}/${encodeURIComponent(filename)}`;
      logger.info({ userId, pageId: id, attachmentPageId, filename, size: imageBuffer.length, sourceUrl }, 'Image imported from URL');
      return { url: internalUrl };
    } catch (err) {
      if (err instanceof PageWriteError) throw err;
      logger.error({ err, userId, pageId: id, filename }, 'Failed to save imported image');
      throw fastify.httpErrors.internalServerError('Failed to save imported image');
    }
  });
}
