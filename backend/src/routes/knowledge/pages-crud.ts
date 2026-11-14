import type { FastifyInstance, FastifyReply } from 'fastify';
import type { PoolClient } from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { query, getPool } from '../../core/db/postgres.js';
import { withEmbeddingDraftContinuity } from '../../core/services/embedding-draft-continuity.js';
import { observeIngestionAdmission, publishIngestionPolicyOnClient } from '../../core/services/ai-policy-deferred-ingestion.js';
import { admitAutomaticIngestionPolicy } from '../../core/services/ai-policy-ingestion.js';
import { getFtsLanguage } from '../../core/services/fts-language.js';
import { RedisCache } from '../../core/services/redis-cache.js';
import { isConfluenceEnabled } from '../../core/services/confluence-integration.js';
import {
  decideConflictPolicyOnClient,
  getClientForUser,
  reconcileCollabAfterInboundBodyWrite,
  recordConflictPolicyAudit,
  type ConflictPolicyRow,
} from '../../domains/confluence/services/sync-service.js';
import {
  CONFLUENCE_DISABLED_MESSAGE,
  pageWriteStaysLocal,
} from '../../domains/confluence/services/standalone-mode.js';
import {
  assignTaskIds,
  confluenceToHtml,
  hasOnlyUncarriedTasks,
  htmlToConfluence,
  htmlToText,
} from '../../core/services/content-converter.js';
import { materializeDrawioPreviews } from '../../core/services/drawio-previews.js';
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
import {
  getUserAccessibleSpaces,
  userCanAccessPage,
} from '../../core/services/rbac-service.js';
import { visiblePagesPredicate } from '../../core/services/page-visibility.js';
import { pageAiPolicyRoutes } from './page-ai-policy.js';
import { toPageIcon } from '../../core/services/page-icon.js';
import { PageListQuerySchema, PageTreeQuerySchema, CreatePageSchema, UpdatePageSchema, SaveDraftSchema, TrashListResponseSchema, RestorePageBodySchema, PagePrimaryKeySchema, type PageLifecycleState } from '@compendiq/contracts';
import { z } from 'zod';
import { logger } from '../../core/utils/logger.js';
import pLimit from 'p-limit';
import { ConfluenceError, type ConfluenceClient } from '../../domains/confluence/services/confluence-client.js';
import {
  confirmPagePublication,
  pagePublicationReceipt,
  publishCreatedConfluencePage,
  sameLabelSet,
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
  AiPolicyRefusalError,
  aiPolicyRefusalFromResult,
  applyAiPolicyOnClient,
  applyPageLabelsOnClient,
  applyCanonicalAiPolicyLabel,
  assertLabelPolicyChangeOnClient,
  canChoosePolicyAtCreation,
  canMutateAiPolicy,
  isAiPolicy,
  isAiPolicyEnforcementAvailable,
  isAiPolicyRefusal,
  lockAiPolicyForPages,
  planLabelPolicyChange,
  policyFromLabels,
  resolveCreationAiPolicy,
  type AiPolicy,
  type AiPolicyChangeRecord,
  type LabelPolicyPlan,
} from '../../core/services/ai-policy-service.js';
import { aiPolicyLabelConflict, deriveAiPolicyWorkerFields, isAiPolicyUpdatePaired } from '@compendiq/contracts';
import { sendAiPolicyRefusal } from './page-ai-policy.js';
import { publishBulkPolicyLabels } from './bulk-policy-labels.js';
import { reservePolicyLabelSynchronization, synchronizePolicyLabels, type PolicyLabelWrite } from './policy-label-synchronization.js';

/**
 * Apply an explicit `aiPolicy` from a content update on the SAME held
 * transaction as the content write (#280). The caller must have taken the
 * AI-policy advisory lock (`lockAiPolicyForPages`) before its row lock.
 * Failures are the frozen contract bodies (`AiPolicyRefusalError`), answered
 * by the route through `sendAiPolicyRefusal`; returns the deferred events
 * the caller emits after COMMIT.
 */
async function applyRequestedAiPolicyOnClient(
  writeClient: PoolClient,
  input: { userId: string; pageId: number; aiPolicy: AiPolicy; expectedRevision: number },
): Promise<AiPolicyChangeRecord[]> {
  if (input.aiPolicy !== 'all' && !isAiPolicyEnforcementAvailable()) {
    throw aiPolicyRefusalFromResult({ reason: 'enforcement_unavailable', pageIds: [input.pageId] });
  }
  const applied = await applyAiPolicyOnClient(writeClient, {
    userId: input.userId,
    items: [{ pageId: input.pageId, policy: input.aiPolicy, expectedRevision: input.expectedRevision }],
    requireAuthority: true,
  });
  if (applied.ok) return applied.changes;
  throw aiPolicyRefusalFromResult(applied);
}

/**
 * Policy refusals raised inside a page route keep their frozen bodies: the
 * generic `PageWriteError` serializer answers `{error, reason}` which is NOT
 * the policy contract. Every create/update handler funnels through this.
 */
async function withAiPolicyRefusals<T>(reply: FastifyReply, run: () => Promise<T>): Promise<T | FastifyReply> {
  try {
    return await run();
  } catch (err) {
    if (isAiPolicyRefusal(err)) return sendAiPolicyRefusal(reply, err);
    throw err;
  }
}

/**
 * `aiPolicy` and `expectedRevision` on `PUT /pages/:id` are a pair (#280):
 * the revision is the compare-and-set key for the policy change. One
 * without the other is a request this route understands and REFUSES as its
 * own 422 — not the global schema-validation 400, which would hide the
 * policy contract behind a generic shape error.
 */
function assertAiPolicyPairing(reply: FastifyReply, body: { aiPolicy?: unknown; expectedRevision?: unknown }): FastifyReply | null {
  if (isAiPolicyUpdatePaired(body)) return null;
  const missing = body.aiPolicy === undefined ? 'aiPolicy' : 'expectedRevision';
  return reply.status(422).send({
    error: 'ai_policy_revision_required',
    message: `aiPolicy and expectedRevision must be sent together (${missing} is missing)`,
    missing,
  });
}
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
const RestoreIdParamSchema = z.object({ id: PagePrimaryKeySchema });

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

/**
 * #1779: store a local edit in page_versions before bulk sync overwrites it. Runs on
 * the overwrite's own transaction (a pool write would wait on its row lock via
 * the page_versions foreign key), so the snapshot and the overwrite commit or
 * roll back together.
 *
 * History is keyed by version number, and opening Version History imports a
 * body-less row for every Confluence version. Such a placeholder at the local
 * version number is claimed for the local text (never a baseline-linked row).
 * A row that already holds other content (title or body) refuses the
 * overwrite instead of silently skipping the snapshot.
 */
async function snapshotLocalVersionBeforeOverwrite(
  client: PoolClient,
  row: ConflictPolicyRow,
): Promise<void> {
  const stored = await client.query(
    `INSERT INTO page_versions (page_id, version_number, title, body_html, body_text)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (page_id, version_number) DO UPDATE
       SET title = EXCLUDED.title, body_html = EXCLUDED.body_html,
           body_text = EXCLUDED.body_text, synced_at = NOW()
       WHERE page_versions.body_html IS NULL
         AND NOT EXISTS (SELECT 1 FROM page_baselines b WHERE b.version_snapshot_id = page_versions.id)`,
    [row.id, row.version, row.title, row.body_html, row.body_text],
  );
  if ((stored.rowCount ?? 0) > 0) return;
  const preserved = await client.query(
    `SELECT 1 FROM page_versions
      WHERE page_id = $1 AND version_number = $2 AND title IS NOT DISTINCT FROM $3
        AND body_html IS NOT DISTINCT FROM $4 AND body_text IS NOT DISTINCT FROM $5`,
    [row.id, row.version, row.title, row.body_html, row.body_text],
  );
  if (preserved.rowCount === 0) {
    throw new PageWriteError(
      409,
      'local_edit_snapshot_conflict',
      `Version ${row.version} in the page's version history already holds other content, so the local edit `
        + 'could not be stored there and was kept; saving the page with the Confluence integration off gives it a new version number',
    );
  }
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

/**
 * Article AI policy (#281): decide what a label write means for the page's
 * policy from the admitted row, BEFORE any provider call. A contradictory
 * label set is a 422; a relaxation label from an actor without policy
 * authority is a 403. Neither reaches Confluence. The returned plan's label
 * set is what is published and later committed through
 * `applyPageLabelsOnClient` (which re-plans from the locked row).
 */
async function planAuthorizedLabelWrite(
  client: PoolClient,
  pageId: number,
  userId: string,
  targetLabels: readonly string[],
): Promise<LabelPolicyPlan> {
  const row = await client.query<{ ai_policy: string; labels: string[] | null }>(
    'SELECT ai_policy, labels FROM pages WHERE id = $1 AND deleted_at IS NULL',
    [pageId],
  );
  const current = row.rows[0];
  if (!current) throw new PageWriteError(404, 'page_not_found', 'Page not found');
  const currentPolicy: AiPolicy = isAiPolicy(current.ai_policy) ? current.ai_policy : 'none';
  const plan = planLabelPolicyChange({
    currentPolicy,
    currentLabels: current.labels ?? [],
    targetLabels,
  });
  await assertLabelPolicyChangeOnClient(client, { userId, pageId, plan });
  return plan;
}

/**
 * #281 review: the label set a Confluence writer reserved (and published
 * upstream) must still be the set the local row admits. At admission the
 * re-plan against the fresh row is compared with the durable target; at
 * completion the locally applied set is compared with what was published.
 * Any divergence (a concurrent policy write, a restored canonical label) is
 * a bounded 409 — the later authoritative policy stands and the mirror is
 * never claimed. Nothing forces the remote set back.
 */
function assertPublishedLabelsMirrored(
  applied: readonly string[],
  published: readonly string[],
  reason: 'stale_content_revision' | 'ai_policy_label_diverged' = 'ai_policy_label_diverged',
): void {
  if (!sameLabelSet(applied, published)) {
    throw new PageWriteError(
      409,
      reason,
      'The page AI policy changed while its labels were being published; the label write was not mirrored',
    );
  }
}

/**
 * Bulk label policy effects are not ordinary partial-success tag edits. Plan
 * the entire resolved selection before any row worker, job or remote intent
 * starts. Re-read under the shared write/policy fences and compare the
 * selection's existing content/lifecycle pair; never refresh it silently.
 * Per-row publication still rechecks authority and the original pair.
 */
async function preflightBulkLabelPolicies(
  userId: string,
  rows: ReadonlyArray<{ id: number; labels: string[]; contentRevision: string; lifecycleRevision: string }>,
  resolutionFailed: number,
  target: (labels: readonly string[]) => string[],
): Promise<boolean> {
  const ids = rows.map((row) => row.id).sort((a, b) => a - b);
  if (!ids.length) return false;
  // Ordinary labels retain their existing per-row admission (including its
  // integration-mode snapshot). Only policy effects require a set-wide fence.
  const observed = await query<{ id: number; ai_policy: AiPolicy; labels: string[] | null }>(
    'SELECT id, ai_policy, labels FROM pages WHERE id = ANY($1::int[]) AND deleted_at IS NULL', [ids],
  );
  const observedById = new Map(observed.rows.map((row) => [row.id, row]));
  if (rows.every((row) => {
    const page = observedById.get(row.id);
    return page && isAiPolicy(page.ai_policy) && planLabelPolicyChange({
      currentPolicy: page.ai_policy, currentLabels: page.labels, targetLabels: target(row.labels),
    }).kind === 'unchanged';
  })) return false;
  await withPageWriteTransaction(ids, async (client) => {
    await lockAiPolicyForPages(client, ids);
    const current = await client.query<{
      id: number; ai_policy: string; labels: string[] | null;
      content_revision: string; lifecycle_revision: string;
    }>(
      `SELECT id, ai_policy, labels, content_revision::text, lifecycle_revision::text
         FROM pages WHERE id = ANY($1::int[]) AND deleted_at IS NULL ORDER BY id FOR UPDATE`,
      [ids],
    );
    const byId = new Map(current.rows.map((row) => [row.id, row]));
    const plans = rows.map((row) => {
      const fresh = byId.get(row.id);
      if (!fresh) throw new PageWriteError(404, 'page_not_found', 'Page not found');
      if (!isAiPolicy(fresh.ai_policy)) {
        throw new PageWriteError(503, 'ai_policy_unavailable', 'The current AI policy is unavailable');
      }
      return { row, fresh, plan: planLabelPolicyChange({
        currentPolicy: fresh.ai_policy, currentLabels: fresh.labels,
        targetLabels: target(row.labels),
      }) };
    });
    if (!plans.some(({ plan }) => plan.kind !== 'unchanged')) return;
    // Unresolved identifiers may be inaccessible: no selected policy changes
    // are allowed and no title or hidden target identity is disclosed.
    if (resolutionFailed) throw new PageWriteError(404, 'page_not_found', 'Page not found');
    for (const { row, fresh, plan } of plans) {
      if (!(await userCanAccessPage(userId, row.id, client))) {
        throw new PageWriteError(404, 'page_not_found', 'Page not found');
      }
      if (fresh.content_revision !== row.contentRevision || fresh.lifecycle_revision !== row.lifecycleRevision) {
        throw aiPolicyRefusalFromResult({ reason: 'stale_revision', pageIds: [row.id] });
      }
      if (plan.kind !== 'unchanged' && !(await canMutateAiPolicy(userId, row.id, client))) {
        throw aiPolicyRefusalFromResult({ reason: 'not_authorized', pageIds: [row.id] });
      }
    }
    if (plans.some(({ plan }) => plan.kind === 'tighten') && !isAiPolicyEnforcementAvailable()) {
      throw aiPolicyRefusalFromResult({ reason: 'enforcement_unavailable', pageIds: [] });
    }
  });
  return true;
}

/** The remote delta that realises the planned set from the admitted labels. */
function remoteLabelDelta(current: readonly string[], target: readonly string[]): { add: string[]; remove: string[] } {
  const currentSet = new Set(current);
  const targetSet = new Set(target);
  return {
    add: target.filter((label) => !currentSet.has(label)),
    remove: current.filter((label) => !targetSet.has(label)),
  };
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
    const { spaceKey, search, author, labels, freshness, embeddingStatus, qualityMin, qualityMax, qualityStatus, source, visibility, aiPolicy, dateFrom, dateTo, page = 1, limit = 50, sort = 'title' } = params;

    // Cache all page list queries. Filtered queries use a shorter TTL (2 min) vs
    // unfiltered (15 min) since filter results change more frequently (e.g. search
    // results after edits, embedding status during processing).
    // #283: `aiPolicy` is part of the key (and the version is bumped because
    // the row shape gained policy/worker fields) so a filtered list can never
    // be served from an unfiltered cache entry or vice versa.
    const hasFilters = !!(search || author || labels || freshness || embeddingStatus || qualityMin !== undefined || qualityMax !== undefined || qualityStatus || source || visibility || aiPolicy || dateFrom || dateTo);
    const filterParts = [spaceKey ?? '', search ?? '', author ?? '', labels ?? '', freshness ?? '', embeddingStatus ?? '', qualityMin ?? '', qualityMax ?? '', qualityStatus ?? '', source ?? '', visibility ?? '', aiPolicy ?? '', dateFrom ?? '', dateTo ?? '', page, limit, sort].join(':');
    const cacheKey = `list:v5:${filterParts}`;
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

    if (visibility) {
      whereParts.push(`cp.visibility = $${paramIdx++}`);
      values.push(visibility);
    }

    // #283 Library AI-policy filter. An exact match on the stored policy;
    // absent means every readable page. This narrows a list the caller may
    // already read — it is not an access rule, and the unfiltered list (and
    // the FTS/ILIKE search above) still returns `none` and `local_only` pages.
    if (aiPolicy) {
      whereParts.push(`cp.ai_policy = $${paramIdx++}`);
      values.push(aiPolicy);
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
      ai_policy: string | null;
      ai_policy_revision: string | null;
      ai_policy_block_reason: string | null;
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
               CASE WHEN parent_page.id IS NULL THEN NULL ELSE cp.parent_id END AS parent_id,
               cp.labels, cp.author, cp.last_modified_at, cp.last_synced,
               cp.embedding_dirty, cp.embedding_status, cp.embedded_at, cp.embedding_error,
               cp.quality_score, cp.quality_status, cp.quality_completeness, cp.quality_clarity,
               cp.quality_structure, cp.quality_accuracy, cp.quality_readability,
               cp.quality_summary, cp.quality_analyzed_at, cp.quality_error,
               cp.summary_status, cp.source, cp.visibility,
               cp.icon_kind, cp.icon_value, cp.icon_color, cp.icon_filled,
               cp.baseline_id, cp.frozen_version,
               cp.ai_policy, cp.ai_policy_revision::text, cp.ai_policy_block_reason
        FROM pages cp
        LEFT JOIN pages parent_page ON (
          parent_page.confluence_id = cp.parent_id
          OR parent_page.id::text = cp.parent_id
        )
          AND parent_page.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM pages parent_collision
            WHERE parent_collision.deleted_at IS NULL
              AND (parent_collision.confluence_id = cp.parent_id
                   OR parent_collision.id::text = cp.parent_id)
              AND parent_collision.id <> parent_page.id
          )
          AND ${visiblePagesPredicate(1, 2, 'parent_page')}
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
        // #283: the stored policy and its compare-and-set revision, so a bulk
        // policy action can send `expectedRevision` per selected row; omitted
        // (never defaulted to `all`) when the column is unreadable.
        ...(isAiPolicy(row.ai_policy) && row.ai_policy_revision !== null
          ? { aiPolicy: row.ai_policy, aiPolicyRevision: Number(row.ai_policy_revision) }
          : {}),
        // #281/#283: the ACTUAL worker block reason and the stages refused
        // now, derived by the shared contract helper the detail route uses.
        ...deriveAiPolicyWorkerFields({
          embeddingStatus: row.embedding_status,
          summaryStatus: row.summary_status,
          qualityStatus: row.quality_status,
          blockReason: row.ai_policy_block_reason,
        }),
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

    const cacheKey = `tree:v3:${params.spaceKey ?? 'all'}`;
    const { value: cached, generation } = await cache.getWithGeneration(userId, 'pages', cacheKey);
    if (cached) return cached;

    // Reuse the shared list visibility definition. Confluence rows require an
    // actual RBAC space assignment; standalone visibility is independent of
    // space access, so local-space keys must not authorize moved Confluence
    // rows.
    const rbacSpaces = await getUserAccessibleSpaces(userId);
    const values: unknown[] = [rbacSpaces, userId];
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
         OR parent_page.id::text = cp.parent_id
       )
         AND parent_page.deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM pages parent_collision
           WHERE parent_collision.deleted_at IS NULL
             AND (parent_collision.confluence_id = cp.parent_id
                  OR parent_collision.id::text = cp.parent_id)
             AND parent_collision.id <> parent_page.id
         )
         AND ${visiblePagesPredicate(1, 2, 'parent_page')}
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
    const cacheKey = `filters:v3:${spacesKey}`;

    const { value: cached, generation } = await cache.getWithGeneration<{
      authors: string[]; labels: string[];
    }>(userId, 'pages', cacheKey);
    if (cached) return cached;

    const [authorsResult, labelsResult] = await Promise.all([
      query<{ author: string }>(
        `SELECT DISTINCT cp.author FROM pages cp
         WHERE cp.author IS NOT NULL
           AND cp.deleted_at IS NULL
           AND ${visiblePagesPredicate(1, 2)}
         ORDER BY cp.author ASC`,
        [filterSpaces, userId],
      ),
      query<{ label: string }>(
        `SELECT DISTINCT unnest(cp.labels) AS label FROM pages cp
         WHERE cp.deleted_at IS NULL
           AND ${visiblePagesPredicate(1, 2)}
         ORDER BY label ASC`,
        [filterSpaces, userId],
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
      space_key: string | null; space_missing: boolean;
    }>(
      `SELECT p.id, p.title, p.source, p.visibility, p.deleted_at, p.last_synced,
              u.username AS deleted_by, p.space_key,
              (p.space_key IS NOT NULL AND p.space_key <> '__local__'
               AND s.space_key IS NULL) AS space_missing
       FROM pages p
       JOIN users u ON u.id = p.created_by_user_id
       LEFT JOIN spaces s ON s.space_key = p.space_key
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
        spaceKey: row.space_key,
        spaceMissing: row.space_missing,
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
    const accessibleSpaces = await getUserAccessibleSpaces(userId);

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
      ai_policy: AiPolicy;
      ai_policy_revision: string;
      ai_policy_block_reason: string | null;
    }>(
      `SELECT cp.id, cp.confluence_id, cp.space_key, cp.title, cp.page_type,
              cp.body_storage, cp.body_html, cp.body_text,
              cp.ai_policy, cp.ai_policy_revision::text, cp.ai_policy_block_reason,
              cp.version, cp.parent_id, cp.labels, cp.author, cp.last_modified_at, cp.last_synced,
              cp.embedding_dirty, cp.embedding_status, cp.embedded_at, cp.embedding_error,
              cp.quality_score, cp.quality_status, cp.quality_completeness, cp.quality_clarity,
              cp.quality_structure, cp.quality_accuracy, cp.quality_readability,
              cp.quality_summary, cp.quality_analyzed_at, cp.quality_error,
              -- Children use the parent's canonical stored key: a Confluence
              -- parent's upstream id, or a standalone parent's numeric id.
              -- Reject a key that also identifies a second live page, and
              -- apply the same shared list visibility as the children route.
              EXISTS(SELECT 1 FROM pages c2
                      WHERE c2.parent_id = CASE
                              WHEN cp.source = 'confluence' THEN cp.confluence_id
                              ELSE cp.id::text
                            END
                        AND c2.deleted_at IS NULL
                        AND NOT EXISTS (
                          SELECT 1 FROM pages parent_collision
                          WHERE parent_collision.deleted_at IS NULL
                            AND parent_collision.id <> cp.id
                            AND (
                              parent_collision.confluence_id = CASE
                                WHEN cp.source = 'confluence' THEN cp.confluence_id
                                ELSE cp.id::text
                              END
                              OR parent_collision.id::text = CASE
                                WHEN cp.source = 'confluence' THEN cp.confluence_id
                                ELSE cp.id::text
                              END
                            )
                        )
                        AND ${visiblePagesPredicate(3, 2, 'c2')}) as has_children,
              cp.summary_html, cp.summary_status, cp.summary_generated_at, cp.summary_model, cp.summary_error,
              cp.source, cp.visibility, cp.created_by_user_id,
              (cp.draft_body_html IS NOT NULL) as has_draft, cp.draft_updated_at,
              cp.verified_at, cp.icon_kind, cp.icon_value, cp.icon_color, cp.icon_filled,
              cp.baseline_id, cp.frozen_version
       FROM pages cp
       WHERE ${isNumericId ? 'cp.id = $1' : 'cp.confluence_id = $1'}
         AND cp.deleted_at IS NULL
         AND ${visiblePagesPredicate(3, 2, 'cp')}`,
      [isNumericId ? parseInt(id, 10) : id, userId, accessibleSpaces],
    );

    if (result.rows.length === 0) {
      throw fastify.httpErrors.notFound('Page not found');
    }

    const row = result.rows[0]!;


    let visibleParentId = row.parent_id;
    if (visibleParentId !== null) {
      const parentResult = await query<{ id: number }>(
        `SELECT parent.id
         FROM pages parent
         WHERE (parent.confluence_id = $1 OR parent.id::text = $1)
           AND parent.deleted_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM pages parent_collision
             WHERE parent_collision.deleted_at IS NULL
               AND parent_collision.id <> parent.id
               AND (parent_collision.confluence_id = $1
                    OR parent_collision.id::text = $1)
           )
           AND ${visiblePagesPredicate(2, 3, 'parent')}
         ORDER BY parent.id`,
        [visibleParentId, accessibleSpaces, userId],
      );
      if (parentResult.rows.length !== 1) visibleParentId = null;
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
    let canChangeAiPolicy: boolean;
    try {
      await lifecycleClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      lifecycleState = await getPageLifecycleState(lifecycleClient, row.id, userId);
      renderedBodyHtml = await renderedFrozenPageBodyHtml(lifecycleClient, row.id, userId);
      canChangeAiPolicy = await canMutateAiPolicy(userId, row.id, lifecycleClient);
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
      parentId: visibleParentId,
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
      // Article AI policy (#280): the stored authority, its optimistic
      // revision, whether THIS caller may change it, and whether enforcement
      // is live or the deployment is foundation-only.
      aiPolicy: row.ai_policy,
      aiPolicyRevision: Number(row.ai_policy_revision),
      canChangeAiPolicy,
      aiPolicyActivation: isAiPolicyEnforcementAvailable() ? 'active' : 'foundation_only',
      // #281/#283: the persisted worker block reason, the stages refused
      // NOW, and whether requeued work is recovering — so the inspector names
      // the server's reason instead of guessing from a bare status.
      ...deriveAiPolicyWorkerFields({
        embeddingStatus: row.embedding_status,
        summaryStatus: row.summary_status,
        qualityStatus: row.quality_status,
        blockReason: row.ai_policy_block_reason,
      }),
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

    const isNumericId = /^\d+$/.test(id);
    const accessibleSpaces = await getUserAccessibleSpaces(userId);
    const rootSpaceParam = isNumericId ? 3 : 2;
    const rootUserParam = rootSpaceParam + 1;
    const pageResult = await query<{
      id: number;
      confluence_id: string | null;
      source: string;
      canonical_key_hidden_collision: boolean;
      canonical_key_ambiguous: boolean;
    }>(
      `SELECT page.id, page.confluence_id, page.source,
              EXISTS (
                SELECT 1
                FROM pages candidate
                WHERE candidate.deleted_at IS NULL
                  AND candidate.id <> page.id
                  AND (
                    candidate.confluence_id = CASE
                      WHEN page.source = 'confluence' THEN page.confluence_id
                      ELSE page.id::text
                    END
                    OR candidate.id::text = CASE
                      WHEN page.source = 'confluence' THEN page.confluence_id
                      ELSE page.id::text
                    END
                  )
                  AND NOT COALESCE(${visiblePagesPredicate(rootSpaceParam, rootUserParam, 'candidate')}, false)
              ) AS canonical_key_hidden_collision,
              EXISTS (
                SELECT 1
                FROM pages candidate
                WHERE candidate.deleted_at IS NULL
                  AND candidate.id <> page.id
                  AND (
                    candidate.confluence_id = CASE
                      WHEN page.source = 'confluence' THEN page.confluence_id
                      ELSE page.id::text
                    END
                    OR candidate.id::text = CASE
                      WHEN page.source = 'confluence' THEN page.confluence_id
                      ELSE page.id::text
                    END
                  )
              ) AS canonical_key_ambiguous
       FROM pages page
       WHERE ${isNumericId ? '(page.confluence_id = $1 OR page.id::text = $2)' : 'page.confluence_id = $1'}
         AND page.deleted_at IS NULL
         AND ${visiblePagesPredicate(rootSpaceParam, rootUserParam, 'page')}
       ORDER BY page.id`,
      isNumericId
        ? [id, toPageIdText(id), accessibleSpaces, userId]
        : [id, accessibleSpaces, userId],
    );
    if (pageResult.rows.length === 0) {
      throw fastify.httpErrors.notFound('Page not found');
    }
    if (pageResult.rows.length > 1) {
      throw fastify.httpErrors.conflict('Page identifier is ambiguous');
    }

    const page = pageResult.rows[0]!;

    const parentLookupId = page.source === 'confluence'
      ? page.confluence_id!
      : String(page.id);
    // A collision with a row the caller cannot see fails closed exactly like
    // the detail route's `hasChildren` (no distinct status, so no existence
    // oracle). 409 is reserved for collisions among rows the caller can read.
    if (page.canonical_key_hidden_collision) {
      return { hasChildren: false };
    }
    if (page.canonical_key_ambiguous) {
      throw fastify.httpErrors.conflict('Page identifier is ambiguous');
    }
    const childResult = await query<{ has_children: boolean }>(
      `SELECT EXISTS(
         SELECT 1
         FROM pages child
         WHERE child.parent_id = $1
           AND child.deleted_at IS NULL
           AND NOT EXISTS (
             SELECT 1
             FROM pages parent_collision
             WHERE parent_collision.deleted_at IS NULL
               AND parent_collision.id <> $2
               AND (parent_collision.confluence_id = $1
                    OR parent_collision.id::text = $1)
           )
           AND ${visiblePagesPredicate(3, 4, 'child')}
       ) AS has_children`,
      [parentLookupId, page.id, accessibleSpaces, userId],
    );

    return { hasChildren: childResult.rows[0]?.has_children ?? false };
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
    const accessibleSpaces = await getUserAccessibleSpaces(userId);
    const rootSpaceParam = isNumericId ? 3 : 2;
    const rootUserParam = rootSpaceParam + 1;
    const pageResult = await query<{
      id: number;
      confluence_id: string | null;
      space_key: string | null;
      source: string;
      visibility: string;
      created_by_user_id: string | null;
      canonical_key_hidden_collision: boolean;
      canonical_key_ambiguous: boolean;
    }>(
      `SELECT page.id, page.confluence_id, page.space_key, page.source,
              page.visibility, page.created_by_user_id,
              EXISTS (
                SELECT 1
                FROM pages candidate
                WHERE candidate.deleted_at IS NULL
                  AND candidate.id <> page.id
                  AND (
                    candidate.confluence_id = CASE
                      WHEN page.source = 'confluence' THEN page.confluence_id
                      ELSE page.id::text
                    END
                    OR candidate.id::text = CASE
                      WHEN page.source = 'confluence' THEN page.confluence_id
                      ELSE page.id::text
                    END
                  )
                  AND NOT COALESCE(${visiblePagesPredicate(rootSpaceParam, rootUserParam, 'candidate')}, false)
              ) AS canonical_key_hidden_collision,
              EXISTS (
                SELECT 1
                FROM pages candidate
                WHERE candidate.deleted_at IS NULL
                  AND candidate.id <> page.id
                  AND (
                    candidate.confluence_id = CASE
                      WHEN page.source = 'confluence' THEN page.confluence_id
                      ELSE page.id::text
                    END
                    OR candidate.id::text = CASE
                      WHEN page.source = 'confluence' THEN page.confluence_id
                      ELSE page.id::text
                    END
                  )
              ) AS canonical_key_ambiguous
       FROM pages page
       WHERE ${isNumericId ? '(page.confluence_id = $1 OR page.id::text = $2)' : 'page.confluence_id = $1'}
         AND page.deleted_at IS NULL
         AND ${visiblePagesPredicate(rootSpaceParam, rootUserParam, 'page')}
       ORDER BY page.id`,
      isNumericId
        ? [id, toPageIdText(id), accessibleSpaces, userId]
        : [id, accessibleSpaces, userId],
    );

    if (pageResult.rows.length === 0) {
      throw fastify.httpErrors.notFound('Page not found');
    }
    if (pageResult.rows.length > 1) {
      throw fastify.httpErrors.conflict('Page identifier is ambiguous');
    }

    const page = pageResult.rows[0]!;


    // Children store the canonical key of the parent, independent of the
    // child's source, so mixed-source hierarchies remain representable.
    const parentLookupId = page.source === 'confluence'
      ? page.confluence_id!
      : String(page.id);

    // Same fail-closed rule as /has-children and the detail route.
    if (page.canonical_key_hidden_collision) {
      return { children: [] };
    }
    if (page.canonical_key_ambiguous) {
      throw fastify.httpErrors.conflict('Page identifier is ambiguous');
    }

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
      source: string;
      icon_kind: string | null;
      icon_value: string | null;
      icon_color: string | null;
      icon_filled: boolean | null;
    };

    const treeResult = await query<FlatChildRow>(
      `WITH RECURSIVE tree AS (
         SELECT p.id, p.confluence_id, p.title, p.space_key, p.parent_id, p.source, 1 AS depth,
                p.icon_kind, p.icon_value, p.icon_color, p.icon_filled
         FROM pages p
         WHERE p.parent_id = $1
           AND p.deleted_at IS NULL
           AND ${visiblePagesPredicate(4, 5, 'p')}
         UNION ALL
         SELECT p.id, p.confluence_id, p.title, p.space_key, p.parent_id, p.source, t.depth + 1,
                p.icon_kind, p.icon_value, p.icon_color, p.icon_filled
         FROM pages p
         JOIN tree t ON p.parent_id = CASE
           WHEN t.source = 'confluence' THEN t.confluence_id
           ELSE t.id::text
         END
         WHERE p.deleted_at IS NULL
           AND t.depth < $2
           AND NOT EXISTS (
             SELECT 1 FROM pages parent_collision
             WHERE parent_collision.deleted_at IS NULL
               AND parent_collision.id <> t.id
               AND (
                 parent_collision.confluence_id = CASE
                   WHEN t.source = 'confluence' THEN t.confluence_id
                   ELSE t.id::text
                 END
                 OR parent_collision.id::text = CASE
                   WHEN t.source = 'confluence' THEN t.confluence_id
                   ELSE t.id::text
                 END
               )
           )
           AND ${visiblePagesPredicate(4, 5, 'p')}
       )
       SELECT * FROM tree ORDER BY depth, ${sortColumn} ${sortOrder}
       LIMIT $3`,
      [parentLookupId, depth, MAX_TOTAL_NODES, accessibleSpaces, userId],
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
  fastify.post<{ Params: { id: string } }>('/pages/:id/restore', async (request, reply) => {
    const rawId = request.params.id;
    const { id } = RestoreIdParamSchema.parse(request.params);
    const body = RestorePageBodySchema.parse(request.body === undefined ? {} : request.body);
    const userId = request.userId;

    const restored = await withHierarchyCascadeTransaction(async (client) => {
      const existing = await client.query<{
        id: number; title: string; source: string; parent_id: string | null;
        created_by_user_id: string | null; deleted_at: Date | null; visibility: string;
        notion_page_id: string | null; space_key: string | null;
      }>(
        `SELECT id, title, source, parent_id, created_by_user_id, deleted_at, visibility,
                notion_page_id, space_key
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
        space_key: string | null;
      }>(
        `SELECT id, visibility, baseline_id, space_key
           FROM pages
          WHERE id = ANY($1::int[])
          ORDER BY space_key COLLATE "C", id`,
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

      const rootSpaceKey = page.space_key === '__local__' ? null : page.space_key;
      const targetSpaceKey = body.targetSpaceKey === '__local__' ? null : body.targetSpaceKey ?? null;
      // Probe the root first; retain every existing final space through commit.
      const rootSpace = rootSpaceKey === null ? undefined : (await client.query<{
        space_key: string; source: string;
      }>(
        'SELECT space_key, source FROM spaces WHERE space_key = $1 FOR SHARE',
        [rootSpaceKey],
      )).rows[0];
      let rehome: { targetSpaceKey: string; missingSpaceKey: string } | undefined;
      if (rootSpaceKey === null || rootSpace) {
        if (body.targetSpaceKey !== undefined && targetSpaceKey !== rootSpaceKey) {
          return {
            refusal: {
              statusCode: 400,
              error: 'ValidationError',
              reason: 'restore_target_not_applicable',
              message: 'A restore target can only be chosen when the stored space no longer exists.',
            },
          };
        }
      } else {
        if (body.targetSpaceKey === undefined) {
          return {
            refusal: {
              statusCode: 409,
              error: 'Conflict',
              reason: 'restore_space_missing',
              message: `The space "${rootSpaceKey}" no longer exists. Choose a space to restore into.`,
              missingSpaceKey: rootSpaceKey,
              canChooseTarget: true,
            },
          };
        }
        rehome = { targetSpaceKey: body.targetSpaceKey, missingSpaceKey: rootSpaceKey };
      }

      const remainingSpaceKeys = new Set<string>();
      for (const row of batch.rows) {
        if (row.space_key !== null && row.space_key !== '__local__' && row.space_key !== page.space_key) {
          remainingSpaceKeys.add(row.space_key);
        }
      }
      if (rehome && targetSpaceKey !== null) remainingSpaceKeys.add(targetSpaceKey);
      const lockedSpaces = new Map<string, string>();
      if (rootSpace) lockedSpaces.set(rootSpace.space_key, rootSpace.source);
      if (remainingSpaceKeys.size > 0) {
        const spaces = await client.query<{ space_key: string; source: string }>(
          `SELECT space_key, source FROM spaces
            WHERE space_key = ANY($1::text[])
            ORDER BY space_key COLLATE "C"
            FOR SHARE`,
          [[...remainingSpaceKeys]],
        );
        for (const space of spaces.rows) lockedSpaces.set(space.space_key, space.source);
      }
      if (rehome && (
        rehome.targetSpaceKey === rehome.missingSpaceKey ||
        (targetSpaceKey !== null && lockedSpaces.get(targetSpaceKey) !== 'local')
      )) {
        return {
          refusal: {
            statusCode: 409,
            error: 'Conflict',
            reason: 'restore_target_space_invalid',
            message: 'The selected restore space is unavailable. Choose an existing local space.',
          },
        };
      }
      // The nonlocking batch read is C-ordered for deterministic missing-key refusal.
      const missingRetainedSpaceKey = batch.rows.find((row) =>
        row.space_key !== null && row.space_key !== '__local__' &&
        row.space_key !== rehome?.missingSpaceKey && !lockedSpaces.has(row.space_key),
      )?.space_key;
      if (missingRetainedSpaceKey !== undefined && missingRetainedSpaceKey !== null) {
        return {
          refusal: {
            statusCode: 409,
            error: 'Conflict',
            reason: 'restore_space_missing',
            message: `The space "${missingRetainedSpaceKey}" for another page in this trash batch no longer exists. This batch cannot be restored by choosing a target for this page.`,
            missingSpaceKey: missingRetainedSpaceKey,
            canChooseTarget: false,
          },
        };
      }

      let detachRoot = false;
      if (rehome && parentResolution.kind === 'resolved' && parentResolution.parent.deletedAt === null) {
        const parentSpace = (await client.query<{ space_key: string | null }>(
          'SELECT space_key FROM pages WHERE id = $1',
          [parentResolution.parent.id],
        )).rows[0];
        if (parentSpace) {
          detachRoot = (parentSpace.space_key === '__local__' ? null : parentSpace.space_key) !== targetSpaceKey;
        }
      }
      const rows = await client.query<{ visibility: string }>(
        `UPDATE pages AS p
            SET deleted_at = NULL,
                space_key = CASE
                  WHEN $2::text IS NOT NULL AND p.space_key = $2::text THEN $3::text
                  ELSE p.space_key
                END,
                parent_id = CASE
                  WHEN $4::boolean AND p.id = $5::int THEN NULL
                  ELSE p.parent_id
                END
          WHERE p.id = ANY($1::int[])
          RETURNING p.visibility`,
        [batchIds, rehome?.missingSpaceKey ?? null, targetSpaceKey, detachRoot, page.id],
      );
      return { page, restored: true, restoredCount: rows.rows.length, rows: rows.rows, rehome };
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
    await logAuditEvent(userId, 'PAGE_RESTORED', 'page', rawId, {
      source: 'standalone',
      title: restored.page.title,
      restoredCount: restored.restoredCount,
      ...restored.rehome,
    }, request);
    return { id: restored.page.id, title: restored.page.title, restored: true };
  });

  // POST /api/pages - create page (standalone local or Confluence + local cache)
  fastify.post('/pages', async (request, reply) => withAiPolicyRefusals(reply, async () => {
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

    // Article AI policy (#281): a label set naming two different policies is
    // refused before anything is created — locally or upstream. A new page
    // has no prior labels, so this is purely a contradiction check (422).
    // The planned (canonical, deduplicated) set and the resulting first
    // publication policy — stricter of the creation default and the labels —
    // are decided HERE, before any remote effect, and carried through the
    // create (as part of the durable intent effect) so the local row is never
    // first published looser than the creator stated (#281 review).
    let initialLabels = [...new Set(body.labels ?? [])];
    // An explicit `aiPolicy` that disagrees with the labels is a 422: the
    // caller stated two policies at once (#280). A restrictive explicit
    // choice on a foundation-only deployment is refused rather than silently
    // downgraded (409 `ai_policy_enforcement_unavailable`).
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

    if (body.aiPolicy !== undefined) {
      // The labels are read with the FULL reserved table (`all-ai` included):
      // `all-ai` + `aiPolicy: 'none'` is a contradiction just as `no-ai` +
      // `aiPolicy: 'all'` is. `planLabelPolicyChange` already refused two
      // different label policies, so at most one is named here.
      const labelPolicies = aiPolicyLabelConflict(initialLabels);
      if (labelPolicies.some((p) => p !== body.aiPolicy)) {
        throw new AiPolicyRefusalError(
          422,
          { error: 'ai_policy_label_conflict', policies: [...new Set([body.aiPolicy, ...labelPolicies])] },
          `Explicit AI policy ${body.aiPolicy} contradicts the labels (${labelPolicies.join(', ')})`,
        );
      }
      if (body.aiPolicy !== 'all' && !isAiPolicyEnforcementAvailable()) {
        throw aiPolicyRefusalFromResult({ reason: 'enforcement_unavailable', pageIds: [] });
      }
      // Choosing a policy for a Confluence page needs policy authority in the
      // target space (read-only roles have none); a standalone creator is the
      // owner and always may.
      const mayChoose = await withPageWriteTransaction([], (c) => canChoosePolicyAtCreation(
        userId,
        {
          source: isStandalone ? 'standalone' : 'confluence',
          spaceKey: body.spaceKey && body.spaceKey !== '__local__' ? body.spaceKey : null,
        },
        c,
      ));
      if (!mayChoose) throw aiPolicyRefusalFromResult({ reason: 'not_authorized', pageIds: [] });
    }
    const initialPolicy = await resolveCreationAiPolicy({
      userId,
      spaceKey: body.spaceKey && body.spaceKey !== '__local__' ? body.spaceKey : null,
      labels: initialLabels,
      explicit: body.aiPolicy,
    });
    initialLabels = applyCanonicalAiPolicyLabel(initialLabels, initialPolicy);

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

        // Policy and content land in ONE statement (#280): the row is never
        // observable with its labels but without the policy they imply, and
        // the stored labels are the planned canonical set, not the raw input.
        const result = await client.query<{ id: number; title: string; version: number }>(
          `INSERT INTO pages
             (title, body_html, body_text, body_storage, source, created_by_user_id,
              visibility, version, space_key, confluence_id, parent_id,
              page_type, embedding_dirty, image_analysis_dirty, embedding_status, last_synced, labels,
              ai_policy)
           VALUES ($1, $2, $3, NULL, 'standalone', $4, $5, 1, $6, NULL, $7,
                   $8, $9, $9, 'not_embedded', NOW(), $10, $11)
           RETURNING id, title, version`,
          [body.title, effectiveBodyHtml, bodyText, userId,
           visibility, spaceKey, body.parentId ?? null,
           pageType, !isFolder, initialLabels, initialPolicy],
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
            initialPolicy,
            initialLabels,
          },
        });
      });
    } else {
      // A root create (no parent) has no page row to reserve, but it is still
      // a remote mutation with a trusted initial policy. Migration 137 admits
      // exactly this shape (#280): empty targets, null parent, the policy and
      // labels the publication will write in its own transaction.
      createIntent = await withPageWriteTransaction([], (writeClient) =>
        reservePageWriteIntentInTransaction(writeClient, {
          pageIds: [],
          kind: 'pages.create.confluence',
          actorId: userId,
          effect: {
            effectClass: 'remote',
            parentPageId: null,
            parentConfluenceId: null,
            spaceKey: body.spaceKey!,
            titleSha256: createHash('sha256').update(body.title).digest('hex'),
            storageSha256: createHash('sha256').update(storageBody).digest('hex'),
            initialPolicy,
            initialLabels,
          },
        }));
    }

    const page = await runPageWriteIntentEffect(
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
    );
    const publishedStorage = page.body?.storage?.value ?? storageBody;
    if (
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
    // A sync walker may import the acknowledged page before this local
    // publication (sync-first). `publishCreatedConfluencePage` then tightens
    // that exact row to the admitted initial policy; its change records are
    // emitted only after the publication transaction has committed.
    const publication = {
      confluenceId: page.id,
      spaceKey: body.spaceKey!,
      parentConfluenceId: localParentReferenceId,
      title: page.title,
      storage: publishedStorage,
      version: page.version.number,
      initialPolicy,
      initialLabels,
      actorId: userId,
    };
    const admittedCreateIntent = createIntent;
    const labelWrites: PolicyLabelWrite[] = [];
    await completePageWriteIntent(
      admittedCreateIntent,
      async (writeClient) => {
        const actor = await writeClient.query<{ active: boolean }>(
          'SELECT deactivated_at IS NULL AS active FROM users WHERE id = $1',
          [userId],
        );
        const parentId = admittedCreateIntent.pageIds[0];
        if (
          actor.rows[0]?.active !== true ||
          (parentId !== undefined && !(await userCanAccessPage(userId, parentId, writeClient)))
        ) {
          throw new PageWriteError(
            403,
            'parent_access_changed',
            'Access to the Confluence parent changed before local publication',
          );
        }
        if (parentId === undefined) {
          const accessibleSpaces = await getUserAccessibleSpaces(userId, writeClient);
          if (!accessibleSpaces.includes(body.spaceKey!)) {
            throw new PageWriteError(403, 'space_access_changed', 'Access to the space changed before local publication');
          }
        }
        const published = await publishCreatedConfluencePage(writeClient, publication);
        const labelWrite = await reservePolicyLabelSynchronization(writeClient, userId, published.id);
        if (labelWrite) labelWrites.push(labelWrite);
        await enqueuePageWriteInvalidation(writeClient, admittedCreateIntent.id);
        return published;
      },
    );
    // The publication has COMMITTED (a thrown publication never reaches
    // here), so a sync-first tighten is now a durable transition.

    // A new Confluence page is visible to every user with space access (#893),
    // and the cached spaces payload carries per-space pageCount which this
    // create just changed — clear both caches for every user.
    await cache.invalidateAcrossUsers('pages');
    await cache.invalidateAcrossUsers('spaces');

    // Label debt committed with local publication; upstream failure cannot undo it.
    const synchronization = await synchronizePolicyLabels(userId, labelWrites);

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

    return { id: page.id, title: page.title, version: page.version.number, source: 'confluence', synchronization };
  }));

  // PUT /api/pages/:id - update page (standalone local or Confluence + local cache)
  // Accepts integer page id (universal) or confluence_id string (backward compat)
  fastify.put('/pages/:id', async (request, reply) => withAiPolicyRefusals(reply, async () => {
    const { id } = IdParamSchema.parse(request.params);
    const body = UpdatePageSchema.parse(request.body);
    const unpaired = assertAiPolicyPairing(reply, body);
    if (unpaired) return unpaired;
    const userId = request.userId;

    const isNumericId = /^\d+$/.test(id);

    // Load the page to determine source
    const existing = await query<{
      id: number; version: number; space_key: string | null;
      source: string; created_by_user_id: string | null;
      visibility: string; confluence_id: string | null; deleted_at: Date | null;
      page_type: string;
      content_revision: string; lifecycle_revision: string;
      body_storage: string | null; body_html: string | null;
    }>(
      `SELECT id, version, space_key, source, created_by_user_id, visibility,
              confluence_id, deleted_at, page_type, content_revision::text,
              lifecycle_revision::text, body_storage, body_html
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
        // Policy lock precedes the row lock (SPEC-CORE-003 lock order).
        if (body.aiPolicy !== undefined) await lockAiPolicyForPages(writeClient, [existingPage.id]);
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
        if (body.aiPolicy !== undefined) {
          // Same transaction as the content write (#280): a refused policy
          // rolls the content back with it (local write, fully atomic).
          await applyRequestedAiPolicyOnClient(writeClient, {
            userId, pageId: existingPage.id, aiPolicy: body.aiPolicy, expectedRevision: body.expectedRevision!,
          });
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

    // A requested policy change is authorized BEFORE any remote egress (#280):
    // the binding write happens again on the publication transaction below.
    if (body.aiPolicy !== undefined) {
      if (body.aiPolicy !== 'all' && !isAiPolicyEnforcementAvailable()) {
        throw aiPolicyRefusalFromResult({ reason: 'enforcement_unavailable', pageIds: [existingPage.id] });
      }
      const expectedPolicyRevision = body.expectedRevision!;
      const authorized = await withPageWriteTransaction([], async (c) => {
        if (!(await canMutateAiPolicy(userId, existingPage.id, c))) return false;
        const r = await c.query<{ ai_policy_revision: string }>(
          'SELECT ai_policy_revision FROM pages WHERE id = $1', [existingPage.id],
        );
        if (Number(r.rows[0]?.ai_policy_revision) !== expectedPolicyRevision) {
          throw aiPolicyRefusalFromResult({ reason: 'stale_revision', pageIds: [existingPage.id] });
        }
        return true;
      });
      if (!authorized) {
        throw aiPolicyRefusalFromResult({ reason: 'not_authorized', pageIds: [existingPage.id] });
      }
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
        const nextStorageBody = htmlToConfluence(uploadedBodyHtml, {
          previousStorage: existingPage.body_storage,
          legacyTasks: hasOnlyUncarriedTasks(existingPage.body_html),
        });
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
    // Confluence has acknowledged the write: from here on the local mirror
    // must settle the KNOWN effect exactly once. The read-back of a compact
    // acknowledgment is evidence gathering against the durable receipt, not
    // a new remote write, so it rides the client that was admitted for the
    // dispatch rather than renewing write authority (#281 review: an actor
    // whose visibility/edit right/integration changed between the ack and
    // this point must still reach the settlement below, which answers the
    // concealed 404 / 403 / 409 AFTER the local row mirrors the remote
    // version — re-admitting here would surface a bare 403/404 that names
    // the page and leaves the intent pending with the mirror behind). A
    // receipt the remote no longer matches is a real 409 that leaves the
    // intent pending for recovery.
    const confPage = await confirmPagePublication(admittedClient, publication.receipt, publication.confPage);

    // Update local cache
    const bodyHtml = (await materializeDrawioPreviews(
      confluenceToHtml(confPage.body.storage.value, existingPage.confluence_id!, existingPage.space_key ?? undefined),
      existingPage.confluence_id!,
    )).html;
    const bodyText = htmlToText(bodyHtml);

    // Confluence has ALREADY accepted the content. A policy refusal found
    // only now (the policy moved or authority was revoked between the
    // pre-egress check and this commit) must NOT roll the content cache back
    // — that would leave the local row disagreeing with the acknowledged
    // remote version. The content commits; the policy refusal is settled
    // AFTER the commit as the frozen 409/403 body whose `published` field
    // tells the caller the content went through (#280 review).
    //
    // The same holds for the authority reload itself: an actor deactivated,
    // an access revoked or a page hidden between the acknowledged remote
    // write and this commit is NOT a reason to leave the local mirror behind
    // the remote version. The cache row is written (the lifecycle trigger
    // still refuses a frozen row — that is a real 409 and propagates), the
    // policy is left untouched, and the refusal is settled after the commit
    // exactly like a policy refusal: 403 with `published`, or a CONCEALED
    // 404 that carries no title/version (the caller may no longer see the
    // page). The post-commit work — collab invalidation, cache, audit,
    // `page.updated` webhook — runs ONCE on every settled path.
    const settlement: { refusal: AiPolicyRefusalError | PageWriteError | null } = { refusal: null };
    await completePageWriteIntent(writeIntent, async (writeClient) => {
      // Policy lock precedes the row lock `loadAuthorizedContentWriteState` takes.
      if (body.aiPolicy !== undefined) await lockAiPolicyForPages(writeClient, [existingPage.id]);
      let authorityLost: PageWriteError | null = null;
      try {
        await loadAuthorizedContentWriteState(
          writeClient, existingPage.id, userId, writeIntent.revisions[existingPage.id]!,
        );
      } catch (err) {
        // Only the authority/visibility outcomes are settled; a stale
        // lifecycle or content revision (409) is an intent-level conflict
        // the ledger must see, so it still propagates.
        if (!(err instanceof PageWriteError) || (err.statusCode !== 403 && err.statusCode !== 404)) throw err;
        // A page the actor can no longer SEE (restriction/visibility change
        // since the acknowledged write) is concealed as 404 regardless of
        // which authority check tripped first; a visible page the actor may
        // no longer EDIT stays a 403 that still reports the publication.
        authorityLost = err.statusCode === 403 && !(await userCanAccessPage(userId, existingPage.id, writeClient))
          ? new PageWriteError(404, 'page_not_found', 'Page not found')
          : err;
      }
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
      if (authorityLost !== null) {
        settlement.refusal = authorityLost;
        return [] as AiPolicyChangeRecord[];
      }
      if (body.aiPolicy === undefined) return [] as AiPolicyChangeRecord[];
      // Same transaction as the content cache write (#280) when it succeeds;
      // a refusal is captured, not thrown, so the content commit stands.
      // `aiPolicyRefusalFromResult` answers a page the caller can no longer
      // SEE as a `PageWriteError` 404 — settled the same way (concealed).
      try {
        return await applyRequestedAiPolicyOnClient(writeClient, {
          userId, pageId: existingPage.id, aiPolicy: body.aiPolicy, expectedRevision: body.expectedRevision!,
        });
      } catch (err) {
        if (err instanceof AiPolicyRefusalError || (err instanceof PageWriteError && err.statusCode === 404)) {
          settlement.refusal = err;
          return [] as AiPolicyChangeRecord[];
        }
        throw err;
      }
    });

    // Post-commit work, exactly once, on every settled path.
    await invalidateCollabDocAfterBodyWrite(existingPage.id);
    // Confluence pages are visible to every user with space access (#893), so
    // clear every user's cached lists/trees, not just the editor's.
    await cache.invalidateAcrossUsers('pages');
    const refusal = settlement.refusal;
    await logAuditEvent(userId, 'PAGE_UPDATED', 'page', String(id), {
      title: body.title,
      ...(refusal instanceof AiPolicyRefusalError ? { aiPolicyRefused: refusal.body.error } : {}),
      ...(refusal instanceof PageWriteError ? { settledAfterPublish: refusal.reason } : {}),
    }, request);
    emitWebhookEvent({
      eventType: 'page.updated',
      payload: {
        pageId: existingPage.id,
        title: body.title,
        spaceKey: existingPage.space_key,
        updatedAt: new Date().toISOString(),
      },
    });

    if (refusal instanceof AiPolicyRefusalError) {
      logger.warn(
        { pageId: existingPage.id, userId, refusal: refusal.body },
        'Page content published to Confluence but the requested AI policy was refused after egress',
      );
      return reply.status(refusal.statusCode).send({
        ...refusal.body,
        message: `${refusal.message}. The page content was published; the AI policy was not changed.`,
        published: { id: existingPage.id, title: body.title, version: confPage.version.number, source: 'confluence' },
      });
    }
    if (refusal !== null) {
      logger.warn(
        { pageId: existingPage.id, userId, reason: refusal.reason, statusCode: refusal.statusCode },
        'Page content published to Confluence but the actor lost authority before the local commit',
      );
      if (refusal.statusCode === 404) {
        // Concealed: the caller may no longer see the page, so the response
        // confirms nothing about it — no title, no version, no `published`.
        return reply.status(404).send({ error: 'page_not_found', reason: 'page_not_found', message: 'Page not found' });
      }
      return reply.status(refusal.statusCode).send({
        error: refusal.reason,
        reason: refusal.reason,
        message: `${refusal.message}. The page content was published; the AI policy was not changed.`,
        published: { id: existingPage.id, title: body.title, version: confPage.version.number, source: 'confluence' },
      });
    }

    return { id: existingPage.id, title: body.title, version: confPage.version.number, source: 'confluence' };
  }));

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
      await withEmbeddingDraftContinuity(writeClient, page.id, () => writeClient.query(
        `UPDATE pages SET draft_body_html = $1, draft_body_text = $2, draft_updated_at = NOW(), draft_updated_by = $3 WHERE id = $4`,
        [body.bodyHtml, draftText, userId, page.id],
      ));
    });

    return { id: page.id, hasDraft: true, draftUpdatedAt: new Date().toISOString() };
  });

  // GET /api/pages/:id/draft — get draft content
  fastify.get('/pages/:id/draft', async (request) => {
    const { id } = IdParamSchema.parse(request.params);
    const userId = request.userId;
    const pageId = parseInt(id, 10);

    // Same caller-bound read rule as GET /pages/:id (space access, standalone
    // visibility and page restrictions). An unreadable page is 404 exactly
    // like a missing one — no existence oracle.
    const spaces = await getUserAccessibleSpaces(userId);
    const result = await query<{
      id: number; draft_body_html: string | null;
      draft_body_text: string | null; draft_updated_at: Date | null;
      draft_updated_by: string | null;
    }>(
      `SELECT cp.id, cp.draft_body_html, cp.draft_body_text, cp.draft_updated_at, cp.draft_updated_by
         FROM pages cp
        WHERE cp.id = $1 AND cp.deleted_at IS NULL
          AND ${visiblePagesPredicate(2, 3)}`,
      [pageId, spaces, userId],
    );
    if (!result.rows.length) throw fastify.httpErrors.notFound('Page not found');

    const row = result.rows[0]!;

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
    const remotePublicationRequired =
      page.confluence_id !== null && !(await pageWriteStaysLocal(userId, page.source));
    // #1751: publication keeps the draft's HTML rather than re-deriving it from
    // the storage Confluence returns, so a remote publication stores the task
    // ids it writes there.
    const publishedHtml = remotePublicationRequired
      ? assignTaskIds(page.draft_body_html, {
        previousStorage: page.body_storage,
        legacyTasks: hasOnlyUncarriedTasks(page.body_html),
      }).html
      : page.draft_body_html;
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
          body_html = $2, body_text = draft_body_text,
          body_storage = COALESCE(draft_body_storage, body_storage),
          version = version + 1, embedding_dirty = TRUE,
          image_analysis_dirty = CASE
            WHEN body_html IS DISTINCT FROM $2 THEN TRUE
            ELSE image_analysis_dirty
          END,
          embedding_status = 'not_embedded', embedded_at = NULL,
          last_modified_at = NOW(),
          local_modified_at = NOW(),
          local_modified_by = COALESCE(draft_updated_by, local_modified_by),
          draft_body_html = NULL, draft_body_text = NULL, draft_body_storage = NULL,
          draft_updated_at = NULL, draft_updated_by = NULL
         WHERE id = $1`,
        [page.id, publishedHtml],
      );
    };

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
            targetBodyHtmlSha256: createHash('sha256').update(publishedHtml).digest('hex'),
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
        storageBody = htmlToConfluence(publishedHtml);
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
      await withEmbeddingDraftContinuity(writeClient, page.id, () => writeClient.query(
        `UPDATE pages SET draft_body_html = NULL, draft_body_text = NULL, draft_body_storage = NULL, draft_updated_at = NULL, draft_updated_by = NULL WHERE id = $1`,
        [page.id],
      ));
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

    // #1779: one id per request, stamped on queued pending_sync_versions rows
    // and on the conflict audit metadata, like one scheduled sync run.
    const syncRunId = randomUUID();

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
          const bodyStorage = page.body?.storage?.value ?? '';
          const bodyHtml = (await materializeDrawioPreviews(
            confluenceToHtml(bodyStorage, id, observed.spaceKey ?? undefined), id,
          )).html;
          const bodyText = htmlToText(bodyHtml);
          const candidate = policyFromLabels(page.metadata?.labels?.results.map((label) => label.name));
          await observeIngestionAdmission({ source: 'confluence', sourceScope: 'shared', sourceId: id,
            observedRevision: String(page.version.number), userId, policy: candidate }, async (admissionClient, pendingPolicy) => {
            const current = await admissionClient.query<{ ai_policy: AiPolicy }>(
              'SELECT ai_policy FROM pages WHERE id = $1 AND deleted_at IS NULL', [numericPageId]);
            if (!current.rows[0]) throw new PageWriteError(404, 'page_not_found', 'Page not found');
            admitAutomaticIngestionPolicy({ identity: id, currentPolicy: current.rows[0].ai_policy, candidate: pendingPolicy });
          });

          // The scheduled sync's local-edit check and policy, on THIS
          // transaction: the helper never opens a second connection, so it
          // cannot wait on the row lock loadAuthorizedContentWriteState holds.
          const decision = await withPageWriteTransaction([numericPageId], async (writeClient) => {
            await lockAiPolicyForPages(writeClient, [numericPageId]);
            await loadAuthorizedContentWriteState(writeClient, numericPageId, userId, observed);
            const decided = await decideConflictPolicyOnClient(writeClient, {
              confluenceId: id, confluenceVersion: page.version.number,
              bodyStorage, bodyHtml, bodyText,
              labels: page.metadata?.labels?.results.map((label) => label.name) ?? [],
              syncRunId,
            });
            if (decided.kind === 'missing') {
              throw new PageWriteError(409, 'page_source_changed', 'The page source changed before synchronization');
            }
            await publishIngestionPolicyOnClient(writeClient, {
              source: 'confluence', sourceScope: 'shared', sourceId: id,
              pageId: numericPageId, userId, candidate,
            });
            // Kept, queued and live-held rows stay as they are, and so does a
            // local edit whose body already matches upstream (a title-only
            // rename), as in the scheduled sync's version-unchanged branch.
            const refresh = decided.kind === 'apply_incoming'
              || (decided.kind === 'unchanged' && !decided.hasLocalEdits);
            if (!refresh) return decided;
            // A local edit is overwritten only after its snapshot is stored on
            // this transaction. The version never decreases; with Confluence
            // not ahead, the snapshot shares the live number and Version
            // History does not list it until the version moves on (user
            // decision on #1779 review r2; a separate upstream-version column
            // is the deferred follow-up).
            if (decided.kind === 'apply_incoming' && decided.hasLocalEdits) {
              await snapshotLocalVersionBeforeOverwrite(writeClient, decided.row);
            }
            await writeClient.query(
              `UPDATE pages SET
                 title = $2, body_storage = $3, body_html = $4, body_text = $5,
                 version = GREATEST(version, $6), last_synced = NOW(), embedding_dirty = TRUE,
                 image_analysis_dirty = CASE
                   WHEN body_html IS DISTINCT FROM $4 THEN TRUE
                   ELSE image_analysis_dirty
                 END,
                 embedding_status = CASE WHEN embedding_status = 'policy_blocked' THEN embedding_status ELSE 'not_embedded' END,
                 labels = ai_policy_apply_label(labels, ai_policy),
                 embedded_at = NULL,
                 local_modified_at = NULL, local_modified_by = NULL
               WHERE id = $1`,
              [numericPageId, page.title, bodyStorage, bodyHtml, bodyText, page.version.number],
            );
            return decided;
          });
          // After commit, never inside it: the audit first (logAuditEvent never
          // throws), then the collab document, whose non-live branch opens its
          // own page-write transaction.
          await recordConflictPolicyAudit(decision, { confluenceId: id, syncRunId, actorUserId: userId });
          if (decision.kind === 'apply_incoming') {
            await reconcileCollabAfterInboundBodyWrite(numericPageId, bodyHtml);
          }
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

    // Both sources embed: `processDirtyPages` selects dirty rows by `pages.id`
    // with no source condition and `embedPage` keys on `pages.id`, so mark the
    // resolved rows by primary key — never by `confluence_id`, which a
    // standalone row may still carry from its synced past (#1745). `succeeded`
    // counts rows queued (marked dirty), not rows embedded: a policy-blocked,
    // folder or bodiless row is marked and counted, and the worker skips it.
    const { errors, failed: resolutionFailed } = bulkResolutionFailures(resolved);
    let failed = resolutionFailed;
    let succeeded = 0;
    if (resolved.rows.length > 0) {
      const marked = await query<{ id: number }>(
        `UPDATE pages SET embedding_dirty = TRUE
          WHERE id = ANY($1::int[]) AND deleted_at IS NULL
          RETURNING id`,
        [resolved.rows.map((r) => r.id)],
      );
      succeeded = marked.rows.length;
      // A row trashed or purged after the resolver read it gets the answer it
      // would have got a moment earlier, so every resolved row lands in exactly
      // one of `succeeded` and `failed`.
      const markedIds = new Set(marked.rows.map((r) => r.id));
      for (const row of resolved.rows) {
        if (markedIds.has(row.id)) continue;
        failed++;
        errors.push(`Page ${row.source === 'standalone' ? row.id : (row.confluenceId ?? row.id)} not found`);
      }
    }

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
    // A request that itself names two AI policies is the frozen 422
    // `ai_policy_label_conflict` body for the whole batch (#280/#281) — the
    // same wire shape as every other label writer — not a per-row failure
    // line in the report. Nothing is written.
    try {
      planLabelPolicyChange({ currentPolicy: 'all', currentLabels: [], targetLabels: addTags });
    } catch (err) {
      if (isAiPolicyRefusal(err)) return sendAiPolicyRefusal(reply, err);
      if (err instanceof PageWriteError) throw fastify.httpErrors.unprocessableEntity(err.message);
      throw err;
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
    try {
      const target = (labels: readonly string[]) =>
        [...new Set([...labels.filter((label) => !removeTags.includes(label)), ...addTags])];
      if (await preflightBulkLabelPolicies(userId, resolved.rows, resolutionFailed, target)) {
        const result = await publishBulkPolicyLabels(userId, resolved.rows, target, 'pages.bulk.tags');
        await cache.invalidateAcrossUsers('pages');
        await logAuditEvent(userId, 'BULK_PAGE_TAGGED', 'page', undefined,
          { affectedCount: resolved.rows.length, addTags, removeTags, ...result }, request);
        return result;
      }
    } catch (err) {
      if (isAiPolicyRefusal(err)) return sendAiPolicyRefusal(reply, err);
      throw err;
    }
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
            // The policy consequence is planned from the admitted row before
            // the intent and the provider call (#281); the PLANNED set (not
            // the raw request) is what Confluence and the local row receive.
            const plan = await withPageWriteTransaction(
              [numericPageId],
              (writeClient) => planAuthorizedLabelWrite(writeClient, numericPageId, userId, labels),
            );
            const targetLabels = plan.labels;
            const targetLabelsSha256 = createHash('sha256')
              .update(JSON.stringify(targetLabels))
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
                targetLabels,
              },
            });
            let admittedClient: ConfluenceClient;
            try {
              admittedClient = await withPageWriteTransaction(
                [numericPageId],
                async (writeClient) => {
                  await lockAiPolicyForPages(writeClient, [numericPageId]);
                  const confluence = await loadCurrentConfluenceWriteClient(
                    writeClient, tagIntent, numericPageId, userId, pageInfo.confluenceId!,
                  );
                  const replan = await planAuthorizedLabelWrite(writeClient, numericPageId, userId, labels);
                  assertPublishedLabelsMirrored(replan.labels, targetLabels, 'stale_content_revision');
                  return confluence;
                },
                { intent: tagIntent },
              );
            } catch (error) {
              await cancelPageWriteIntentBeforeEffect(tagIntent);
              throw error;
            }
            const delta = remoteLabelDelta(pageInfo.labels, targetLabels);
            await runPageWriteIntentEffect(
              tagIntent,
              { kind: 'remote', completesRemoteWork: true },
              async () => {
                if (delta.add.length > 0) {
                  await admittedClient.addLabels(pageInfo.confluenceId!, delta.add);
                }
                for (const label of delta.remove) {
                  await admittedClient.removeLabel(pageInfo.confluenceId!, label);
                }
              },
            );
            await completePageWriteIntent(tagIntent, async (writeClient) => {
              await lockAiPolicyForPages(writeClient, [numericPageId]);
              await loadAuthorizedContentWriteState(
                writeClient, numericPageId, userId, tagIntent.revisions[numericPageId]!,
              );
              const applied = await applyPageLabelsOnClient(writeClient, {
                userId, pageId: numericPageId, targetLabels,
              });
              assertPublishedLabelsMirrored(applied.labels, targetLabels);
              await enqueuePageWriteInvalidation(writeClient, tagIntent.id);
              return applied;
            });
            
          } else {
            await withPageWriteTransaction([numericPageId], async (writeClient) => {
              await lockAiPolicyForPages(writeClient, [numericPageId]);
              await loadAuthorizedContentWriteState(writeClient, numericPageId, userId, {
                contentRevision: pageInfo.contentRevision,
                lifecycleRevision: pageInfo.lifecycleRevision,
              });
              return applyPageLabelsOnClient(writeClient, { userId, pageId: numericPageId, targetLabels: labels });
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
    // A replacement set naming two AI policies is the frozen 422
    // `ai_policy_label_conflict` body for the batch (#280/#281); nothing is
    // written.
    try {
      planLabelPolicyChange({ currentPolicy: 'all', currentLabels: [], targetLabels: normTags });
    } catch (err) {
      if (isAiPolicyRefusal(err)) return sendAiPolicyRefusal(reply, err);
      if (err instanceof PageWriteError) throw fastify.httpErrors.unprocessableEntity(err.message);
      throw err;
    }

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
    try {
      if (await preflightBulkLabelPolicies(userId, eligible, initialFailed, () => normTags)) {
        const result = await publishBulkPolicyLabels(userId, eligible, () => normTags, 'pages.bulk.replace_tags');
        await cache.invalidateAcrossUsers('pages');
        await logAuditEvent(userId, 'BULK_PAGE_TAGS_REPLACED', 'page', undefined,
          { affectedCount: eligible.length, tags: normTags, ...result }, request);
        return { ...result, cancelled: false, ...(jobId ? { jobId } : {}) };
      }
    } catch (err) {
      if (isAiPolicyRefusal(err)) return sendAiPolicyRefusal(reply, err);
      throw err;
    }

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
              // Planned from the admitted row before the intent and the
              // provider call (#281): a replace that drops the canonical
              // policy label keeps it; a contradiction never reaches Confluence.
              const plan = await withPageWriteTransaction(
                [page.id],
                (writeClient) => planAuthorizedLabelWrite(writeClient, page.id, userId, normTags),
              );
              const targetLabels = plan.labels;
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
                    .update(JSON.stringify(targetLabels))
                    .digest('hex'),
                  priorLabels: page.labels,
                  targetLabels,
                },
              });
              let admittedClient: ConfluenceClient;
              try {
                admittedClient = await withPageWriteTransaction(
                  [page.id],
                  async (writeClient) => {
                    await lockAiPolicyForPages(writeClient, [page.id]);
                    const confluence = await loadCurrentConfluenceWriteClient(
                      writeClient, tagIntent, page.id, userId, page.confluenceId!,
                    );
                    const replan = await planAuthorizedLabelWrite(writeClient, page.id, userId, normTags);
                    assertPublishedLabelsMirrored(replan.labels, targetLabels, 'stale_content_revision');
                    return confluence;
                  },
                  { intent: tagIntent },
                );
              } catch (error) {
                await cancelPageWriteIntentBeforeEffect(tagIntent);
                throw error;
              }
              const delta = remoteLabelDelta(page.labels, targetLabels);
              await runPageWriteIntentEffect(
                tagIntent,
                { kind: 'remote', completesRemoteWork: true },
                async () => {
                  if (delta.add.length > 0) await admittedClient.addLabels(page.confluenceId!, delta.add);
                  for (const label of delta.remove) {
                    await admittedClient.removeLabel(page.confluenceId!, label);
                  }
                },
              );
              await completePageWriteIntent(tagIntent, async (writeClient) => {
                await lockAiPolicyForPages(writeClient, [page.id]);
                await loadAuthorizedContentWriteState(
                  writeClient, page.id, userId, tagIntent.revisions[page.id]!,
                );
                const applied = await applyPageLabelsOnClient(writeClient, {
                  userId, pageId: page.id, targetLabels,
                });
                assertPublishedLabelsMirrored(applied.labels, targetLabels);
                await enqueuePageWriteInvalidation(writeClient, tagIntent.id);
                return applied;
              });
              
            } else {
              await withPageWriteTransaction([page.id], async (writeClient) => {
                await lockAiPolicyForPages(writeClient, [page.id]);
                await loadAuthorizedContentWriteState(writeClient, page.id, userId, {
                  contentRevision: page.contentRevision,
                  lifecycleRevision: page.lifecycleRevision,
                });
                return applyPageLabelsOnClient(writeClient, { userId, pageId: page.id, targetLabels: normTags });
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

  // SPEC-CORE-003: article AI policy mutation endpoints.
  await pageAiPolicyRoutes(fastify);
}
