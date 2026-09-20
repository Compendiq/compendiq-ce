import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  BaselineAttachmentSchema,
  BaselinePageIdentitySchema,
  PageBaselineEvidenceSchema,
  PageFreezeDetailFieldsSchema,
  PageFreezePreviewResponseSchema,
  PageLifecycleEventSchema,
  type BaselineAttachmentWire,
  type FreezePageRequest,
  type PageBaselineActivationState,
  type PageBaselineEvidence,
  type PageFreezeHistoryResponse,
  type PageFreezePreviewResponse,
  type PageFreezeSummary,
  type PageLifecycleDenialReason,
  type PageLifecycleState,
  type ReportedBaselineSignatory,
  type UnfreezePageRequest,
} from '@compendiq/contracts';
import { PAGE_GOVERNANCE_POLICY_LOCK_KEY } from '../db/advisory-locks.js';
import { getPool } from '../db/postgres.js';
import { logger } from '../utils/logger.js';
import {
  getUserAccessibleSpaces,
  isSystemAdmin,
  userCanAccessPage,
  userHasPermission,
} from './rbac-service.js';
import {
  advancePageWriteIntent,
  assertPageFreezeIdle,
  completePageWriteIntent,
  getPageWriterRuntimeId,
  lockPageLifecycle,
  lockPageWriterRuntime,
  registerPageWriteIntentReconciler,
  reservePageWriteIntentInTransaction,
  type PageWriteIntent,
  type PageWriteIntentReconciler,
  type PageWriteRecoveryIntent,
} from './page-write-admission.js';
import {
  baselineAttachmentByIdentity,
  baselineManifestSourcePageIds,
  PageBaselineManifestError,
  assertBaselineRetentionCapacity,
  inspectBaselineManifest,
  isBaselinePreparationAbsent,
  readBaselineAttachment,
  removeBaselinePreparation,
  renderBaselineBodyHtml,
  retainBaselineManifest,
  verifyBaselineAttachments,
  type BaselineAttachment,
  type PreparedBaselineManifest,
} from './page-baseline-manifest.js';
import {
  getPageBaselineDeploymentReadiness,
  getPageBaselineGovernanceHook,
  readPageGovernanceMarker,
  type PageBaselineGovernanceActor,
  type PageBaselineGovernancePage,
} from './page-baseline-governance.js';
import {
  enqueuePageLifecycleEvent,
  kickPageLifecycleOutbox,
} from './page-baseline-outbox.js';

const DEFAULT_MAX_RETAINED_BYTES = 50 * 1024 * 1024 * 1024;

export class PageBaselineError extends Error {
  readonly statusCode: number;
  readonly reason: string;
  readonly state?: PageLifecycleState;

  constructor(
    statusCode: number,
    reason: string,
    message: string,
    state?: PageLifecycleState,
  ) {
    super(message);
    this.name = 'PageBaselineError';
    this.statusCode = statusCode;
    this.reason = reason;
    this.state = state;
  }
}

export interface PageFreezeSummaryRow {
  baseline_id?: string | null;
  frozen_version?: number | null;
}

export function freezeSummary(row: PageFreezeSummaryRow): PageFreezeSummary {
  const baselineId = row.baseline_id ?? null;
  return {
    isFrozen: baselineId !== null,
    baselineId,
    frozenVersion: baselineId === null ? null : row.frozen_version ?? null,
  };
}

interface ActorRow {
  id: string;
  display_name: string | null;
  username: string;
}

interface PageRow extends PageFreezeSummaryRow {
  id: number;
  space_key: string | null;
  source: string;
  visibility: string;
  created_by_user_id: string | null;
  deleted_at: Date | null;
  inherit_perms: boolean;
  version: number;
  title: string;
  body_html: string | null;
  body_storage: string | null;
  body_text: string | null;
  labels: string[];
  content_revision: string;
  lifecycle_revision: string;
  frozen_at: Date | null;
  frozen_by_user_id: string | null;
  frozen_by_name: string | null;
  freeze_reason: string | null;
  freeze_provenance: 'manual_assertion' | 'authenticated_approval' | null;
}

interface BaselineRow {
  id: string;
  page_id: number | null;
  original_page_id: number;
  page_identity: unknown;
  version: number;
  content_revision: string;
  lifecycle_revision: string;
  manifest_version: 1;
  manifest_digest: string;
  manifest: unknown[];
  manifest_bytes: Buffer;
  title: string;
  body_html: string | null;
  body_storage: string | null;
  body_text: string | null;
  labels: string[];
  parent_identity: unknown[] | null;
  icon: unknown;
  attachments: unknown;
  total_bytes: string;
  reserved_bytes: string;
  status: 'preparing' | 'prepared' | 'published' | 'abandoned';
  preparation_intent_id: string;
  prepared_by_user_id: string | null;
  prepared_by_name: string;
  published_by_user_id: string | null;
  published_by_name: string | null;
  published_at: Date | null;
  provenance: 'manual_assertion' | 'authenticated_approval' | null;
  freeze_reason: string | null;
  reported_signatories: unknown;
  reported_reference: string | null;
}

async function loadActiveActor(client: PoolClient, actorId: string): Promise<ActorRow> {
  const result = await client.query<ActorRow>(
    `SELECT id, display_name, username
       FROM users
      WHERE id = $1 AND deactivated_at IS NULL`,
    [actorId],
  );
  const actor = result.rows[0];
  if (!actor) {
    throw new PageBaselineError(403, 'not_authorized', 'The active actor could not be authorized');
  }
  return actor;
}

function actorName(actor: ActorRow): string {
  return actor.display_name?.trim() || actor.username;
}

async function loadPage(client: PoolClient, pageId: number, forUpdate = false): Promise<PageRow> {
  const result = await client.query<PageRow>(
    `SELECT id, space_key, source, visibility, created_by_user_id, deleted_at,
            inherit_perms, version, title, body_html, body_storage, body_text,
            COALESCE(labels, '{}') AS labels,
            content_revision::text, lifecycle_revision::text,
            baseline_id, frozen_version, frozen_at, frozen_by_user_id,
            frozen_by_name, freeze_reason, freeze_provenance
       FROM pages
      WHERE id = $1
      ${forUpdate ? 'FOR UPDATE' : ''}`,
    [pageId],
  );
  const page = result.rows[0];
  if (!page) throw new PageBaselineError(404, 'page_not_found', 'Page not found');
  return page;
}

async function assertPageVisible(
  client: PoolClient,
  page: PageRow,
  actorId: string,
): Promise<void> {
  if (!page.deleted_at && await userCanAccessPage(actorId, page.id, client)) return;

  // A soft-deleted page is only identified to an actor who could administer it;
  // everyone else receives the same 404 as a missing page.
  const admin = await isSystemAdmin(actorId, client);
  const owner = page.source === 'standalone' && page.created_by_user_id === actorId;
  const manager = page.space_key
    ? await userHasPermission(actorId, 'manage', page.space_key, page.id, client)
    : false;
  if (page.deleted_at && (admin || owner || manager)) return;
  throw new PageBaselineError(404, 'page_not_found', 'Page not found');
}

async function authority(
  client: PoolClient,
  page: PageRow,
  actorId: string,
): Promise<{ canFreeze: boolean; canUnfreeze: boolean }> {
  const admin = await isSystemAdmin(actorId, client);
  const manager = page.space_key
    ? await userHasPermission(actorId, 'manage', page.space_key, page.id, client)
    : false;
  const owner = page.source === 'standalone' && page.created_by_user_id === actorId;
  return { canFreeze: admin || manager || owner, canUnfreeze: admin || manager };
}

async function activationRow(client: PoolClient): Promise<{
  creation_enabled: boolean;
  activated_at: Date | null;
  activated_by_user_id: string | null;
  activated_by_name: string | null;
}> {
  const result = await client.query<{
    creation_enabled: boolean;
    activated_at: Date | null;
    activated_by_user_id: string | null;
    activated_by_name: string | null;
  }>(
    `SELECT creation_enabled, activated_at, activated_by_user_id, activated_by_name
       FROM page_baseline_feature_state
      WHERE singleton = TRUE`,
  );
  const row = result.rows[0];
  if (!row) throw new PageBaselineError(503, 'baseline_configuration_error', 'Baseline activation state is unavailable');
  return row;
}

async function assertCreationAvailable(client: PoolClient): Promise<void> {
  const activation = await activationRow(client);
  if (!activation.creation_enabled) {
    throw new PageBaselineError(503, 'baseline_creation_disabled', 'Baseline creation is disabled');
  }
  const readiness = await getPageBaselineDeploymentReadiness();
  if (!readiness.ready) {
    throw new PageBaselineError(503, 'deployment_not_ready', 'Baseline writer enforcement is not ready');
  }
}

async function governanceCapabilities(
  client: PoolClient,
  page: PageRow,
  actor: ActorRow,
): Promise<{
  governed: boolean;
  proposalStatus: PageLifecycleState['governanceProposalStatus'];
  canApprove: boolean;
  approveDeniedReason: PageLifecycleDenialReason | null;
}> {
  const marker = await readPageGovernanceMarker(client, page.space_key);
  if (!marker.enabled) {
    return { governed: false, proposalStatus: 'none', canApprove: false, approveDeniedReason: null };
  }
  const hook = getPageBaselineGovernanceHook();
  if (!hook) {
    return {
      governed: true,
      proposalStatus: 'unavailable',
      canApprove: false,
      approveDeniedReason: 'governance_unavailable',
    };
  }
  try {
    const result = await hook.capabilities({
      client,
      page: governancePage(page),
      actor: governanceActor(actor),
    });
    return {
      governed: true,
      proposalStatus: result.proposalStatus,
      canApprove: result.canApprove,
      approveDeniedReason: result.approveDeniedReason,
    };
  } catch {
    return {
      governed: true,
      proposalStatus: 'unavailable',
      canApprove: false,
      approveDeniedReason: 'governance_unavailable',
    };
  }
}

function governancePage(page: PageRow): PageBaselineGovernancePage {
  return {
    id: page.id,
    spaceKey: page.space_key,
    source: page.source,
    createdByUserId: page.created_by_user_id,
    contentRevision: page.content_revision,
    lifecycleRevision: page.lifecycle_revision,
  };
}

function governanceActor(actor: ActorRow): PageBaselineGovernanceActor {
  return { id: actor.id, displayName: actorName(actor) };
}

export async function getPageLifecycleState(
  client: PoolClient,
  pageId: number,
  actorId: string,
): Promise<PageLifecycleState> {
  const actor = await loadActiveActor(client, actorId);
  const page = await loadPage(client, pageId);
  await assertPageVisible(client, page, actorId);
  if (page.deleted_at) {
    throw new PageBaselineError(409, 'page_deleted', 'A deleted page cannot be frozen');
  }

  const permissions = await authority(client, page, actorId);
  const canMutateContent = page.source === 'standalone'
    ? page.created_by_user_id === actorId || page.visibility === 'shared'
    : !page.space_key || (await getUserAccessibleSpaces(actorId, client)).includes(page.space_key);
  const activation = await activationRow(client);
  const readiness = await getPageBaselineDeploymentReadiness();
  const governance = await governanceCapabilities(client, page, actor);
  const summary = freezeSummary(page);

  let freezeDeniedReason: PageLifecycleDenialReason | null = null;
  if (summary.isFrozen) freezeDeniedReason = 'page_is_frozen';
  else if (!permissions.canFreeze) freezeDeniedReason = 'not_authorized';
  else if (!activation.creation_enabled) freezeDeniedReason = 'baseline_creation_disabled';
  else if (!readiness.ready) freezeDeniedReason = 'deployment_not_ready';
  else if (governance.governed) freezeDeniedReason = governance.proposalStatus === 'unavailable'
    ? 'governance_unavailable'
    : 'governance_required';

  let unfreezeDeniedReason: PageLifecycleDenialReason | null = null;
  if (!summary.isFrozen) unfreezeDeniedReason = 'page_not_frozen';
  else if (!permissions.canUnfreeze) unfreezeDeniedReason = 'not_authorized';

  const state = {
    ...summary,
    frozenAt: page.frozen_at?.toISOString() ?? null,
    frozenBy: page.frozen_by_user_id,
    frozenByName: page.frozen_by_name,
    freezeReason: page.freeze_reason,
    provenance: page.freeze_provenance,
    contentRevision: page.content_revision,
    lifecycleRevision: page.lifecycle_revision,
    canFreeze: freezeDeniedReason === null,
    freezeDeniedReason,
    canUnfreeze: unfreezeDeniedReason === null,
    unfreezeDeniedReason,
    canApprove: governance.canApprove,
    approveDeniedReason: governance.approveDeniedReason,
    canMutateContent: !summary.isFrozen && canMutateContent,
    mutateContentDeniedReason: summary.isFrozen
      ? 'page_is_frozen' as const
      : canMutateContent ? null : 'not_authorized' as const,
    governanceProposalStatus: governance.proposalStatus,
    pendingDivergence: null,
  };
  return PageFreezeDetailFieldsSchema.parse(state);
}

function maxRetainedBytes(): number {
  const raw = process.env.PAGE_BASELINE_MAX_RETAINED_BYTES;
  if (!raw) return DEFAULT_MAX_RETAINED_BYTES;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new PageBaselineError(503, 'baseline_configuration_error', 'Invalid baseline retained-byte capacity');
  }
  return value;
}

function manifestError(err: unknown): PageBaselineError {
  if (err instanceof PageBaselineError) return err;
  if (err instanceof PageBaselineManifestError) {
    return new PageBaselineError(err.statusCode, err.reason, err.message);
  }
  throw err;
}

async function inspectManifest(
  client: PoolClient,
  pageId: number,
  baselineId: string,
  actorId: string,
): Promise<PreparedBaselineManifest> {
  try {
    return await inspectBaselineManifest(client, pageId, baselineId, actorId);
  } catch (err) {
    throw manifestError(err);
  }
}

function retainedAttachments(value: unknown): BaselineAttachment[] {
  if (!Array.isArray(value)) {
    throw new PageBaselineError(500, 'baseline_evidence_invalid', 'Stored attachment inventory is invalid');
  }
  return value.map((item) => {
    if (!item || typeof item !== 'object') {
      throw new PageBaselineError(500, 'baseline_evidence_invalid', 'Stored attachment inventory is invalid');
    }
    const record = item as Record<string, unknown>;
    const parsed = BaselineAttachmentSchema.safeParse({
      identity: record.identity,
      store: record.store,
      pageKey: record.pageKey,
      filename: record.filename,
      size: record.size,
      mediaType: record.mediaType,
      sha256: record.sha256,
    });
    if (!parsed.success) {
      throw new PageBaselineError(500, 'baseline_evidence_invalid', 'Stored attachment inventory is invalid');
    }
    const wire = parsed.data;
    if (typeof record.retainedPath !== 'string' || record.retainedPath.length === 0) {
      throw new PageBaselineError(500, 'baseline_evidence_invalid', 'Stored retained attachment path is invalid');
    }
    return { ...wire, retainedPath: record.retainedPath };
  });
}

function storedBaselineAttachment(
  baselineId: string,
  value: unknown,
  identity: string,
): BaselineAttachment | null {
  try {
    return baselineAttachmentByIdentity(baselineId, value, identity);
  } catch (err) {
    throw manifestError(err);
  }
}

function wireAttachments(value: unknown): BaselineAttachmentWire[] {
  return retainedAttachments(value).map(({ retainedPath: _retainedPath, ...attachment }) => attachment);
}

function previewResponse(row: BaselineRow): PageFreezePreviewResponse {
  const parsed = PageFreezePreviewResponseSchema.safeParse({
    baselineId: row.id,
    pageId: row.original_page_id,
    version: row.version,
    contentRevision: row.content_revision,
    manifestVersion: 1,
    manifestDigest: row.manifest_digest,
    attachments: wireAttachments(row.attachments),
    totalBytes: Number(row.total_bytes),
  });
  if (!parsed.success) {
    throw new PageBaselineError(500, 'baseline_evidence_invalid', 'Prepared baseline evidence is invalid');
  }
  return parsed.data;
}

async function abandonPreparations(
  client: PoolClient,
  baselineIds: readonly string[],
): Promise<void> {
  if (baselineIds.length === 0) return;
  const updated = await client.query(
    `UPDATE page_baselines
        SET status = 'abandoned', abandoned_at = NOW()
      WHERE id = ANY($1::uuid[]) AND status IN ('preparing', 'prepared')`,
    [baselineIds],
  );
  if (updated.rowCount !== baselineIds.length) {
    throw new PageBaselineError(409, 'stale_manifest', 'A baseline preparation changed concurrently');
  }
}

export async function cleanupAbandonedBaselinePreparation(baselineId: string): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const reservation = await client.query<{ page_ids: number[] }>(
      `SELECT i.page_ids
         FROM page_baselines b
         JOIN page_write_intents i ON i.id = b.preparation_intent_id
        WHERE b.id = $1 AND i.kind = 'baseline.prepare'`,
      [baselineId],
    );
    if (!reservation.rows[0]) {
      throw new PageBaselineError(409, 'baseline_cleanup_forbidden', 'Baseline preparation is not eligible for cleanup');
    }
    // The intent's target set is immutable, including after recovery transfer.
    // Maintenance follows the repair path's lifecycle-before-baseline row order.
    await lockPageLifecycle(client, reservation.rows[0].page_ids);
    await removeBaselinePreparation(client, baselineId);
    const deleted = await client.query<{ reserved_bytes: string }>(
      `DELETE FROM page_baselines
        WHERE id = $1 AND status = 'abandoned'
        RETURNING reserved_bytes::text`,
      [baselineId],
    );
    const reservedBytes = deleted.rows[0]?.reserved_bytes;
    if (reservedBytes === undefined) {
      throw new PageBaselineError(409, 'baseline_cleanup_forbidden', 'Baseline preparation is not eligible for cleanup');
    }
    const released = await client.query(
      `UPDATE page_baseline_capacity
          SET reserved_bytes = reserved_bytes - $1::bigint, updated_at = NOW()
        WHERE singleton = TRUE AND reserved_bytes >= $1::bigint`,
      [reservedBytes],
    );
    if (released.rowCount !== 1) {
      throw new PageBaselineError(500, 'baseline_capacity_invalid', 'Baseline capacity accounting is inconsistent');
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw manifestError(err);
  } finally {
    client.release();
  }
}
export async function cleanupAbandonedBaselinePreparations(limit = 25): Promise<number> {
  // The reservation commits before copying starts. A settled no-start
  // cancellation is durable absence evidence, not an age-based expiry.
  await getPool().query(
    `UPDATE page_baselines b
        SET status = 'abandoned', abandoned_at = NOW()
      WHERE (b.status = 'prepared'
             AND (b.prepared_by_user_id IS NULL OR b.page_id IS NULL))
         OR (b.status = 'preparing' AND EXISTS (
           SELECT 1 FROM page_write_intents i
            WHERE i.id = b.preparation_intent_id
              AND i.kind = 'baseline.prepare' AND i.status = 'cancelled'
              AND i.settled_at IS NOT NULL
              AND i.effect_started_at IS NULL
              AND i.remote_effect_started_at IS NULL
         ))`,
  );
  const selected = await getPool().query<{ id: string }>(
    `SELECT id FROM page_baselines
      WHERE status = 'abandoned'
      ORDER BY abandoned_at, id
      LIMIT $1`,
    [Math.max(1, Math.min(limit, 100))],
  );
  let cleaned = 0;
  for (const row of selected.rows) {
    try {
      await cleanupAbandonedBaselinePreparation(row.id);
      cleaned += 1;
    } catch (err) {
      logger.warn({ err, baselineId: row.id }, 'Abandoned baseline cleanup deferred');
    }
  }
  return cleaned;
}

/** Callers already hold the intent and its original page-revision locks. */
async function loadBaselineRecoveryReservation(client: PoolClient, intent: PageWriteRecoveryIntent) {
  const sourcePageIds = Array.isArray(intent.effect.sourcePageIds) ? intent.effect.sourcePageIds : null;
  const { baselineId, pageId, manifestDigest, totalBytes } = intent.effect;
  if (
    typeof baselineId !== 'string'
    || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(baselineId)
    || typeof pageId !== 'number' || !Number.isSafeInteger(pageId) || pageId <= 0
    || typeof manifestDigest !== 'string' || !/^[a-f0-9]{64}$/.test(manifestDigest)
    || typeof totalBytes !== 'number' || !Number.isSafeInteger(totalBytes) || totalBytes < 0
    || !sourcePageIds
    || sourcePageIds.some((id) => typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0)
    || new Set(sourcePageIds).size !== sourcePageIds.length
    || !samePageIds(sourcePageIds, [...sourcePageIds].sort((left, right) => left - right))
    || !samePageIds(sourcePageIds, intent.pageIds)
    || !intent.pageIds.includes(pageId)
  ) {
    throw new PageBaselineError(409, 'baseline_recovery_invalid', 'Baseline recovery metadata is invalid');
  }
  const result = await client.query<BaselineRow>(
    'SELECT * FROM page_baselines WHERE id = $1 FOR UPDATE',
    [baselineId],
  );
  const row = result.rows[0] ?? null;
  const revision = intent.revisions[pageId];
  if (row && (
    row.preparation_intent_id !== intent.id
    || row.status === 'published'
    || row.manifest_digest !== manifestDigest
    || Number(row.total_bytes) !== totalBytes
    || Number(row.reserved_bytes) !== totalBytes
    || row.original_page_id !== pageId
    || !revision
    || row.content_revision !== revision.contentRevision
    || row.lifecycle_revision !== revision.lifecycleRevision
  )) {
    throw new PageBaselineError(409, 'baseline_recovery_invalid', 'Baseline recovery reservation does not match');
  }
  return { baselineId, manifestDigest, totalBytes, row };
}

async function retainedPreparationVerified(row: BaselineRow, manifestDigest: string, totalBytes: number): Promise<boolean> {
  const attachments = retainedAttachments(row.attachments);
  const attachmentBytes = attachments.reduce((sum, attachment) => sum + attachment.size, 0);
  if (createHash('sha256').update(row.manifest_bytes).digest('hex') !== manifestDigest
    || !Number.isSafeInteger(attachmentBytes) || attachmentBytes !== totalBytes) return false;
  return (await verifyBaselineAttachments(row.id, attachments)).valid;
}

const reconcileBaselinePreparation: PageWriteIntentReconciler = async (client, intent) => {
  const { baselineId, manifestDigest, totalBytes, row } = await loadBaselineRecoveryReservation(client, intent);
  const reference = `page-baselines/${baselineId}`;
  if (!row) {
    if (!await isBaselinePreparationAbsent(baselineId)) {
      throw new PageBaselineError(409, 'baseline_recovery_invalid', 'Unrecorded baseline bytes require investigation');
    }
    return {
      outcome: 'not_applied',
      proof: {
        kind: 'local_effect_absence_verified',
        observedAt: new Date().toISOString(),
        reference,
        details: { syscallSettled: true, observedAbsent: true },
      },
      result: { baselineId, prepared: false },
    };
  }
  if (row.status === 'prepared' && await retainedPreparationVerified(row, manifestDigest, totalBytes)) {
    return {
      outcome: 'applied',
      proof: {
        kind: 'local_bytes_verified',
        observedAt: new Date().toISOString(),
        reference,
        details: {
          syscallSettled: true,
          intendedStateDigest: manifestDigest,
          observedStateDigest: manifestDigest,
          intendedSize: totalBytes,
          observedSize: totalBytes,
        },
      },
      result: { baselineId, prepared: true },
    };
  }
  // No mutation in the verifier: even exact preparing bytes need their state
  // transition tracked by the new recovery owner. Abandoned never promotes.
  return { outcome: 'repair_required', observedState: 'staged_only' };
};

async function repairBaselinePreparation(intent: PageWriteRecoveryIntent): Promise<void> {
  // Core committed ownership transfer and entered the ordinary effect gate
  // before calling this repairer. Keep the original revision fence throughout.
  await advancePageWriteIntent(intent, async (client) => {
    const { baselineId, manifestDigest, totalBytes, row } = await loadBaselineRecoveryReservation(client, intent);
    if (!row || row.status === 'abandoned') return;
    if (await retainedPreparationVerified(row, manifestDigest, totalBytes)) {
      if (row.status === 'preparing') {
        await client.query(
          "UPDATE page_baselines SET status = 'prepared' WHERE id = $1 AND status = 'preparing'",
          [baselineId],
        );
      }
    } else {
      await abandonPreparations(client, [baselineId]);
    }
  });

  // Abandonment above is COMMITTED before any unlink. A crash at any point
  // resumes from abandoned+bytes, abandoned+absence, or no row+absence.
  await advancePageWriteIntent(intent, async (client) => {
    const { baselineId, row } = await loadBaselineRecoveryReservation(client, intent);
    if (!row) {
      if (!await isBaselinePreparationAbsent(baselineId)) {
        throw new PageBaselineError(409, 'baseline_recovery_invalid', 'Unrecorded baseline bytes require investigation');
      }
      return;
    }
    if (row.status === 'prepared') return;
    if (row.status !== 'abandoned') {
      throw new PageBaselineError(409, 'baseline_recovery_invalid', 'Baseline preparation is not ready for cleanup');
    }
    await removeBaselinePreparation(client, baselineId, intent);
    if (!await isBaselinePreparationAbsent(baselineId)) {
      throw new PageBaselineError(409, 'baseline_recovery_invalid', 'Baseline preparation bytes remain after cleanup');
    }
    const deleted = await client.query<{ reserved_bytes: string }>(
      `DELETE FROM page_baselines
        WHERE id = $1 AND status = 'abandoned' AND preparation_intent_id = $2
        RETURNING reserved_bytes::text`,
      [baselineId, intent.id],
    );
    const reservedBytes = deleted.rows[0]?.reserved_bytes;
    if (reservedBytes === undefined) {
      throw new PageBaselineError(409, 'baseline_recovery_invalid', 'Baseline recovery cleanup was not authorized');
    }
    const released = await client.query(
      `UPDATE page_baseline_capacity
          SET reserved_bytes = reserved_bytes - $1::bigint, updated_at = NOW()
        WHERE singleton = TRUE AND reserved_bytes >= $1::bigint`,
      [reservedBytes],
    );
    if (released.rowCount !== 1) {
      throw new PageBaselineError(500, 'baseline_capacity_invalid', 'Baseline capacity accounting is inconsistent');
    }
  });
}

registerPageWriteIntentReconciler('baseline.prepare', reconcileBaselinePreparation, repairBaselinePreparation);

let baselineCleanupTimer: ReturnType<typeof setInterval> | null = null;

export function initPageBaselineMaintenance(
  intervalMs = 60_000,
): () => Promise<void> {
  if (!baselineCleanupTimer) {
    baselineCleanupTimer = setInterval(() => {
      void cleanupAbandonedBaselinePreparations().catch((err) => {
        logger.error({ err }, 'Abandoned baseline cleanup poll failed');
      });
    }, intervalMs);
    void cleanupAbandonedBaselinePreparations().catch((err) => {
      logger.error({ err }, 'Abandoned baseline cleanup startup failed');
    });
  }
  return async () => {
    if (baselineCleanupTimer) {
      clearInterval(baselineCleanupTimer);
      baselineCleanupTimer = null;
    }
  };
}

function samePageIds(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length
    && left.every((pageId, index) => pageId === right[index]);
}

export async function previewPageBaseline(
  pageId: number,
  actorId: string,
): Promise<PageFreezePreviewResponse> {
  const runtimeId = await getPageWriterRuntimeId();
  let lifecyclePageIds: readonly number[] = [pageId];
  for (;;) {
    const client = await getPool().connect();
    let outcome:
      | { kind: 'retry_locks'; pageIds: readonly number[] }
      | { kind: 'reused'; response: PageFreezePreviewResponse }
      | { kind: 'cleanup'; baselineIds: string[] }
      | {
          kind: 'retain';
          preflight: PreparedBaselineManifest;
          intent: PageWriteIntent;
        }
      | null = null;
    let committed = false;
    try {
      await client.query('BEGIN');
      await lockPageWriterRuntime(client, runtimeId);
      await lockPageLifecycle(client, lifecyclePageIds);
      const actor = await loadActiveActor(client, actorId);
      const page = await loadPage(client, pageId, true);
      await assertPageVisible(client, page, actorId);
      if (page.deleted_at) throw new PageBaselineError(409, 'page_deleted', 'A deleted page cannot be frozen');
      if (page.baseline_id) throw new PageBaselineError(423, 'page_is_frozen', 'Page is already frozen');
      const permissions = await authority(client, page, actorId);
      if (!permissions.canFreeze) throw new PageBaselineError(403, 'not_authorized', 'Freeze permission is required');
      await assertCreationAvailable(client);
      for (const lockedPageId of lifecyclePageIds) {
        await assertPageFreezeIdle(client, lockedPageId);
      }

      const active = await client.query<BaselineRow>(
        `SELECT * FROM page_baselines
          WHERE original_page_id = $1 AND prepared_by_user_id = $2
            AND status = 'prepared'
          FOR UPDATE`,
        [pageId, actorId],
      );
      const reusable = active.rows.find((row) =>
        row.content_revision === page.content_revision
        && row.lifecycle_revision === page.lifecycle_revision);
      if (reusable) {
        const current = await inspectManifest(client, pageId, reusable.id, actorId);
        const sourcePageIds = baselineManifestSourcePageIds(current);
        if (!samePageIds(sourcePageIds, lifecyclePageIds)) {
          outcome = { kind: 'retry_locks', pageIds: sourcePageIds };
          await client.query('COMMIT');
          committed = true;
        } else {
          const verification = await verifyBaselineAttachments(
            reusable.id,
            retainedAttachments(reusable.attachments),
          );
          if (
            current.manifestDigest === reusable.manifest_digest
            && current.contentRevision === reusable.content_revision
            && verification.valid
          ) {
            outcome = { kind: 'reused', response: previewResponse(reusable) };
            await client.query('COMMIT');
            committed = true;
          }
        }
      }

      if (!outcome && active.rows.length > 0) {
        const baselineIds = active.rows.map((row) => row.id);
        await abandonPreparations(client, baselineIds);
        outcome = { kind: 'cleanup', baselineIds };
        await client.query('COMMIT');
        committed = true;
      }

      if (!outcome) {
        const baselineId = randomUUID();
        const preflight = await inspectManifest(client, pageId, baselineId, actorId);
        if (preflight.contentRevision !== page.content_revision) {
          throw new PageBaselineError(409, 'stale_manifest', 'Page content changed during baseline inspection');
        }
        const sourcePageIds = baselineManifestSourcePageIds(preflight);
        if (!samePageIds(sourcePageIds, lifecyclePageIds)) {
          outcome = { kind: 'retry_locks', pageIds: sourcePageIds };
          await client.query('COMMIT');
          committed = true;
        } else {
          const capacity = await client.query<{ reserved_bytes: string }>(
            `SELECT reserved_bytes::text FROM page_baseline_capacity
              WHERE singleton = TRUE FOR UPDATE`,
          );
          await assertBaselineRetentionCapacity(client, preflight.totalBytes);
          const current = BigInt(capacity.rows[0]?.reserved_bytes ?? '0');
          const projected = current + BigInt(preflight.totalBytes);
          if (projected > BigInt(maxRetainedBytes())) {
            throw new PageBaselineError(507, 'baseline_capacity_exceeded', 'Retained baseline capacity is exhausted');
          }

          const intent = await reservePageWriteIntentInTransaction(client, {
            pageIds: sourcePageIds,
            kind: 'baseline.prepare',
            actorId,
            effect: {
              effectClass: 'local',
              baselineId,
              pageId,
              sourcePageIds: [...sourcePageIds],
              manifestDigest: preflight.manifestDigest,
              totalBytes: preflight.totalBytes,
            },
          });
          const manifest = preflight.manifest;
          await client.query(
            `INSERT INTO page_baselines (
               id, page_id, original_page_id, page_identity, version,
               content_revision, lifecycle_revision, manifest_digest, manifest,
               manifest_bytes, title, body_html, body_storage, body_text, labels,
               parent_identity, icon, attachments, total_bytes, reserved_bytes,
               status, prepared_by_user_id, prepared_by_name, preparation_intent_id
             ) VALUES (
               $1, $2, $2, $3::jsonb, $4, $5::bigint, $6::bigint, $7, $8::jsonb,
               $9, $10, $11, $12, $13, $14::text[], $15::jsonb, $16::jsonb,
               $17::jsonb, $18::bigint, $18::bigint, 'preparing', $19, $20, $21
             )`,
            [
              baselineId,
              pageId,
              JSON.stringify(manifest[3]),
              preflight.version,
              preflight.contentRevision,
              page.lifecycle_revision,
              preflight.manifestDigest,
              JSON.stringify(manifest),
              preflight.manifestBytes,
              manifest[6],
              manifest[7],
              manifest[8],
              manifest[9],
              manifest[10],
              manifest[11] === null ? null : JSON.stringify(manifest[11]),
              manifest[12] === null ? null : JSON.stringify(manifest[12]),
              JSON.stringify(preflight.attachments),
              preflight.totalBytes,
              actorId,
              actorName(actor),
              intent.id,
            ],
          );
          await client.query(
            `UPDATE page_baseline_capacity
                SET reserved_bytes = $1::bigint, updated_at = NOW()
              WHERE singleton = TRUE`,
            [projected.toString()],
          );
          await client.query('COMMIT');
          committed = true;
          outcome = { kind: 'retain', preflight, intent };
        }
      }
    } catch (err) {
      if (!committed) await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }

    if (!outcome) {
      throw new PageBaselineError(500, 'baseline_preparation_failed', 'Baseline preparation produced no result');
    }
    if (outcome.kind === 'retry_locks') {
      lifecyclePageIds = outcome.pageIds;
      continue;
    }
    if (outcome.kind === 'reused') return outcome.response;
    if (outcome.kind === 'cleanup') {
      for (const baselineId of outcome.baselineIds) {
        await cleanupAbandonedBaselinePreparation(baselineId);
      }
      continue;
    }

    const { preflight, intent } = outcome;
    try {
      await retainBaselineManifest(preflight, intent);
    } catch (err) {
      throw manifestError(err);
    }
    return completePageWriteIntent(intent, async (completionClient) => {
      const verification = await verifyBaselineAttachments(
        preflight.baselineId,
        preflight.attachments,
      );
      if (!verification.valid) {
        throw new PageBaselineError(409, 'retained_bytes_invalid', 'Prepared baseline media is incomplete');
      }
      const completed = await completionClient.query<BaselineRow>(
        `UPDATE page_baselines
            SET status = 'prepared'
          WHERE id = $1 AND status = 'preparing' AND preparation_intent_id = $2
          RETURNING *`,
        [preflight.baselineId, intent.id],
      );
      const row = completed.rows[0];
      if (!row) {
        throw new PageBaselineError(409, 'stale_manifest', 'Baseline preparation changed concurrently');
      }
      return previewResponse(row);
    });
  }
}

export interface FreezePageServiceInput extends FreezePageRequest {
  pageId: number;
  actorId: string;
}

interface PublishFreezeInput extends FreezePageServiceInput {
  governedProposalId?: string;
}

export async function freezePage(input: FreezePageServiceInput): Promise<PageLifecycleState> {
  return publishFreeze(input);
}

export async function finalizeGovernedPageBaseline(
  input: FreezePageServiceInput & { governedProposalId: string },
): Promise<PageLifecycleState> {
  return publishFreeze(input);
}

interface RetryFreezeLocks {
  retryPageIds: readonly number[];
}

async function publishFreeze(input: PublishFreezeInput): Promise<PageLifecycleState> {
  let lifecyclePageIds: readonly number[] = [input.pageId];
  for (;;) {
    const outcome = await publishFreezeLocked(input, lifecyclePageIds);
    if ('retryPageIds' in outcome) {
      lifecyclePageIds = outcome.retryPageIds;
      continue;
    }
    return outcome;
  }
}

async function publishFreezeLocked(
  input: PublishFreezeInput,
  lifecyclePageIds: readonly number[],
): Promise<PageLifecycleState | RetryFreezeLocks> {
  const runtimeId = await getPageWriterRuntimeId();
  const client = await getPool().connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    await lockPageWriterRuntime(client, runtimeId, { newAdmission: true });
    await lockPageLifecycle(client, lifecyclePageIds, { tryLock: true });
    await loadActiveActor(client, input.actorId);
    let page = await loadPage(client, input.pageId, true);
    await assertPageVisible(client, page, input.actorId);
    if (page.deleted_at) throw new PageBaselineError(409, 'page_deleted', 'A deleted page cannot be frozen');
    const permissions = await authority(client, page, input.actorId);
    if (!permissions.canFreeze) throw new PageBaselineError(403, 'not_authorized', 'Freeze permission is required');

    if (page.baseline_id) {
      throw new PageBaselineError(423, 'page_is_frozen', 'Page is already frozen');
    }

    await assertCreationAvailable(client);
    for (const lockedPageId of lifecyclePageIds) {
      await assertPageFreezeIdle(client, lockedPageId);
    }
    if (page.content_revision !== input.expectedContentRevision) {
      throw new PageBaselineError(409, 'stale_manifest', 'The preview content revision is stale');
    }

    const preparedResult = await client.query<BaselineRow>(
      `SELECT * FROM page_baselines
        WHERE original_page_id = $1 AND prepared_by_user_id = $2
          AND manifest_digest = $3 AND content_revision = $4::bigint
          AND status = 'prepared'
        FOR UPDATE`,
      [input.pageId, input.actorId, input.expectedManifestDigest, input.expectedContentRevision],
    );
    const prepared = preparedResult.rows[0];
    if (!prepared) throw new PageBaselineError(409, 'stale_manifest', 'No matching active baseline preview exists');
    if (prepared.lifecycle_revision !== page.lifecycle_revision) {
      throw new PageBaselineError(409, 'stale_lifecycle', 'The page lifecycle changed after preview');
    }

    // Re-read and hash current source bytes under the lifecycle lock without
    // creating another retained attempt. The preview copy remains the stable
    // evidence selected by its digest.
    const current = await inspectManifest(client, input.pageId, prepared.id, input.actorId);
    const sourcePageIds = baselineManifestSourcePageIds(current);
    if (!samePageIds(sourcePageIds, lifecyclePageIds)) {
      await client.query('COMMIT');
      committed = true;
      return { retryPageIds: sourcePageIds };
    }
    if (
      current.manifestDigest !== prepared.manifest_digest
      || current.contentRevision !== prepared.content_revision
    ) {
      throw new PageBaselineError(409, 'stale_manifest', 'The page or referenced media changed after preview');
    }
    const retained = retainedAttachments(prepared.attachments);
    const verification = await verifyBaselineAttachments(prepared.id, retained);
    if (!verification.valid) {
      throw new PageBaselineError(409, 'retained_bytes_invalid', 'Prepared baseline media is incomplete');
    }

    // The manifest preparation can be long-running. Recheck active identity,
    // visibility, role/group/ACE authority and the persisted governance marker
    // immediately before the atomic publication.
    const finalActor = await loadActiveActor(client, input.actorId);
    page = await loadPage(client, input.pageId, true);
    await assertPageVisible(client, page, input.actorId);
    const finalPermissions = await authority(client, page, input.actorId);
    if (!finalPermissions.canFreeze) throw new PageBaselineError(403, 'not_authorized', 'Freeze permission changed');
    if (page.baseline_id) throw new PageBaselineError(423, 'page_is_frozen', 'Page is already frozen');
    if (page.content_revision !== prepared.content_revision) {
      throw new PageBaselineError(409, 'stale_manifest', 'The page content changed after preview');
    }
    if (page.lifecycle_revision !== prepared.lifecycle_revision) {
      throw new PageBaselineError(409, 'stale_lifecycle', 'The page lifecycle changed after preview');
    }

    const marker = await readPageGovernanceMarker(client, page.space_key, { lock: 'shared' });
    let provenance: 'manual_assertion' | 'authenticated_approval' = 'manual_assertion';
    if (marker.enabled) {
      if (!input.governedProposalId) {
        throw new PageBaselineError(409, 'governance_required', 'This space requires authenticated approval');
      }
      const hook = getPageBaselineGovernanceHook();
      if (!hook) {
        throw new PageBaselineError(503, 'governance_unavailable', 'Governance finalization is unavailable');
      }
      const manifest = {
        baselineId: prepared.id,
        manifest: prepared.manifest,
        manifestBytes: prepared.manifest_bytes,
        manifestDigest: prepared.manifest_digest,
        contentRevision: prepared.content_revision,
      };
      const evidence = await hook.prepareEvidence({
        client,
        page: governancePage(page),
        actor: governanceActor(finalActor),
        proposalId: input.governedProposalId,
        manifest,
      });
      const finalized = await hook.authorizeAndFinalize({
        client,
        page: governancePage(page),
        actor: governanceActor(finalActor),
        proposalId: input.governedProposalId,
        manifest,
        prepared: evidence,
      });
      if (
        finalized.provenance !== 'authenticated_approval'
        || (evidence.signingRequired && !finalized.signingSatisfied)
        || (evidence.archiveRequired && !finalized.archiveSatisfied)
      ) {
        throw new PageBaselineError(503, 'governance_evidence_incomplete', 'Required signing or archive evidence is incomplete');
      }
      provenance = 'authenticated_approval';
    } else if (input.governedProposalId) {
      throw new PageBaselineError(409, 'governance_policy_changed', 'The governed finalization policy is no longer active');
    }

    const snapshot = await reconcileVersionSnapshot(client, page, prepared);
    const updated = await client.query<{ lifecycle_revision: string }>(
      `UPDATE pages
          SET baseline_id = $2,
              frozen_version = $3,
              frozen_at = NOW(),
              frozen_by_user_id = $4,
              frozen_by_name = $5,
              freeze_reason = $6,
              freeze_provenance = $7,
              freeze_reported_signatories = $8::jsonb,
              freeze_reported_reference = $9,
              lifecycle_revision = lifecycle_revision + 1
        WHERE id = $1 AND baseline_id IS NULL
        RETURNING lifecycle_revision::text`,
      [
        input.pageId,
        prepared.id,
        prepared.version,
        input.actorId,
        actorName(finalActor),
        input.reason,
        provenance,
        JSON.stringify(input.reportedSignatories ?? []),
        input.reportedReference ?? null,
      ],
    );
    const lifecycleRevision = updated.rows[0]?.lifecycle_revision;
    if (!lifecycleRevision) throw new PageBaselineError(409, 'stale_lifecycle', 'Page lifecycle changed');

    const published = await client.query(
      `UPDATE page_baselines
          SET status = 'published', published_by_user_id = $2,
              published_by_name = $3, published_at = NOW(), provenance = $4,
              freeze_reason = $5, reported_signatories = $6::jsonb,
              reported_reference = $7, version_snapshot_id = $8
        WHERE id = $1 AND status = 'prepared'`,
      [
        prepared.id,
        input.actorId,
        actorName(finalActor),
        provenance,
        input.reason,
        JSON.stringify(input.reportedSignatories ?? []),
        input.reportedReference ?? null,
        snapshot,
      ],
    );
    if (published.rowCount !== 1) {
      throw new PageBaselineError(409, 'stale_manifest', 'The prepared baseline is no longer publishable');
    }
    // Every other prepared identity belongs to the lifecycle just superseded.
    // Commit abandonment with publication; verified maintenance removes only
    // those unpublished bytes and releases their capacity after this commit.
    await client.query(
      `UPDATE page_baselines
          SET status = 'abandoned', abandoned_at = NOW()
        WHERE original_page_id = $1 AND status = 'prepared'`,
      [input.pageId],
    );
    await appendHistory(client, {
      page,
      baseline: prepared,
      action: 'freeze',
      lifecycleRevision,
      reason: input.reason,
      actor: finalActor,
      provenance,
      signatories: input.reportedSignatories ?? [],
      reference: input.reportedReference ?? null,
    });
    await appendTransitionAudit(client, input.actorId, 'PAGE_FROZEN', input.pageId, {
      baselineId: prepared.id,
      version: prepared.version,
      manifestDigest: prepared.manifest_digest,
      lifecycleRevision,
      provenance,
    });
    await enqueuePageLifecycleEvent(client, PageLifecycleEventSchema.parse({
      type: 'page_lifecycle',
      pageId: input.pageId,
      lifecycleRevision,
      isFrozen: true,
      baselineId: prepared.id,
    }));

    const state = await getPageLifecycleState(client, input.pageId, input.actorId);
    await client.query('COMMIT');
    committed = true;
    void kickPageLifecycleOutbox();
    return state;
  } catch (err) {
    if (!committed) await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function reconcileVersionSnapshot(
  client: PoolClient,
  page: PageRow,
  baseline: BaselineRow,
): Promise<string | null> {
  await client.query(
    `INSERT INTO page_versions (page_id, version_number, title, body_html, body_text)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (page_id, version_number) DO NOTHING`,
    [page.id, baseline.version, baseline.title, baseline.body_html, baseline.body_text],
  );
  const existing = await client.query<{
    id: string;
    title: string;
    body_html: string | null;
    body_text: string | null;
  }>(
    `SELECT id, title, body_html, body_text FROM page_versions
      WHERE page_id = $1 AND version_number = $2`,
    [page.id, baseline.version],
  );
  const row = existing.rows[0];
  if (
    row
    && row.title === baseline.title
    && row.body_html === baseline.body_html
    && row.body_text === baseline.body_text
  ) return row.id;
  return null;
}

interface AppendHistoryInput {
  page: PageRow;
  baseline: BaselineRow;
  action: 'freeze' | 'thaw';
  lifecycleRevision: string;
  reason: string;
  actor: ActorRow;
  provenance: 'manual_assertion' | 'authenticated_approval';
  signatories: ReportedBaselineSignatory[];
  reference: string | null;
}

async function appendHistory(client: PoolClient, input: AppendHistoryInput): Promise<void> {
  await client.query(
    `INSERT INTO page_baseline_history (
       page_id, original_page_id, baseline_id, action, version,
       manifest_digest, content_revision, lifecycle_revision, reason,
       actor_user_id, actor_display_name, provenance, reported_signatories,
       reported_reference
     ) VALUES (
       $1, $1, $2, $3, $4, $5, $6::bigint, $7::bigint, $8,
       $9, $10, $11, $12::jsonb, $13
     )`,
    [
      input.page.id,
      input.baseline.id,
      input.action,
      input.baseline.version,
      input.baseline.manifest_digest,
      input.baseline.content_revision,
      input.lifecycleRevision,
      input.reason,
      input.actor.id,
      actorName(input.actor),
      input.provenance,
      JSON.stringify(input.signatories),
      input.reference,
    ],
  );
}

async function appendTransitionAudit(
  client: PoolClient,
  actorId: string,
  action: 'PAGE_FROZEN' | 'PAGE_THAWED' | 'PAGE_BASELINE_ACTIVATION_CHANGED' | 'PAGE_GOVERNANCE_POLICY_CHANGED',
  pageId: number | null,
  metadata: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (user_id, action, resource_type, resource_id, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [actorId, action, pageId === null ? 'system' : 'page', pageId === null ? null : String(pageId), JSON.stringify(metadata)],
  );
}

export async function unfreezePage(
  pageId: number,
  actorId: string,
  input: UnfreezePageRequest,
): Promise<PageLifecycleState> {
  const runtimeId = await getPageWriterRuntimeId();
  const client = await getPool().connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    await lockPageWriterRuntime(client, runtimeId, { newAdmission: true });
    await lockPageLifecycle(client, [pageId]);
    await loadActiveActor(client, actorId);
    const page = await loadPage(client, pageId, true);
    await assertPageVisible(client, page, actorId);
    if (page.deleted_at) throw new PageBaselineError(409, 'page_deleted', 'A deleted page cannot be thawed from its old URL');
    const permissions = await authority(client, page, actorId);
    if (!permissions.canUnfreeze) throw new PageBaselineError(403, 'not_authorized', 'Space-admin or system-admin authority is required');
    if (!page.baseline_id) throw new PageBaselineError(409, 'page_not_frozen', 'Page is already editable');
    if (page.baseline_id !== input.expectedBaselineId) {
      throw new PageBaselineError(409, 'stale_lifecycle', 'The live baseline changed');
    }
    if (page.lifecycle_revision !== input.expectedLifecycleRevision) {
      throw new PageBaselineError(409, 'stale_lifecycle', 'The page lifecycle changed');
    }

    const baselineResult = await client.query<BaselineRow>(
      `SELECT * FROM page_baselines WHERE id = $1 AND status = 'published'`,
      [page.baseline_id],
    );
    const baseline = baselineResult.rows[0];
    if (!baseline) throw new PageBaselineError(500, 'baseline_evidence_invalid', 'Published baseline evidence is unavailable');

    // Thaw is an authorized, audited unlock, not a new approval. A later
    // governance policy or unavailable EE runtime cannot prevent it, and the
    // retained baseline's provenance remains unchanged.
    const finalActor = await loadActiveActor(client, actorId);
    const finalPermissions = await authority(client, page, actorId);
    if (!finalPermissions.canUnfreeze) throw new PageBaselineError(403, 'not_authorized', 'Thaw permission changed');

    const updated = await client.query<{ lifecycle_revision: string }>(
      `UPDATE pages
          SET baseline_id = NULL,
              frozen_version = NULL,
              frozen_at = NULL,
              frozen_by_user_id = NULL,
              frozen_by_name = NULL,
              freeze_reason = NULL,
              freeze_provenance = NULL,
              freeze_reported_signatories = NULL,
              freeze_reported_reference = NULL,
              lifecycle_revision = lifecycle_revision + 1
        WHERE id = $1 AND baseline_id = $2 AND lifecycle_revision = $3::bigint
        RETURNING lifecycle_revision::text`,
      [pageId, input.expectedBaselineId, input.expectedLifecycleRevision],
    );
    const lifecycleRevision = updated.rows[0]?.lifecycle_revision;
    if (!lifecycleRevision) throw new PageBaselineError(409, 'stale_lifecycle', 'The page lifecycle changed');

    await appendHistory(client, {
      page,
      baseline,
      action: 'thaw',
      lifecycleRevision,
      reason: input.reason,
      actor: finalActor,
      provenance: baseline.provenance ?? 'manual_assertion',
      signatories: parseSignatories(baseline.reported_signatories),
      reference: baseline.reported_reference,
    });
    await appendTransitionAudit(client, actorId, 'PAGE_THAWED', pageId, {
      baselineId: baseline.id,
      version: baseline.version,
      manifestDigest: baseline.manifest_digest,
      lifecycleRevision,
    });
    await enqueuePageLifecycleEvent(client, PageLifecycleEventSchema.parse({
      type: 'page_lifecycle',
      pageId,
      lifecycleRevision,
      isFrozen: false,
      baselineId: null,
    }));
    const state = await getPageLifecycleState(client, pageId, actorId);
    await client.query('COMMIT');
    committed = true;
    void kickPageLifecycleOutbox();
    return state;
  } catch (err) {
    if (!committed) await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

function parseSignatories(value: unknown): ReportedBaselineSignatory[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    if (typeof record.displayName !== 'string') return [];
    return [{
      displayName: record.displayName,
      ...(typeof record.email === 'string' ? { email: record.email } : {}),
    }];
  });
}

interface HistoryRow {
  id: string;
  action: 'freeze' | 'thaw';
  baseline_id: string;
  original_page_id: number;
  version: number;
  manifest_digest: string;
  content_revision: string;
  lifecycle_revision: string;
  reason: string;
  actor_user_id: string | null;
  actor_display_name: string;
  provenance: 'manual_assertion' | 'authenticated_approval';
  reported_signatories: unknown;
  reported_reference: string | null;
  created_at: Date;
  cursor_created_at: string;
}

const HistoryCursorSchema = z.tuple([z.string().datetime({ precision: 6 }), z.string().uuid()]);

function encodeHistoryCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify([createdAt, id]), 'utf8').toString('base64url');
}

function decodeHistoryCursor(cursor: string | undefined): [string, string] | null {
  if (!cursor) return null;
  try {
    return HistoryCursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
  } catch {
    throw new PageBaselineError(400, 'invalid_cursor', 'Invalid history cursor');
  }
}

export async function getPageFreezeHistory(
  pageId: number,
  actorId: string,
  options: { cursor?: string; limit: number },
): Promise<PageFreezeHistoryResponse> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await loadActiveActor(client, actorId);
    const page = await loadPage(client, pageId);
    if (page.deleted_at) throw new PageBaselineError(404, 'page_not_found', 'Page not found');
    await assertPageVisible(client, page, actorId);
    const response = await queryHistory(client, 'original_page_id = $1', pageId, options);
    await client.query('COMMIT');
    return response;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function getAdminBaselineHistory(
  baselineId: string,
  actorId: string,
  options: { cursor?: string; limit: number },
): Promise<PageFreezeHistoryResponse> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await assertFreshAdmin(client, actorId);
    const response = await queryHistory(client, 'baseline_id = $1', baselineId, options);
    await client.query('COMMIT');
    return response;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function queryHistory(
  client: PoolClient,
  predicate: 'original_page_id = $1' | 'baseline_id = $1',
  value: number | string,
  options: { cursor?: string; limit: number },
): Promise<PageFreezeHistoryResponse> {
  const cursor = decodeHistoryCursor(options.cursor);
  const params: unknown[] = [value];
  let cursorSql = '';
  if (cursor) {
    params.push(cursor[0], cursor[1]);
    cursorSql = 'AND (created_at, id) > ($2::timestamptz, $3::uuid)';
  }
  params.push(options.limit + 1);
  const limitParam = params.length;
  const result = await client.query<HistoryRow>(
    `SELECT id, action, baseline_id, original_page_id, version, manifest_digest,
            content_revision::text, lifecycle_revision::text, reason,
            actor_user_id, actor_display_name, provenance, reported_signatories,
            reported_reference, created_at,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at
       FROM page_baseline_history
      WHERE ${predicate} ${cursorSql}
      ORDER BY created_at ASC, id ASC
      LIMIT $${limitParam}`,
    params,
  );
  const hasMore = result.rows.length > options.limit;
  const rows = result.rows.slice(0, options.limit);
  return {
    entries: rows.map((row) => ({
      id: row.id,
      action: row.action,
      baselineId: row.baseline_id,
      pageId: row.original_page_id,
      version: row.version,
      manifestDigest: row.manifest_digest,
      contentRevision: row.content_revision,
      lifecycleRevision: row.lifecycle_revision,
      reason: row.reason,
      actorId: row.actor_user_id,
      actorName: row.actor_display_name,
      provenance: row.provenance,
      reportedSignatories: parseSignatories(row.reported_signatories).map(({ displayName }) => ({ displayName })),
      reportedReference: row.reported_reference,
      createdAt: row.created_at.toISOString(),
    })),
    nextCursor: hasMore && rows.length > 0
      ? encodeHistoryCursor(rows[rows.length - 1]!.cursor_created_at, rows[rows.length - 1]!.id)
      : null,
  };
}

async function assertFreshAdmin(client: PoolClient, actorId: string): Promise<ActorRow> {
  const actor = await loadActiveActor(client, actorId);
  if (!await isSystemAdmin(actorId, client)) {
    throw new PageBaselineError(403, 'not_authorized', 'System-admin authority is required');
  }
  return actor;
}

/**
 * Returns an authorized rendering-only variant for a currently frozen page.
 * The signed authored HTML remains unchanged in both pages and baseline evidence.
 */
export async function renderedFrozenPageBodyHtml(
  client: PoolClient,
  pageId: number,
  actorId: string,
): Promise<string | null> {
  await loadActiveActor(client, actorId);
  const page = await loadPage(client, pageId, false);
  await assertPageVisible(client, page, actorId);
  if (page.deleted_at || !page.baseline_id) return null;
  const result = await client.query<Pick<BaselineRow, 'id' | 'body_html' | 'attachments' | 'page_identity'>>(
    `SELECT id, body_html, attachments, page_identity
       FROM page_baselines
      WHERE id = $1 AND original_page_id = $2 AND status = 'published'`,
    [page.baseline_id, pageId],
  );
  const baseline = result.rows[0];
  if (!baseline) {
    throw new PageBaselineError(
      503,
      'baseline_storage_unavailable',
      'The frozen page baseline is unavailable',
    );
  }
  const identity = BaselinePageIdentitySchema.safeParse(baseline.page_identity);
  if (!identity.success || identity.data[2] !== String(pageId)) {
    throw new PageBaselineError(503, 'baseline_evidence_invalid', 'The frozen page identity is invalid');
  }
  const legacyAttachmentPageKey = identity.data[1] === 'confluence' && identity.data[3]
    ? identity.data[3]
    : identity.data[2];
  try {
    return renderBaselineBodyHtml(
      baseline.body_html ?? '',
      pageId,
      baseline.id,
      retainedAttachments(baseline.attachments),
      legacyAttachmentPageKey,
    );
  } catch (err) {
    throw manifestError(err);
  }
}

export async function getPageBaselineEvidence(
  baselineId: string,
  actorId: string,
): Promise<PageBaselineEvidence> {
  const client = await getPool().connect();
  try {
    await assertFreshAdmin(client, actorId);
    const result = await client.query<BaselineRow>(
      `SELECT * FROM page_baselines WHERE id = $1 AND status = 'published'`,
      [baselineId],
    );
    const row = result.rows[0];
    if (!row || !row.published_at || !row.provenance) {
      throw new PageBaselineError(404, 'baseline_not_found', 'Baseline evidence not found');
    }
    const parsed = PageBaselineEvidenceSchema.safeParse({
      baselineId: row.id,
      originalPageId: row.original_page_id,
      livePageId: row.page_id,
      pageIdentity: row.page_identity,
      version: row.version,
      contentRevision: row.content_revision,
      manifestVersion: 1,
      manifestDigest: row.manifest_digest,
      manifest: row.manifest,
      attachments: wireAttachments(row.attachments),
      totalBytes: Number(row.total_bytes),
      title: row.title,
      preparedBy: row.prepared_by_user_id,
      preparedByName: row.prepared_by_name,
      publishedBy: row.published_by_user_id,
      publishedByName: row.published_by_name,
      provenance: row.provenance,
      reportedSignatories: parseSignatories(row.reported_signatories),
      reportedReference: row.reported_reference,
      publishedAt: row.published_at.toISOString(),
    });
    if (!parsed.success) {
      throw new PageBaselineError(500, 'baseline_evidence_invalid', 'Published baseline evidence is invalid');
    }
    return parsed.data;
  } finally {
    client.release();
  }
}

export async function readBaselineEvidenceAttachment(
  baselineId: string,
  attachmentIdentity: string,
  actorId: string,
): Promise<{ stream: NodeJS.ReadableStream; size: number; mediaType: string; filename: string }> {
  const client = await getPool().connect();
  let attachment: BaselineAttachment | undefined;
  try {
    await assertFreshAdmin(client, actorId);
    const result = await client.query<{ attachments: unknown }>(
      `SELECT attachments FROM page_baselines WHERE id = $1 AND status = 'published'`,
      [baselineId],
    );
    if (!result.rows[0]) throw new PageBaselineError(404, 'baseline_not_found', 'Baseline evidence not found');
    attachment = storedBaselineAttachment(
      baselineId,
      result.rows[0].attachments,
      attachmentIdentity,
    ) ?? undefined;
  } finally {
    client.release();
  }
  if (!attachment) {
    throw new PageBaselineError(404, 'baseline_attachment_not_found', 'Baseline attachment not found');
  }
  try {
    const stream = await readBaselineAttachment(baselineId, attachment);
    return { stream, size: attachment.size, mediaType: attachment.mediaType, filename: attachment.filename };
  } catch (err) {
    throw manifestError(err);
  }
}

export async function readFrozenBaselineMedia(
  pageId: number,
  baselineId: string,
  attachmentIdentity: string,
  actorId: string,
): Promise<{
  stream: NodeJS.ReadableStream;
  mediaType: string;
  size: number;
  filename: string;
}> {
  const client = await getPool().connect();
  let attachment: BaselineAttachment;
  try {
    await client.query('BEGIN');
    await loadActiveActor(client, actorId);
    const page = await loadPage(client, pageId, true);
    await assertPageVisible(client, page, actorId);
    if (page.deleted_at) {
      throw new PageBaselineError(404, 'page_not_found', 'Page not found');
    }
    const result = await client.query<Pick<BaselineRow, 'attachments'>>(
      `SELECT attachments
         FROM page_baselines
        WHERE id = $1 AND original_page_id = $2 AND status = 'published'`,
      [baselineId, pageId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new PageBaselineError(404, 'baseline_not_found', 'Baseline not found');
    }
    const exact = storedBaselineAttachment(baselineId, row.attachments, attachmentIdentity);
    if (!exact) {
      throw new PageBaselineError(404, 'baseline_attachment_not_found', 'Baseline attachment not found');
    }
    attachment = exact;
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  try {
    return {
      stream: await readBaselineAttachment(baselineId, attachment),
      mediaType: attachment.mediaType,
      size: attachment.size,
      filename: attachment.filename,
    };
  } catch (err) {
    throw manifestError(err);
  }
}

export type FrozenPageAttachmentLocator =
  | { store: 'local' | 'confluence'; pageKey: string; filename: string }
  | { store: 'icon'; sha256: string };

export type FrozenPageAttachmentRead =
  | { state: 'editable' }
  | { state: 'frozen_missing' }
  | { state: 'frozen'; stream: NodeJS.ReadableStream; size: number; mediaType: string };

export async function readFrozenPageAttachment(input: {
  pageId: number;
  actorId: string;
  locator: FrozenPageAttachmentLocator;
}): Promise<FrozenPageAttachmentRead> {
  const client = await getPool().connect();
  let baselineId: string | null = null;
  let match: BaselineAttachment | undefined;
  try {
    await loadActiveActor(client, input.actorId);
    const page = await loadPage(client, input.pageId);
    await assertPageVisible(client, page, input.actorId);
    baselineId = page.baseline_id ?? null;
    if (!baselineId) return { state: 'editable' };
    const result = await client.query<{ attachments: unknown }>(
      `SELECT attachments FROM page_baselines WHERE id = $1 AND status = 'published'`,
      [baselineId],
    );
    if (!result.rows[0]) throw new PageBaselineError(500, 'baseline_evidence_invalid', 'Published baseline evidence is unavailable');
    const inventory = retainedAttachments(result.rows[0].attachments);
    const locator = input.locator;
    match = locator.store === 'icon'
      ? inventory.find((item) => item.store === 'icon' && item.sha256 === locator.sha256)
      : inventory.find((item) => item.store === locator.store
          && item.pageKey === locator.pageKey
          && item.filename === locator.filename);
    if (!match) return { state: 'frozen_missing' };
  } finally {
    client.release();
  }
  if (!baselineId || !match) {
    throw new PageBaselineError(500, 'baseline_evidence_invalid', 'Published baseline evidence is unavailable');
  }
  try {
    const stream = await readBaselineAttachment(baselineId, match);
    return { state: 'frozen', stream, size: match.size, mediaType: match.mediaType };
  } catch (err) {
    throw manifestError(err);
  }
}

export async function getPageBaselineActivationState(
  actorId: string,
): Promise<PageBaselineActivationState> {
  const client = await getPool().connect();
  try {
    await assertFreshAdmin(client, actorId);
    const row = await activationRow(client);
    const readiness = await getPageBaselineDeploymentReadiness();
    return {
      creationEnabled: row.creation_enabled,
      deploymentReady: readiness.ready,
      blockers: readiness.blockers,
      activatedAt: row.activated_at?.toISOString() ?? null,
      activatedBy: row.activated_by_user_id,
      activatedByName: row.activated_by_name,
    };
  } finally {
    client.release();
  }
}

export async function setPageBaselineCreationEnabled(
  actorId: string,
  creationEnabled: boolean,
): Promise<PageBaselineActivationState> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const actor = await assertFreshAdmin(client, actorId);
    const readiness = await getPageBaselineDeploymentReadiness();
    if (creationEnabled && !readiness.ready) {
      throw new PageBaselineError(409, 'deployment_not_ready', 'All protected writers must report readiness before activation');
    }
    const result = await client.query<{
      creation_enabled: boolean;
      activated_at: Date | null;
      activated_by_user_id: string | null;
      activated_by_name: string | null;
    }>(
      `UPDATE page_baseline_feature_state
          SET creation_enabled = $1,
              activated_at = CASE WHEN $1 THEN NOW() ELSE NULL END,
              activated_by_user_id = CASE WHEN $1 THEN $2::uuid ELSE NULL END,
              activated_by_name = CASE WHEN $1 THEN $3 ELSE NULL END,
              updated_at = NOW()
        WHERE singleton = TRUE
        RETURNING creation_enabled, activated_at, activated_by_user_id, activated_by_name`,
      [creationEnabled, actorId, actorName(actor)],
    );
    await appendTransitionAudit(client, actorId, 'PAGE_BASELINE_ACTIVATION_CHANGED', null, {
      creationEnabled,
      deploymentReady: readiness.ready,
    });
    await client.query('COMMIT');
    const row = result.rows[0]!;
    return {
      creationEnabled: row.creation_enabled,
      deploymentReady: readiness.ready,
      blockers: readiness.blockers,
      activatedAt: row.activated_at?.toISOString() ?? null,
      activatedBy: row.activated_by_user_id,
      activatedByName: row.activated_by_name,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function setPageGovernancePolicy(input: {
  actorId: string;
  spaceKey: string;
  enabled: boolean;
}): Promise<{ enabled: boolean; policyRevision: string }> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const actor = await assertFreshAdmin(client, input.actorId);
    await client.query(
      'SELECT pg_advisory_xact_lock($1, hashtext($2))',
      [PAGE_GOVERNANCE_POLICY_LOCK_KEY, input.spaceKey],
    );
    const result = await client.query<{ governance_enabled: boolean; policy_revision: string }>(
      `INSERT INTO page_governance_policies (
         space_key, governance_enabled, updated_by_user_id, updated_by_name
       ) VALUES ($1, $2, $3, $4)
       ON CONFLICT (space_key) DO UPDATE SET
         governance_enabled = EXCLUDED.governance_enabled,
         policy_revision = page_governance_policies.policy_revision + 1,
         updated_by_user_id = EXCLUDED.updated_by_user_id,
         updated_by_name = EXCLUDED.updated_by_name,
         updated_at = NOW()
       RETURNING governance_enabled, policy_revision::text`,
      [input.spaceKey, input.enabled, input.actorId, actorName(actor)],
    );
    await getPageBaselineGovernanceHook()?.invalidatePolicyCache?.(input.spaceKey);
    await appendTransitionAudit(client, input.actorId, 'PAGE_GOVERNANCE_POLICY_CHANGED', null, {
      spaceKey: input.spaceKey,
      enabled: input.enabled,
      policyRevision: result.rows[0]!.policy_revision,
    });
    await client.query('COMMIT');
    return {
      enabled: result.rows[0]!.governance_enabled,
      policyRevision: result.rows[0]!.policy_revision,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
