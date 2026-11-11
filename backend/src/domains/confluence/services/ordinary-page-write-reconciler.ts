import { createHash } from 'node:crypto';
import type { ArticleTransportStage } from '../../llm/services/openai-compatible-client.js';
import { validateAutoTagPublicationOnClient } from '../../llm/services/auto-tag-publication.js';
import fs from 'node:fs/promises';
import type { PoolClient } from 'pg';
import { confluenceToHtml, htmlToText } from '../../../core/services/content-converter.js';
import { materializeDrawioPreviews } from '../../../core/services/drawio-previews.js';
import { attachmentCacheDir } from '../../../core/services/attachment-store.js';
import { tombstoneCollabRoomAfterCommit } from '../../../core/services/collab-tombstone.js';
import {
  discardPageIconForDeletedPage,
  pageIconDirectoryAbsent,
} from '../../../core/services/page-icon-store.js';
import {
  cleanupStandalonePageAttachmentDirs,
  deletedStandaloneNamespacesAbsent,
} from '../../../core/services/standalone-attachment-cleanup.js';
import { enqueuePageWriteInvalidation } from '../../../core/services/page-write-invalidation.js';
import {
  aiPolicyRefusalFromResult,
  canChoosePolicyAtCreation,
  canMutateAiPolicy,
  isAiPolicyEnforcementAvailable,
  policyFromLabels,
  planLabelPolicyChange,
  applyAiPolicyOnClient,
  applyCanonicalAiPolicyLabel,
  applyPageLabelsOnClient,
  lockAiPolicyForPages,
  reservedAiPolicyLabel,
  stricterPolicy,
  type AiPolicy,
} from '../../../core/services/ai-policy-service.js';
import { reservePolicyLabelSynchronization } from '../../../core/services/policy-label-synchronization.js';
import { initialPolicyFromEffect } from '../../../core/services/ai-policy-ingestion.js';
import {
  PageWriteError,
  advancePageWriteIntent,
  acknowledgedGeneratedLabelPrefix,
  registerPageWriteIntentReconciler,
  registerGeneratedLabelCompensator,
  registerCanonicalLabelRepairer,
  registerCommittedPolicyLabelDispatcher,
  runPageWriteIntentEffect,
  type PageWriteIntentReconciler,
  type PageWriteRecoveryIntent,
  type PageWriteIntentRepairer,
} from '../../../core/services/page-write-admission.js';
import { getUserAccessibleSpaces, isSystemAdmin, userCanAccessPage } from '../../../core/services/rbac-service.js';
import { ConfluenceError, type ConfluenceClient } from './confluence-client.js';
import { cleanPageAttachments } from './attachment-handler.js';
import { getClientForUser } from './sync-service.js';

type TerminalResult = {
  confluenceId: string;
  accepted?: true;
  expectedVersion?: number;
  observedConfluenceId?: string;
  version?: number;
  titleSha256?: string;
  storageSha256?: string;
  outcome?: string;
};

type ConfluencePageReply = Awaited<ReturnType<ConfluenceClient['getPage']>>;
type ConfirmedPagePublication = ConfluencePageReply & { body: { storage: { value: string } } };

/**
 * A successful PUT is an acknowledgment even when its JSON is compact.
 * Expected identity/version are command metadata, never fabricated observations.
 * Only fields actually supplied by the provider become observed fingerprints.
 */
export function pagePublicationReceipt(
  confluenceId: string,
  expectedVersion: number,
  reply: ConfluencePageReply,
): TerminalResult {
  return {
    accepted: true,
    confluenceId,
    expectedVersion,
    ...(typeof reply?.id === 'string' ? { observedConfluenceId: reply.id } : {}),
    ...(Number.isSafeInteger(reply?.version?.number) ? { version: reply.version.number } : {}),
    ...(typeof reply?.title === 'string'
      ? { titleSha256: createHash('sha256').update(reply.title).digest('hex') }
      : {}),
    ...(typeof reply?.body?.storage?.value === 'string'
      ? { storageSha256: createHash('sha256').update(reply.body.storage.value).digest('hex') }
      : {}),
  };
}

/** Read back compact acknowledgments only after their terminal marker is durable. */
export async function confirmPagePublication(
  confluence: ConfluenceClient,
  receipt: TerminalResult,
  reply?: ConfluencePageReply,
): Promise<ConfirmedPagePublication> {
  if (
    receipt.accepted !== true ||
    typeof receipt.expectedVersion !== 'number' ||
    !Number.isSafeInteger(receipt.expectedVersion) ||
    receipt.expectedVersion < 1 ||
    (receipt.observedConfluenceId !== undefined && receipt.observedConfluenceId !== receipt.confluenceId) ||
    (receipt.version !== undefined && receipt.version !== receipt.expectedVersion)
  ) {
    throw new PageWriteError(409, 'intent_terminal_result_invalid', 'The page acknowledgment identity is incomplete or conflicting');
  }
  const observed = reply &&
    typeof reply.id === 'string' &&
    typeof reply.title === 'string' &&
    Number.isSafeInteger(reply.version?.number) &&
    typeof reply.body?.storage?.value === 'string'
    ? reply
    : await confluence.getPage(receipt.confluenceId);
  if (
    observed?.id !== receipt.confluenceId ||
    observed.status === 'trashed' ||
    observed.version?.number !== receipt.expectedVersion ||
    typeof observed.title !== 'string' ||
    typeof observed.body?.storage?.value !== 'string' ||
    (receipt.titleSha256 !== undefined &&
      createHash('sha256').update(observed.title).digest('hex') !== receipt.titleSha256) ||
    (receipt.storageSha256 !== undefined &&
      createHash('sha256').update(observed.body.storage.value).digest('hex') !== receipt.storageSha256)
  ) {
    throw new PageWriteError(
      409,
      'intent_terminal_evidence_mismatch',
      'The remote page no longer matches the acknowledged version; the intent remains pending',
    );
  }
  return observed as ConfirmedPagePublication;
}

export interface CreatedConfluencePagePublication {
  confluenceId: string;
  spaceKey: string;
  parentConfluenceId: string | null;
  title: string;
  storage: string;
  version: number;
  /**
   * Article AI policy (#281): the creator's admitted first publication. The
   * labels are the planned (contradiction-free, canonical) set and the
   * policy the stricter of the creation default, the explicit choice and
   * those labels — decided BEFORE the remote create was dispatched and
   * carried in the durable intent effect, so first publication (and its
   * recovery) never inserts a looser policy than the creator stated, and a
   * failed or undispatched label step cannot leave the page at `all`.
   * Absent on legacy intents: the row then inserts with the defaults (the
   * database trigger still tightens from labels).
   */
  initialPolicy?: AiPolicy;
  initialLabels?: readonly string[];
  /**
   * The creating actor. Required only when an exact matching row (sync-first
   * import) must be tightened to `initialPolicy`: the tighten is attributed
   * to the creator and its change records are handed to `onPolicyChanges`
   * so the caller emits them strictly after its COMMIT.
   */
  actorId?: string;
  recoveryIntentId?: string;
}

export interface PublishedConfluencePage {
  id: number;
  labels: string[] | null;
  aiPolicy: AiPolicy;
  contentRevision: string;
  lifecycleRevision: string;
}

/**
 * The admitted first-publication policy of a durable create effect. ONE
 * decoder is shared with the sync walker's first-publication fence
 * (`ai-policy-ingestion.ts`) so recovery and ingestion cannot disagree on
 * what a create stated (#281).
 */
export { initialPolicyFromEffect };

/**
 * Publish an acknowledged upstream create into the local corpus. Re-running
 * after an acknowledgement loss accepts only the exact already-published row;
 * an unrelated collision is never overwritten.
 *
 * A validated creator journal carries its own authority to finish a
 * restriction while the switch is closed, but not past the migration-151
 * guard: while a pre-#1881 writer is still active the tightening statement
 * raises 55000 `ai_policy_incompatible_runtime_active`. That error is
 * deliberately NOT caught or reclassified here — it propagates as-is, the
 * caller's transaction rolls back and the intent stays pending (never
 * terminal, never `intent_recovery_metadata_invalid`); the same recovery
 * succeeds once that runtime is fenced. The sync walker defers the snapshot
 * on it (`sync-service.ts`), HTTP maps it centrally to 409.
 */
export async function publishCreatedConfluencePage(
  client: PoolClient,
  publication: CreatedConfluencePagePublication,
): Promise<PublishedConfluencePage> {
  const bodyHtml = (await materializeDrawioPreviews(
    confluenceToHtml(publication.storage, publication.confluenceId, publication.spaceKey),
    publication.confluenceId,
  )).html;
  const bodyText = htmlToText(bodyHtml);
  const initialLabels = [...(publication.initialLabels ?? [])];
  const initialPolicy = stricterPolicy(publication.initialPolicy ?? 'all', policyFromLabels(initialLabels));
  const alreadyPublished = await client.query('SELECT 1 FROM pages WHERE confluence_id = $1', [publication.confluenceId]);
  if (initialPolicy !== 'all' && alreadyPublished.rowCount === 0) {
    const actor = publication.actorId && await client.query(
      'SELECT 1 FROM users WHERE id = $1 AND deactivated_at IS NULL', [publication.actorId],
    );
    if (!actor || actor.rowCount !== 1 || !await canChoosePolicyAtCreation(
      publication.actorId!, { source: 'confluence', spaceKey: publication.spaceKey }, client,
    ) || (!await isSystemAdmin(publication.actorId!, client)
      && !(await getUserAccessibleSpaces(publication.actorId!, client)).includes(publication.spaceKey))) {
      throw aiPolicyRefusalFromResult({ reason: 'not_authorized', pageIds: [] });
    }
    // A recovery exception is an exact durable command, not a source/label
    // flag. Validate it even when readiness is open; no substituted payload
    // may borrow another pending create's authority.
    if (publication.recoveryIntentId) {
      const receipt = await client.query<{ effect: Record<string, unknown>; page_ids: number[] }>(
        `SELECT i.effect, i.page_ids FROM page_write_intents i
          WHERE i.id = $1 AND i.actor_id = $2 AND i.status = 'pending'
            AND i.kind = 'pages.create.confluence' AND i.effect->>'effectClass' = 'remote'
            AND i.remote_effect_started_at IS NOT NULL AND i.remote_effects_completed_at IS NOT NULL
            AND i.remote_terminal_result->'accepted' = 'true'::jsonb
            AND i.remote_terminal_result->>'confluenceId' = $3
            AND i.remote_terminal_result->>'expectedVersion' = $4
            AND i.effect->>'spaceKey' = $5
            AND i.effect->>'parentConfluenceId' IS NOT DISTINCT FROM $6::text
            AND NOT EXISTS (
              SELECT 1 FROM unnest(i.page_ids) AS target(page_id) LEFT JOIN pages p ON p.id = target.page_id
               WHERE p.id IS NULL OR p.deleted_at IS NOT NULL
                  OR i.revisions->target.page_id::text->>'contentRevision' IS DISTINCT FROM p.content_revision::text
                  OR i.revisions->target.page_id::text->>'lifecycleRevision' IS DISTINCT FROM p.lifecycle_revision::text
            ) FOR SHARE`,
        [publication.recoveryIntentId, publication.actorId, publication.confluenceId,
          String(publication.version), publication.spaceKey, publication.parentConfluenceId],
      );
      for (const parentId of receipt.rows[0]?.page_ids ?? []) {
        if (!await canMutateAiPolicy(publication.actorId!, parentId, client)) {
          throw aiPolicyRefusalFromResult({ reason: 'not_authorized', pageIds: [] });
        }
      }
      const effect = receipt.rows[0]?.effect;
      if (!effect || effect.initialPolicy !== initialPolicy
        || !Array.isArray(effect.initialLabels)
        || effect.initialLabels.some((label) => typeof label !== 'string')
        || !sameLabelSet(effect.initialLabels as string[], initialLabels)
        || effect.titleSha256 !== createHash('sha256').update(publication.title).digest('hex')
        || effect.storageSha256 !== createHash('sha256').update(publication.storage).digest('hex')) {
        throw new PageWriteError(409, 'intent_recovery_metadata_invalid', 'Publication does not match its pending creation journal');
      }
    } else if (!isAiPolicyEnforcementAvailable()) {
      throw aiPolicyRefusalFromResult({ reason: 'enforcement_unavailable', pageIds: [] });
    }
  }
  const inserted = await client.query<PublishedConfluencePage>(
    `INSERT INTO pages
       (confluence_id, space_key, title, body_storage, body_html, body_text,
        version, parent_id, source, embedding_dirty, image_analysis_dirty, embedding_status,
        labels, ai_policy)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'confluence', TRUE, TRUE, 'not_embedded', $9, $10)
     ON CONFLICT (confluence_id) WHERE confluence_id IS NOT NULL DO NOTHING
     RETURNING id, labels, ai_policy AS "aiPolicy", content_revision::text AS "contentRevision",
               lifecycle_revision::text AS "lifecycleRevision"`,
    [
      publication.confluenceId,
      publication.spaceKey,
      publication.title,
      publication.storage,
      bodyHtml,
      bodyText,
      publication.version,
      publication.parentConfluenceId,
      applyCanonicalAiPolicyLabel(initialLabels, 'all'),
      'all',
    ],
  );
  if (inserted.rows[0]) {
    const fresh = inserted.rows[0];
    if (initialPolicy === 'all') return fresh;
    const applied = await applyAiPolicyOnClient(client, {
      userId: publication.actorId!,
      items: [{ pageId: fresh.id, policy: initialPolicy, expectedRevision: 0 }],
      ...(publication.recoveryIntentId ? {
        recovery: { intentId: publication.recoveryIntentId, targetLabels: initialLabels },
      } : {}),
    });
    if (!applied.ok) throw aiPolicyRefusalFromResult(applied);
    return { ...fresh, aiPolicy: applied.rows[0]!.policy,
      labels: applyCanonicalAiPolicyLabel(initialLabels, applied.rows[0]!.policy) };
  }
  // The row already exists (a re-run after an acknowledgement loss, or the
  // sync walker imported the acknowledged page first). Identity equality and
  // policy strictness are different checks: identity is compared on the
  // locked row below; a matching row that is LOOSER than the trusted initial
  // policy is ours and is tightened, never refused and never left at `all`.
  // Lock order: AI-policy advisory lock BEFORE the row lock.
  const located = await client.query<{ id: number }>(
    `SELECT id FROM pages WHERE confluence_id = $1`,
    [publication.confluenceId],
  );
  const locatedId = located.rows[0]?.id;
  if (locatedId !== undefined) await lockAiPolicyForPages(client, [locatedId]);
  const existing = await client.query<PublishedConfluencePage & {
    spaceKey: string | null;
    parentId: string | null;
    title: string;
    storage: string | null;
    bodyHtml: string | null;
    bodyText: string | null;
    version: number;
    source: string;
    deletedAt: Date | null;
    policyRevision: string;
  }>(
    `SELECT id, labels, ai_policy_revision::text AS "policyRevision", ai_policy AS "aiPolicy", content_revision::text AS "contentRevision",
            lifecycle_revision::text AS "lifecycleRevision",
            space_key AS "spaceKey", parent_id AS "parentId", title,
            body_storage AS storage, body_html AS "bodyHtml",
            body_text AS "bodyText", version, source, deleted_at AS "deletedAt"
       FROM pages
      WHERE confluence_id = $1
      FOR UPDATE`,
    [publication.confluenceId],
  );
  const row = existing.rows[0];
  if (
    !row ||
    row.id !== locatedId ||
    row.deletedAt !== null ||
    row.source !== 'confluence' ||
    row.spaceKey !== publication.spaceKey ||
    row.parentId !== publication.parentConfluenceId ||
    row.bodyHtml !== bodyHtml ||
    row.bodyText !== bodyText ||
    row.title !== publication.title ||
    row.storage !== publication.storage ||
    row.version !== publication.version
  ) {
    throw new PageWriteError(
      409,
      'intent_local_identity_changed',
      'The acknowledged Confluence page conflicts with an existing local row',
    );
  }
  if (
    row.policyRevision !== '0'
    || publication.initialPolicy === undefined
    || stricterPolicy(row.aiPolicy, initialPolicy) === row.aiPolicy
  ) {
    // The row already holds the stated policy or a later authoritative
    // tighten: nothing to move, the revision stays.
    return { id: row.id, labels: row.labels, aiPolicy: row.aiPolicy,
      contentRevision: row.contentRevision, lifecycleRevision: row.lifecycleRevision };
  }
  // Exact matching row published looser than the durable creation authority
  // (sync-first import before the creator's labels reached Confluence).
  // Tighten it to the initial policy through the policy primitive: policy,
  // revision, canonical labels and the purge of anything derived under the
  // former policy commit with this publication. A tighten needs no
  // mutation authority (the same rule ingestion applies).
  if (!publication.actorId) {
    throw new PageWriteError(
      409,
      'intent_local_identity_changed',
      'The acknowledged Confluence page exists locally with a looser AI policy and no actor to attribute its tightening to',
    );
  }
  if (publication.recoveryIntentId) {
    const journal = await client.query<{ page_ids: number[] }>(
      'SELECT page_ids FROM page_write_intents WHERE id = $1 FOR SHARE', [publication.recoveryIntentId],
    );
    for (const parentId of journal.rows[0]?.page_ids ?? []) {
      if (!await canMutateAiPolicy(publication.actorId, parentId, client)) {
        throw aiPolicyRefusalFromResult({ reason: 'not_authorized', pageIds: [] });
      }
    }
  }
  const finalPolicy = initialPolicy;
  // The creator's ordinary labels join the row's; the reserved slot is
  // written by the policy primitive itself (one canonical label for the
  // policy the row now holds), so no second label write can disagree.
  const mergedLabels: string[] = [];
  for (const label of [...(row.labels ?? []), ...initialLabels]) {
    if (reservedAiPolicyLabel(label) !== null || mergedLabels.includes(label)) continue;
    mergedLabels.push(label);
  }
  await client.query(`UPDATE pages SET labels = $2 WHERE id = $1`, [row.id, mergedLabels]);
  const applied = await applyAiPolicyOnClient(client, {
    userId: publication.actorId,
    items: [{ pageId: row.id, policy: finalPolicy, expectedRevision: 0 }],
    ...(publication.recoveryIntentId ? {
      recovery: { intentId: publication.recoveryIntentId, targetLabels: initialLabels },
    } : {}),
  });
  if (!applied.ok) {
    throw new PageWriteError(409, applied.reason, 'The initial AI policy could not be applied to the published row');
  }
  const relabeled = await client.query<{ labels: string[] | null }>(
    `SELECT labels FROM pages WHERE id = $1`,
    [row.id],
  );
  return {
    id: row.id,
    labels: relabeled.rows[0]?.labels ?? applyCanonicalAiPolicyLabel(mergedLabels, finalPolicy),
    aiPolicy: applied.rows[0]!.policy,
    contentRevision: row.contentRevision,
    lifecycleRevision: row.lifecycleRevision,
  };
}

const LABEL_KINDS = [
  'page.labels',
  'pages.bulk.replace_tags',
  'pages.bulk.tags',
  'pages.create.labels',
] as const;

function stringValue(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PageWriteError(409, 'intent_recovery_metadata_invalid', `Missing ${field}`);
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new PageWriteError(409, 'intent_recovery_metadata_invalid', `Missing ${field}`);
  }
  return value;
}

function sha256Value(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new PageWriteError(409, 'intent_recovery_metadata_invalid', `Missing ${field}`);
  }
  return value;
}

function terminalResult(intent: PageWriteRecoveryIntent): TerminalResult {
  const result = intent.remoteTerminalResult;
  if (!result) {
    throw new PageWriteError(409, 'intent_terminal_result_missing', 'The terminal response identity is unavailable');
  }
  const confluenceId = stringValue(result.confluenceId, 'terminal confluenceId');
  return {
    confluenceId,
    ...(result.accepted === true ? { accepted: true as const } : {}),
    ...(typeof result.expectedVersion === 'number' && Number.isSafeInteger(result.expectedVersion)
      ? { expectedVersion: result.expectedVersion }
      : {}),
    ...(typeof result.observedConfluenceId === 'string' ? { observedConfluenceId: result.observedConfluenceId } : {}),
    ...(typeof result.version === 'number' && Number.isSafeInteger(result.version)
      ? { version: result.version }
      : {}),
    ...(typeof result.titleSha256 === 'string' && /^[a-f0-9]{64}$/.test(result.titleSha256)
      ? { titleSha256: result.titleSha256 }
      : {}),
    ...(typeof result.storageSha256 === 'string' && /^[a-f0-9]{64}$/.test(result.storageSha256)
      ? { storageSha256: result.storageSha256 }
      : {}),
    ...(typeof result.outcome === 'string' ? { outcome: result.outcome } : {}),
  };
}

async function assertActorActive(client: PoolClient, intent: PageWriteRecoveryIntent): Promise<string> {
  if (!intent.actorId) {
    throw new PageWriteError(409, 'intent_actor_unavailable', 'The original actor no longer exists');
  }
  const actor = await client.query<{ active: boolean }>(
    `SELECT deactivated_at IS NULL AS active FROM users WHERE id = $1`,
    [intent.actorId],
  );
  if (actor.rows[0]?.active !== true) {
    throw new PageWriteError(403, 'intent_actor_inactive', 'The original actor is no longer active');
  }
  return intent.actorId;
}

async function assertPageAccess(
  client: PoolClient,
  intent: PageWriteRecoveryIntent,
  pageId: number,
): Promise<string> {
  const actorId = await assertActorActive(client, intent);
  if (!(await userCanAccessPage(actorId, pageId, client))) {
    throw new PageWriteError(403, 'intent_access_changed', 'The original actor no longer has page access');
  }
  return actorId;
}

function exactLabels(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((label) => typeof label !== 'string')) {
    throw new PageWriteError(409, 'intent_recovery_metadata_invalid', 'The target labels are unavailable');
  }
  return [...new Set(value)].sort();
}
function remoteNotStarted(reference: string, result: unknown) {
  return {
    outcome: 'not_applied' as const,
    proof: {
      kind: 'remote_effect_not_started' as const,
      observedAt: new Date().toISOString(),
      reference,
      details: { syscallSettled: true as const, remoteEffectStarted: false as const, observedAbsent: true as const },
    },
    result,
  };
}


const reconcilePageCreate: PageWriteIntentReconciler = async (client, intent) => {
  const spaceKey = stringValue(intent.effect.spaceKey, 'spaceKey');
  const expectedTitleDigest = sha256Value(intent.effect.titleSha256, 'titleSha256');
  const expectedStorageDigest = sha256Value(intent.effect.storageSha256, 'storageSha256');
  let actorId: string;
  let parentReferenceId: string | null;
  if (intent.pageIds.length === 0) {
    // Explicit ROOT shape (migration 137, #280/#281): no local target, null
    // parent references. Only this exact shape is admitted as a root; a
    // malformed or other-kind empty target is still metadata-invalid.
    if (intent.effect.parentPageId !== null || intent.effect.parentConfluenceId !== null) {
      throw new PageWriteError(
        409,
        'intent_recovery_metadata_invalid',
        'A Confluence root create must carry null parent references',
      );
    }
    actorId = await assertActorActive(client, intent);
    if (!(await getUserAccessibleSpaces(actorId, client)).includes(spaceKey)) {
      throw new PageWriteError(403, 'intent_access_changed', 'The original actor no longer has space access');
    }
    parentReferenceId = null;
  } else {
    const parentPageId = intent.pageIds[0];
    if (parentPageId === undefined || intent.pageIds.length !== 1) {
      throw new PageWriteError(
        409,
        'intent_recovery_metadata_invalid',
        'A Confluence child create must reference one local parent',
      );
    }
    if (positiveInteger(intent.effect.parentPageId, 'parentPageId') !== parentPageId) {
      throw new PageWriteError(
        409,
        'intent_recovery_metadata_invalid',
        'The referenced parent does not match the durable target',
      );
    }
    actorId = await assertPageAccess(client, intent, parentPageId);
    const rawParentConfluenceId = intent.effect.parentConfluenceId;
    if (
      rawParentConfluenceId !== null &&
      (typeof rawParentConfluenceId !== 'string' || rawParentConfluenceId.length === 0)
    ) {
      throw new PageWriteError(409, 'intent_recovery_metadata_invalid', 'Missing parentConfluenceId');
    }
    const parentConfluenceId = rawParentConfluenceId as string | null;
    const parentSource = parentConfluenceId === null ? 'standalone' : 'confluence';
    parentReferenceId = parentConfluenceId ?? String(parentPageId);
    const parent = await client.query(
      `SELECT 1 FROM pages
        WHERE id = $1 AND source = $2
          AND ($3::text IS NULL OR confluence_id = $3)
          AND space_key = $4 AND deleted_at IS NULL`,
      [parentPageId, parentSource, parentConfluenceId, spaceKey],
    );
    if (parent.rowCount !== 1) {
      throw new PageWriteError(
        409,
        'intent_parent_identity_changed',
        'The referenced parent is no longer available',
      );
    }
  }
  if (intent.remoteEffectStartedAt === null) {
    return remoteNotStarted(
      `confluence-page-create:${parentReferenceId ?? `root:${spaceKey}`}:not-dispatched`,
      { parentPageId: intent.pageIds[0] ?? null },
    );
  }
  if (intent.remoteEffectsCompletedAt === null) {
    throw new PageWriteError(
      409,
      'intent_outcome_unrecoverable',
      'The remote page creation outcome is unknown',
    );
  }
  const terminal = terminalResult(intent);
  const confluence = await getClientForUser(actorId, client);
  if (!confluence) {
    throw new PageWriteError(
      409,
      'intent_provider_unavailable',
      'The original Confluence connection is unavailable',
    );
  }
  const observed = await confirmPagePublication(confluence, terminal);
  const storage = observed.body.storage.value;
  const titleDigest = createHash('sha256').update(observed.title).digest('hex');
  const storageDigest = createHash('sha256').update(storage).digest('hex');
  if (titleDigest !== expectedTitleDigest || storageDigest !== expectedStorageDigest) {
    throw new PageWriteError(
      409,
      'intent_terminal_evidence_mismatch',
      'The acknowledged Confluence child differs from the requested publication',
    );
  }
  const published = await publishCreatedConfluencePage(client, {
    confluenceId: terminal.confluenceId,
    spaceKey,
    parentConfluenceId: parentReferenceId,
    title: observed.title,
    storage,
    version: observed.version.number,
    ...initialPolicyFromEffect(intent.effect),
    actorId,
    recoveryIntentId: intent.id,
  });
  await reservePolicyLabelSynchronization(client, actorId, published.id);
  await enqueuePageWriteInvalidation(client, intent.id);
  return {
    outcome: 'applied',
    proof: {
      kind: 'remote_terminal_effect_verified',
      observedAt: new Date().toISOString(),
      reference: `confluence-page-create:${terminal.confluenceId}:${storageDigest}`,
      details: { remoteEffectsCompleted: true, terminalEvidence: storageDigest },
    },
    result: { pageId: published.id, confluenceId: terminal.confluenceId },
  };
};

type LabelCompensationPlan = { before: string[]; after: string[]; remove: string[] };

const compensateGeneratedLabels: PageWriteIntentRepairer = async (intent) => {
  const prepared = await advancePageWriteIntent(intent, async (client) => {
    const pageId = intent.pageIds[0]!;
    const actorId = await assertPageAccess(client, intent, pageId);
    const saved = await client.query<{ plan: LabelCompensationPlan; next_step: number; in_flight: boolean }>(
      'SELECT plan, next_step, in_flight FROM page_generated_label_compensations WHERE intent_id = $1', [intent.id]);
    if (saved.rows[0]?.in_flight) {
      throw new PageWriteError(409, 'intent_outcome_unrecoverable', 'A compensation response was not durably acknowledged');
    }
    if (!saved.rows[0]) {
      try {
        await validateAutoTagPublicationOnClient(client, intent.effect.autoTagStage as ArticleTransportStage, actorId, pageId);
        return null;
      } catch (error) {
        // Only an authoritative obsolete-stage refusal permits compensation;
        // infrastructure errors are never permission to mutate remote state.
        if (!(error instanceof Error) || error.name !== 'ArticleStageRefusedError') throw error;
      }
      const current = await client.query<{ labels: string[]; ai_policy: AiPolicy }>(
        'SELECT labels, ai_policy FROM pages WHERE id = $1 AND confluence_id = $2 AND deleted_at IS NULL',
        [pageId, stringValue(intent.effect.confluenceId, 'confluenceId')]);
      if (!current.rows[0]) throw new PageWriteError(409, 'intent_local_identity_changed', 'Label target changed');
      const prefix = await acknowledgedGeneratedLabelPrefix(client, intent.id);
      if (!prefix && intent.remoteEffectsCompletedAt === null) {
        throw new PageWriteError(409, 'intent_outcome_unrecoverable', 'Generated request outcome is unknown');
      }
      const before = exactLabels(prefix?.after ?? intent.effect.targetLabels);
      const prior = exactLabels(intent.effect.priorLabels);
      const remove = before.filter((label) => !prior.includes(label) && reservedAiPolicyLabel(label) === null);
      // Generated tagging is additive only. Never restore deleted human labels.
      if (prior.some((label) => reservedAiPolicyLabel(label) === null && !before.includes(label))) {
        throw new PageWriteError(409, 'intent_recovery_metadata_invalid', 'Generated effect was not additive');
      }
      const after = applyCanonicalAiPolicyLabel(before.filter((label) => !remove.includes(label)), current.rows[0].ai_policy).sort();
      const plan = { before, after, remove };
      await client.query('INSERT INTO page_generated_label_compensations (intent_id, plan) VALUES ($1, $2::jsonb)',
        [intent.id, JSON.stringify(plan)]);
      return { actorId, plan, nextStep: 0 };
    }
    return { actorId, plan: saved.rows[0].plan, nextStep: saved.rows[0].next_step };
  });
  if (!prepared) return;
  const confluence = await getClientForUser(prepared.actorId);
  if (!confluence) throw new PageWriteError(409, 'intent_provider_unavailable', 'Confluence connection unavailable');
  const confluenceId = stringValue(intent.effect.confluenceId, 'confluenceId');
  const observed = exactLabels(await confluence.getLabels(confluenceId));
  const { before, after } = prepared.plan;
  // Retry permits only the exact prefix states of our ordered removal/addition
  // sequence. Any independently changed label set remains an explicit conflict.
  const removals = before.filter((label) => !after.includes(label));
  const additions = after.filter((label) => !before.includes(label));
  const states = [before];
  for (const label of removals) states.push(states[states.length - 1]!.filter((item) => item !== label));
  for (const label of additions) states.push([...states[states.length - 1]!, label].sort());
  const index = prepared.nextStep;
  if (!states[index] || !sameLabelSet(states[index]!, observed)) {
    throw new PageWriteError(409, 'intent_terminal_evidence_mismatch', 'Remote labels changed independently; compensation refused');
  }
  await advancePageWriteIntent(intent, async (client) => {
    await client.query('UPDATE page_generated_label_compensations SET started_at = COALESCE(started_at, NOW()) WHERE intent_id = $1', [intent.id]);
  });
  for (let step = index; step < states.length - 1; step++) {
    if (!sameLabelSet(await confluence.getLabels(confluenceId), states[step]!)) {
      throw new PageWriteError(409, 'intent_terminal_evidence_mismatch', 'Remote labels changed during compensation');
    }
    await advancePageWriteIntent(intent, async (client) => {
      await client.query('UPDATE page_generated_label_compensations SET in_flight = TRUE WHERE intent_id = $1', [intent.id]);
    });
    if (step < removals.length) await confluence.removeLabel(confluenceId, removals[step]!);
    else await confluence.addLabels(confluenceId, [additions[step - removals.length]!]);
    await advancePageWriteIntent(intent, async (client) => {
      await client.query('UPDATE page_generated_label_compensations SET in_flight = FALSE, next_step = $2 WHERE intent_id = $1', [intent.id, step + 1]);
    });
  }
  if (!sameLabelSet(await confluence.getLabels(confluenceId), after)) {
    throw new PageWriteError(409, 'intent_terminal_evidence_mismatch', 'Compensation could not be verified');
  }
  await advancePageWriteIntent(intent, async (client) => {
    await client.query('UPDATE page_generated_label_compensations SET completed_at = NOW() WHERE intent_id = $1', [intent.id]);
  });
};

type CanonicalRepairPlan = {
  before: string[]; after: string[]; policy: AiPolicy; policyRevision: string;
};

async function canonicalRepairAuthority(client: PoolClient, intent: PageWriteRecoveryIntent) {
  const pageId = intent.pageIds[0]!;
  const actorId = await assertPageAccess(client, intent, pageId);
  await lockAiPolicyForPages(client, [pageId]);
  const current = await client.query<{ labels: string[]; ai_policy: AiPolicy; ai_policy_revision: string; space_key: string }>(
    `SELECT labels, ai_policy, ai_policy_revision::text, space_key FROM pages
      WHERE id = $1 AND confluence_id = $2 AND source = 'confluence' AND deleted_at IS NULL FOR UPDATE`,
    [pageId, stringValue(intent.effect.confluenceId, 'confluenceId')]);
  const row = current.rows[0];
  if (!row) throw new PageWriteError(409, 'intent_local_identity_changed', 'Label target changed');
  if (!await isSystemAdmin(actorId, client) && !(await getUserAccessibleSpaces(actorId, client)).includes(row.space_key)) {
    throw new PageWriteError(403, 'intent_access_changed', 'Original label authority changed');
  }
  const before = exactLabels(intent.effect.targetLabels);
  const planned = planLabelPolicyChange({ currentPolicy: row.ai_policy, currentLabels: row.labels, targetLabels: before });
  return { actorId, row, before, planned };
}

const repairCanonicalLabels: PageWriteIntentRepairer = async (intent) => {
  const prepared = await advancePageWriteIntent(intent, async (client) => {
    const authority = await canonicalRepairAuthority(client, intent);
    const saved = await client.query<{ plan: CanonicalRepairPlan; next_step: number; in_flight: boolean }>(
      'SELECT plan, next_step, in_flight FROM page_label_canonical_repairs WHERE intent_id = $1', [intent.id]);
    if (!saved.rows[0] && sameLabelSet(authority.before, authority.planned.labels)) return null;
    // Only spelling/absence of the reserved slot may be repaired. A historical
    // policy command must never be replayed over current policy authority.
    const prior = exactLabels(intent.effect.priorLabels);
    const removedReservedSlot = !authority.before.some((label) => reservedAiPolicyLabel(label) !== null)
      && prior.some((label) => reservedAiPolicyLabel(label) !== null);
    if (authority.planned.kind !== 'unchanged' || removedReservedSlot) {
      throw new PageWriteError(409, 'intent_terminal_evidence_mismatch', 'Canonical repair cannot change policy');
    }
    const plan: CanonicalRepairPlan = { before: authority.before, after: authority.planned.labels.sort(),
      policy: authority.row.ai_policy, policyRevision: authority.row.ai_policy_revision };
    const savedRow = saved.rows[0];
    if (savedRow && (JSON.stringify(savedRow.plan) !== JSON.stringify(plan))) {
      // JSONB key ordering is not significant.
      if (!sameLabelSet(savedRow.plan.before, plan.before) || !sameLabelSet(savedRow.plan.after, plan.after)
        || savedRow.plan.policy !== plan.policy || savedRow.plan.policyRevision !== plan.policyRevision) {
        throw new PageWriteError(409, 'intent_terminal_evidence_mismatch', 'Canonical repair authority changed');
      }
    }
    if (savedRow?.in_flight) throw new PageWriteError(409, 'intent_outcome_unrecoverable', 'Canonical request outcome is unknown');
    if (!savedRow) await client.query('INSERT INTO page_label_canonical_repairs (intent_id, plan) VALUES ($1, $2::jsonb)',
      [intent.id, JSON.stringify(plan)]);
    return { actorId: authority.actorId, plan, nextStep: savedRow?.next_step ?? 0 };
  });
  if (!prepared) return;
  const confluence = await getClientForUser(prepared.actorId);
  if (!confluence) throw new PageWriteError(409, 'intent_provider_unavailable', 'Confluence connection unavailable');
  const confluenceId = stringValue(intent.effect.confluenceId, 'confluenceId');
  const { before, after } = prepared.plan;
  const removals = before.filter((label) => !after.includes(label));
  const additions = after.filter((label) => !before.includes(label));
  if ([...removals, ...additions].some((label) => reservedAiPolicyLabel(label) === null)) {
    throw new PageWriteError(409, 'intent_recovery_metadata_invalid', 'Repair is not canonical-only');
  }
  const states = [before];
  for (const label of removals) states.push(states[states.length - 1]!.filter((value) => value !== label));
  for (const label of additions) states.push([...states[states.length - 1]!, label].sort());
  const checkpoint = async (step: number, update: (client: PoolClient) => Promise<unknown>) => {
    await advancePageWriteIntent(intent, async (client) => {
      const authority = await canonicalRepairAuthority(client, intent);
      if (authority.row.ai_policy !== prepared.plan.policy || authority.row.ai_policy_revision !== prepared.plan.policyRevision
        || !sameLabelSet(authority.planned.labels, after)) {
        throw new PageWriteError(409, 'intent_terminal_evidence_mismatch', 'Canonical repair authority changed');
      }
      const progress = await client.query<{ next_step: number; in_flight: boolean }>(
        'SELECT next_step, in_flight FROM page_label_canonical_repairs WHERE intent_id = $1 FOR UPDATE', [intent.id]);
      if (progress.rows[0]?.next_step !== step) throw new PageWriteError(409, 'intent_repair_incomplete', 'Canonical repair progress changed');
      await update(client);
    });
  };
  if (!states[prepared.nextStep] || !sameLabelSet(await confluence.getLabels(confluenceId), states[prepared.nextStep]!)) {
    throw new PageWriteError(409, 'intent_terminal_evidence_mismatch', 'Remote labels differ from acknowledged evidence');
  }
  await checkpoint(prepared.nextStep, (client) => client.query(
    'UPDATE page_label_canonical_repairs SET observed_at = COALESCE(observed_at, NOW()) WHERE intent_id = $1', [intent.id]));
  for (let step = prepared.nextStep; step < states.length - 1; step++) {
    if (!sameLabelSet(await confluence.getLabels(confluenceId), states[step]!)) {
      throw new PageWriteError(409, 'intent_terminal_evidence_mismatch', 'Remote labels changed during canonical repair');
    }
    await checkpoint(step, (client) => client.query(
      'UPDATE page_label_canonical_repairs SET in_flight = TRUE WHERE intent_id = $1', [intent.id]));
    if (step < removals.length) await confluence.removeLabel(confluenceId, removals[step]!);
    else await confluence.addLabels(confluenceId, [additions[step - removals.length]!]);
    await checkpoint(step, (client) => client.query(
      `UPDATE page_label_canonical_repairs SET in_flight = FALSE, next_step = $2,
        outcomes = outcomes || jsonb_build_array(jsonb_build_object('step', $3::int, 'acknowledgedAt', NOW())) WHERE intent_id = $1`,
      [intent.id, step + 1, step]));
  }
  if (!sameLabelSet(await confluence.getLabels(confluenceId), after)) {
    throw new PageWriteError(409, 'intent_terminal_evidence_mismatch', 'Canonical remote result not verified');
  }
  await checkpoint(states.length - 1, (client) => client.query(
    'UPDATE page_label_canonical_repairs SET completed_at = NOW() WHERE intent_id = $1 AND NOT in_flight', [intent.id]));
};

const dispatchCommittedPolicyLabels: PageWriteIntentRepairer = async (intent) => {
  const confluence = await advancePageWriteIntent(intent, async (client) => {
    const pageId = intent.pageIds[0]!;
    const actorId = await assertPageAccess(client, intent, pageId);
    if (!await canMutateAiPolicy(actorId, pageId, client)) {
      throw new PageWriteError(403, 'intent_access_changed', 'Policy authority changed');
    }
    const row = await client.query<{ labels: string[]; ai_policy_revision: string }>(
      'SELECT labels, ai_policy_revision::text FROM pages WHERE id = $1 AND confluence_id = $2',
      [pageId, stringValue(intent.effect.confluenceId, 'confluenceId')]);
    if (!row.rows[0] || row.rows[0].ai_policy_revision !== intent.effect.policyRevision
      || !sameLabelSet(row.rows[0].labels, exactLabels(intent.effect.targetLabels))) {
      throw new PageWriteError(409, 'intent_terminal_evidence_mismatch', 'Committed policy changed');
    }
    const provider = await getClientForUser(actorId, client);
    if (!provider) throw new PageWriteError(409, 'intent_provider_unavailable', 'Confluence is unavailable');
    return provider;
  });
  const id = stringValue(intent.effect.confluenceId, 'confluenceId');
  const desired = exactLabels(intent.effect.targetLabels);
  const prior = await confluence.getLabels(id);
  await runPageWriteIntentEffect(intent, { kind: 'remote', completesRemoteWork: true }, async () => {
    const added = desired.filter((label) => !prior.includes(label));
    if (added.length) await confluence.addLabels(id, added);
    for (const label of prior.filter((label) => !desired.includes(label))) await confluence.removeLabel(id, label);
    if (!sameLabelSet(await confluence.getLabels(id), desired)) {
      throw new PageWriteError(409, 'intent_terminal_evidence_mismatch', 'Remote label target differs');
    }
  });
};

const reconcileLabels: PageWriteIntentReconciler = async (client, intent) => {
  const pageId = intent.pageIds[0];
  if (pageId === undefined || intent.pageIds.length !== 1) {
    throw new PageWriteError(409, 'intent_recovery_metadata_invalid', 'A label intent must cover one page');
  }
  const actorId = await assertPageAccess(client, intent, pageId);
  const confluenceId = stringValue(intent.effect.confluenceId, 'confluenceId');
  let desired = exactLabels(intent.effect.targetLabels);
  const canonicalRepair = await client.query<{ plan: CanonicalRepairPlan; completed_at: Date | null; in_flight: boolean }>(
    'SELECT plan, completed_at, in_flight FROM page_label_canonical_repairs WHERE intent_id = $1', [intent.id]);
  const repaired = canonicalRepair.rows[0];
  if (repaired) {
    const authority = await canonicalRepairAuthority(client, intent);
    if (!repaired.completed_at || repaired.in_flight || !sameLabelSet(repaired.plan.before, desired)
      || authority.row.ai_policy !== repaired.plan.policy || authority.row.ai_policy_revision !== repaired.plan.policyRevision
      || !sameLabelSet(authority.planned.labels, repaired.plan.after)) {
      throw new PageWriteError(409, 'intent_terminal_evidence_mismatch', 'Canonical repair is not current and verified');
    }
    desired = repaired.plan.after;
  }
  if (Object.hasOwn(intent.effect, 'autoTagStage') && intent.remoteEffectStartedAt === null) {
    // No generated label reached Confluence and this writer publishes local
    // labels only after the remote phase. There is nothing to compensate.
    // In particular, neither stale AI authority nor historical priorLabels
    // may prevent settlement or overwrite today's authoritative policy labels.
    const current = await client.query<{ labels: string[] }>(
      'SELECT labels FROM pages WHERE id = $1 AND confluence_id = $2 AND deleted_at IS NULL',
      [pageId, confluenceId],
    );
    if (!current.rows[0]) {
      throw new PageWriteError(409, 'intent_local_identity_changed', 'The local label target changed');
    }
    return remoteNotStarted(`confluence-labels:${confluenceId}:not-dispatched`, current.rows[0].labels);
  }
  if (Object.hasOwn(intent.effect, 'autoTagStage')) {
    const compensation = await client.query<{ plan: LabelCompensationPlan; completed_at: Date | null }>(
      'SELECT plan, completed_at FROM page_generated_label_compensations WHERE intent_id = $1', [intent.id]);
    if (compensation.rows[0]) {
      const repaired = compensation.rows[0];
      if (!repaired.completed_at) throw new PageWriteError(409, 'intent_repair_incomplete', 'Compensation is not verified');
      const current = await client.query<{ labels: string[]; ai_policy: AiPolicy }>(
        'SELECT labels, ai_policy FROM pages WHERE id = $1 AND confluence_id = $2', [pageId, confluenceId]);
      const row = current.rows[0];
      if (!row || !sameLabelSet(applyCanonicalAiPolicyLabel(repaired.plan.after, row.ai_policy), repaired.plan.after)) {
        throw new PageWriteError(409, 'intent_terminal_evidence_mismatch', 'Authoritative policy changed during compensation');
      }
      // Preserve current human/local labels; remove only the exact generated delta.
      const labels = applyCanonicalAiPolicyLabel(row.labels.filter((label) => !repaired.plan.remove.includes(label)), row.ai_policy);
      await client.query('UPDATE pages SET labels = $2 WHERE id = $1', [pageId, labels]);
      await enqueuePageWriteInvalidation(client, intent.id);
      return { outcome: 'not_applied', result: labels,
        proof: { kind: 'generated_labels_compensated', observedAt: new Date().toISOString(),
          reference: `generated-label-compensation:${intent.id}`,
          details: { compensationIntentId: intent.id } } };
    }
    const stage = intent.effect.autoTagStage;
    if (!stage || typeof stage !== 'object') {
      throw new PageWriteError(409, 'intent_recovery_metadata_invalid', 'Generated-label authority is unavailable');
    }
    await validateAutoTagPublicationOnClient(client, stage as ArticleTransportStage, actorId, pageId);
  }
  const localPolicyCommitted = intent.effect.localPolicyCommitted === true
    && (intent.kind === 'pages.bulk.tags' || intent.kind === 'pages.bulk.replace_tags' || intent.kind === 'pages.create.labels');
  if (localPolicyCommitted && intent.remoteEffectsCompletedAt === null) {
    // Local policy/labels committed for the WHOLE selection before dispatch.
    // Never restore prior labels or independently re-apply part of the bulk.
    // Uncertain/undispatched write-back remains explicitly pending for repair.
    throw new PageWriteError(409, 'intent_outcome_unrecoverable',
      'Bulk policy is committed locally; remote label synchronization remains pending');
  }
  if (intent.remoteEffectStartedAt === null) {
    // Settling an undispatched intent restores the labels as they were. The
    // prior set is NOT re-read as a policy command: nothing reached the
    // provider, the policy row was never part of this intent, and
    // reinterpreting a restored label would move `ai_policy` without a
    // writer having asked for it.
    const prior = exactLabels(intent.effect.priorLabels);
    await client.query('UPDATE pages SET labels = $2 WHERE id = $1', [pageId, prior]);
    await enqueuePageWriteInvalidation(client, intent.id);
    return remoteNotStarted(`confluence-labels:${confluenceId}:not-dispatched`, prior);
  }
  if (intent.remoteEffectsCompletedAt === null) {
    throw new PageWriteError(409, 'intent_outcome_unrecoverable', 'The remote label outcome is unknown');
  }
  const confluence = await getClientForUser(actorId, client);
  if (!confluence) {
    throw new PageWriteError(409, 'intent_provider_unavailable', 'The original Confluence connection is unavailable');
  }
  const observed = [...new Set(await confluence.getLabels(confluenceId))].sort();
  if (observed.length !== desired.length || observed.some((label, index) => label !== desired[index])) {
    throw new PageWriteError(
      409,
      'intent_terminal_evidence_mismatch',
      'Confluence labels no longer match the terminal mutation; the intent remains pending',
    );
  }
  if (localPolicyCommitted) {
    const current = await client.query<{ labels: string[] }>('SELECT labels FROM pages WHERE id = $1', [pageId]);
    if (!current.rows[0] || !sameLabelSet(current.rows[0].labels, desired)) {
      throw new PageWriteError(409, 'intent_terminal_evidence_mismatch', 'The committed bulk label target changed');
    }
    await enqueuePageWriteInvalidation(client, intent.id);
    const digest = createHash('sha256').update(JSON.stringify(desired)).digest('hex');
    return {
      outcome: 'applied',
      proof: { kind: 'remote_terminal_effect_verified', observedAt: new Date().toISOString(),
        reference: `confluence-labels:${confluenceId}:${digest}`,
        details: { remoteEffectsCompleted: true, terminalEvidence: digest } },
      result: desired,
    };
  }
  // The provider holds the intended set; the local row now takes it through
  // the policy primitive so `ai_policy`, its revision and the label set land
  // in this same recovery transaction — exactly as the original writer would
  // have committed them. The policy lock precedes the row lock the
  // primitive takes; recovery holds no earlier `FOR UPDATE` on `pages`.
  const applied = await applyPageLabelsOnClient(client, {
    userId: actorId, pageId, targetLabels: desired, recoveryIntentId: intent.id,
  });
  // The local plan is re-made from the row as it is NOW. If a later,
  // authoritative policy write (e.g. the policy endpoint relaxed the page
  // and the canonical label is restored, or a stricter policy landed) makes
  // the local set diverge from what the provider holds, the mirror and the
  // authority would disagree: that is never claimed as an applied mirror.
  // The intent stays pending (the transaction rolls back) for the operator.
  if (!sameLabelSet(applied.labels, desired)) {
    throw new PageWriteError(
      409,
      'intent_terminal_evidence_mismatch',
      'The local AI policy no longer admits the labels Confluence holds; the intent remains pending',
    );
  }
  await enqueuePageWriteInvalidation(client, intent.id);
  const digest = createHash('sha256').update(JSON.stringify(desired)).digest('hex');
  return {
    outcome: 'applied',
    proof: {
      kind: 'remote_terminal_effect_verified',
      observedAt: new Date().toISOString(),
      reference: `confluence-labels:${confluenceId}:${digest}`,
      details: { remoteEffectsCompleted: true, terminalEvidence: digest },
    },
    result: applied.labels,
  };
};

export function sameLabelSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = [...new Set(a)].sort();
  const sb = [...new Set(b)].sort();
  return sa.length === sb.length && sa.every((label, i) => label === sb[i]);
}

const reconcilePagePut: PageWriteIntentReconciler = async (client, intent) => {
  const pageId = intent.pageIds[0];
  if (pageId === undefined || intent.pageIds.length !== 1) {
    throw new PageWriteError(409, 'intent_recovery_metadata_invalid', 'A page publication must cover one page');
  }
  const actorId = await assertPageAccess(client, intent, pageId);
  const expectedConfluenceId = stringValue(intent.effect.confluenceId, 'confluenceId');
  if (intent.remoteEffectStartedAt === null) {
    if (intent.kind === 'pages.draft.publish.confluence') {
      await enqueuePageWriteInvalidation(client, intent.id);
    }
    return remoteNotStarted(`confluence-page:${expectedConfluenceId}:not-dispatched`, { pageId });
  }
  if (intent.remoteEffectsCompletedAt === null) {
    throw new PageWriteError(409, 'intent_outcome_unrecoverable', 'The remote page outcome is unknown');
  }
  const terminal = terminalResult(intent);
  if (terminal.confluenceId !== expectedConfluenceId) {
    throw new PageWriteError(409, 'intent_terminal_result_invalid', 'The page acknowledgment names another operation target');
  }
  const confluence = await getClientForUser(actorId, client);
  if (!confluence) {
    throw new PageWriteError(409, 'intent_provider_unavailable', 'The original Confluence connection is unavailable');
  }
  const observed = await confirmPagePublication(confluence, terminal);
  const storage = observed.body.storage.value;
  const storageDigest = createHash('sha256').update(storage).digest('hex');
  const local = await client.query<{ space_key: string | null }>(
    `SELECT space_key FROM pages WHERE id = $1 AND confluence_id = $2 AND source = 'confluence'`,
    [pageId, expectedConfluenceId],
  );
  if (!local.rows[0]) {
    throw new PageWriteError(409, 'intent_local_identity_changed', 'The local page identity changed after admission');
  }
  const bodyHtml = (await materializeDrawioPreviews(
    confluenceToHtml(storage, expectedConfluenceId, local.rows[0].space_key ?? undefined),
    expectedConfluenceId,
  )).html;
  const resetDerivedWork = intent.kind === 'pages.update.confluence';
  await client.query(
    `UPDATE pages SET
       title = $2, body_storage = $3, body_html = $4, body_text = $5,
       version = $6, last_synced = NOW(), embedding_dirty = TRUE,
       image_analysis_dirty = CASE WHEN body_html IS DISTINCT FROM $4 THEN TRUE ELSE image_analysis_dirty END,
       embedding_status = 'not_embedded', embedded_at = NULL,
       last_modified_at = NOW(), local_modified_at = NULL, local_modified_by = NULL,
       summary_status = CASE WHEN $7::boolean THEN 'pending' ELSE summary_status END,
       summary_retry_count = CASE WHEN $7::boolean THEN 0 ELSE summary_retry_count END,
       quality_status = CASE WHEN $7::boolean THEN 'pending' ELSE quality_status END,
       quality_retry_count = CASE WHEN $7::boolean THEN 0 ELSE quality_retry_count END
     WHERE id = $1`,
    [
      pageId,
      observed.title,
      storage,
      bodyHtml,
      htmlToText(bodyHtml),
      observed.version.number,
      resetDerivedWork,
    ],
  );
  await enqueuePageWriteInvalidation(client, intent.id);
  return {
    outcome: 'applied',
    proof: {
      kind: 'remote_terminal_effect_verified',
      observedAt: new Date().toISOString(),
      reference: `confluence-page:${expectedConfluenceId}:v${observed.version.number}`,
      details: { remoteEffectsCompleted: true, terminalEvidence: storageDigest },
    },
    result: { pageId, version: observed.version.number },
  };
};

const reconcileDelete: PageWriteIntentReconciler = async (client, intent) => {
  const pageId = intent.pageIds[0];
  if (pageId === undefined || intent.pageIds.length !== 1) {
    throw new PageWriteError(409, 'intent_recovery_metadata_invalid', 'A delete intent must cover one page');
  }
  const actorId = await assertActorActive(client, intent);
  const expectedConfluenceId = stringValue(intent.effect.confluenceId, 'confluenceId');
  const spaceKey = stringValue(intent.effect.spaceKey, 'spaceKey');
  if (!(await getUserAccessibleSpaces(actorId, client)).includes(spaceKey)) {
    throw new PageWriteError(403, 'intent_access_changed', 'The original actor no longer has space access');
  }
  if (intent.remoteEffectStartedAt === null) {
    await client.query('UPDATE pages SET deleted_at = NULL WHERE id = $1', [pageId]);
    await enqueuePageWriteInvalidation(client, intent.id);
    return remoteNotStarted(`confluence-page:${expectedConfluenceId}:not-dispatched`, { pageId });
  }
  if (intent.remoteEffectsCompletedAt === null) {
    throw new PageWriteError(409, 'intent_outcome_unrecoverable', 'The remote delete outcome is unknown');
  }
  const terminal = terminalResult(intent);
  if (terminal.confluenceId !== expectedConfluenceId || terminal.outcome !== 'deleted') {
    throw new PageWriteError(409, 'intent_terminal_result_invalid', 'The delete terminal identity is incomplete');
  }
  const confluence = await getClientForUser(actorId, client);
  if (!confluence) {
    throw new PageWriteError(409, 'intent_provider_unavailable', 'The original Confluence connection is unavailable');
  }
  let absent = false;
  try {
    const observed = await confluence.getPage(expectedConfluenceId);
    absent = observed.status === 'trashed';
  } catch (error) {
    absent = error instanceof ConfluenceError && error.statusCode === 404;
    if (!absent) throw error;
  }
  if (!absent) {
    throw new PageWriteError(409, 'intent_terminal_evidence_mismatch', 'The remote page is still live');
  }
  await client.query('DELETE FROM pinned_pages WHERE page_id = $1', [pageId]);
  await client.query('DELETE FROM pages WHERE id = $1', [pageId]);
  // A retained cache directory is not a completed deletion. Reuse the held
  // SQL client so cleanup cannot wait for a second connection from this pool.
  await cleanPageAttachments(expectedConfluenceId, { client, strict: true });
  await discardPageIconForDeletedPage({ id: pageId }, client);
  await enqueuePageWriteInvalidation(client, intent.id);
  return {
    outcome: 'applied',
    proof: {
      kind: 'remote_terminal_effect_verified',
      observedAt: new Date().toISOString(),
      reference: `confluence-page:${expectedConfluenceId}:absent`,
      details: { remoteEffectsCompleted: true, terminalEvidence: 'remote-page-absent' },
    },
    result: { pageId },
    // 4404 is permanent. Unlike the local-delete siblings, this row is
    // destroyed by the settlement transaction itself, so close the rooms only
    // after that COMMIT; doing it in here would also wait on our own page
    // lifecycle lock, which a writable room's final flush takes.
    afterCommit: () => tombstoneCollabRoomAfterCommit(pageId),
  };
};
const LOCAL_DELETE_KINDS = [
  'pages.delete.standalone',
  'pages.delete.local',
  'pages.bulk.delete.local',
] as const;

function sameIds(left: readonly number[], right: readonly number[]): boolean {
  const a = [...left].sort((first, second) => first - second);
  const b = [...right].sort((first, second) => first - second);
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function requireCommittedDeletion(intent: PageWriteRecoveryIntent): number[] {
  if (intent.effect.effectClass !== 'local') {
    throw new PageWriteError(409, 'intent_recovery_metadata_invalid', 'The local delete effect class is invalid');
  }
  if (
    intent.pageIds.length === 0 ||
    new Set(intent.pageIds).size !== intent.pageIds.length ||
    intent.pageIds.some((id) => !Number.isSafeInteger(id) || id <= 0)
  ) {
    throw new PageWriteError(409, 'intent_recovery_metadata_invalid', 'The local delete page identity is invalid');
  }
  if (
    new Set(intent.deletedPageIds).size !== intent.deletedPageIds.length ||
    intent.deletedPageIds.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
    intent.deletedPageIds.some((id) => !intent.pageIds.includes(id))
  ) {
    throw new PageWriteError(409, 'intent_recovery_metadata_invalid', 'The committed delete tombstone is invalid');
  }
  return [...intent.deletedPageIds].sort((first, second) => first - second);
}

function standaloneDeleteIds(intent: PageWriteRecoveryIntent): number[] {
  const deletedIds = requireCommittedDeletion(intent);
  const rootPageId = intent.effect.rootPageId;
  const targetCount = intent.effect.targetCount;
  const stores = intent.effect.attachmentStores;
  if (
    typeof rootPageId !== 'number' ||
    !Number.isSafeInteger(rootPageId) ||
    !intent.pageIds.includes(rootPageId) ||
    targetCount !== intent.pageIds.length ||
    !Array.isArray(stores) ||
    stores.length !== 3 ||
    stores[0] !== 'attachment-cache' ||
    stores[1] !== 'local' ||
    stores[2] !== 'page-icons'
  ) {
    throw new PageWriteError(
      409,
      'intent_recovery_metadata_invalid',
      'The standalone delete descriptor does not identify the admitted deletion',
    );
  }
  return deletedIds;
}

function syncedDeleteIdentity(intent: PageWriteRecoveryIntent): {
  pageId: number;
  confluenceId: string;
  spaceKey: string;
  deleted: boolean;
} {
  const deletedIds = requireCommittedDeletion(intent);
  const pageId = intent.pageIds[0];
  if (
    pageId === undefined ||
    intent.pageIds.length !== 1 ||
    deletedIds.length > 1 ||
    (deletedIds.length === 1 && deletedIds[0] !== pageId) ||
    intent.effect.upstreamDelete !== false ||
    intent.effect.attachmentStore !== 'confluence' ||
    intent.effect.iconStore !== 'page-icons'
  ) {
    throw new PageWriteError(
      409,
      'intent_recovery_metadata_invalid',
      'The local Confluence-page delete descriptor is invalid',
    );
  }
  return {
    pageId,
    confluenceId: stringValue(intent.effect.confluenceId, 'confluenceId'),
    spaceKey: stringValue(intent.effect.spaceKey, 'spaceKey'),
    deleted: deletedIds.length === 1,
  };
}

async function assertConfluenceAttachmentKeyUnclaimed(
  client: PoolClient,
  identity: { pageId: number; confluenceId: string },
): Promise<void> {
  const claim = await client.query<{ id: number }>(
    `SELECT id FROM pages WHERE confluence_id = $1 LIMIT 1`,
    [identity.confluenceId],
  );
  if (claim.rows[0]) {
    throw new PageWriteError(
      409,
      'intent_local_identity_changed',
      'A current page now owns the deleted page attachment key',
    );
  }
}

async function attachmentCacheDirectoryAbsent(confluenceId: string): Promise<boolean> {
  try {
    await fs.stat(attachmentCacheDir(confluenceId));
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

function localDeleteNotApplied(reference: string, result: unknown) {
  return {
    outcome: 'not_applied' as const,
    proof: {
      kind: 'local_effect_absence_verified' as const,
      observedAt: new Date().toISOString(),
      reference,
      details: { syscallSettled: true as const, observedAbsent: true as const },
    },
    result,
  };
}

const reconcileLocalDelete: PageWriteIntentReconciler = async (client, intent) => {
  if (intent.kind === 'pages.delete.standalone') {
    const deletedIds = standaloneDeleteIds(intent);
    const identity = createHash('sha256')
      .update(JSON.stringify([
        intent.id,
        intent.kind,
        intent.effect.rootPageId,
        [...intent.pageIds].sort((first, second) => first - second),
      ]))
      .digest('hex');
    const reference = `standalone-pages:${identity}`;
    if (deletedIds.length === 0) {
      if (intent.effectStartedAt !== null) {
        throw new PageWriteError(
          409,
          'intent_local_evidence_mismatch',
          'The standalone delete started without a complete committed tombstone',
        );
      }
      return localDeleteNotApplied(reference, { deletedCount: 0 });
    }
    if (!sameIds(deletedIds, intent.pageIds)) {
      throw new PageWriteError(
        409,
        'intent_local_evidence_mismatch',
        'The standalone delete committed only part of its admitted page set',
      );
    }
    for (const pageId of deletedIds) {
      if (!await deletedStandaloneNamespacesAbsent({ id: pageId }, client)) {
        return { outcome: 'repair_required' as const, observedState: 'partially_applied' as const };
      }
    }
    // The shared cache namespace is deliberately not part of the proof: a live
    // Confluence key claim or the first-sync grace window requires preserving
    // it. Re-running the existing cleanup applies those rules without guessing.
    for (const pageId of deletedIds) {
      await cleanupStandalonePageAttachmentDirs({ id: pageId }, client);
      await tombstoneCollabRoomAfterCommit(pageId);
    }
    await enqueuePageWriteInvalidation(client, intent.id);
    return {
      outcome: 'applied' as const,
      proof: {
        kind: 'local_intended_absence_verified' as const,
        observedAt: new Date().toISOString(),
        reference,
        details: {
          syscallSettled: true as const,
          observedAbsent: true as const,
          intendedIdentity: `deleted-pages:${identity}`,
        },
      },
      result: { deletedCount: deletedIds.length },
    };
  }

  const identity = syncedDeleteIdentity(intent);
  const identityDigest = createHash('sha256')
    .update(JSON.stringify([
      intent.id,
      intent.kind,
      identity.pageId,
      identity.confluenceId,
      identity.spaceKey,
    ]))
    .digest('hex');
  const reference = `local-confluence-page:${identityDigest}`;
  if (!identity.deleted) {
    const current = await client.query<{
      source: string;
      confluence_id: string | null;
      space_key: string | null;
      deleted_at: Date | null;
    }>(
      `SELECT source, confluence_id, space_key, deleted_at
         FROM pages
        WHERE id = $1`,
      [identity.pageId],
    );
    const row = current.rows[0];
    if (
      !row ||
      row.source !== 'confluence' ||
      row.confluence_id !== identity.confluenceId ||
      row.space_key !== identity.spaceKey
    ) {
      throw new PageWriteError(
        409,
        'intent_local_identity_changed',
        'The local page identity changed after delete admission',
      );
    }
    // These kinds first hide the row, then hard-delete it. A crash before the
    // atomic DELETE proves the final mutation was not applied; undo only that
    // exact preparatory tombstone, never a row inferred from current config.
    if (row.deleted_at !== null) {
      await client.query('UPDATE pages SET deleted_at = NULL WHERE id = $1', [identity.pageId]);
      await enqueuePageWriteInvalidation(client, intent.id);
    }
    return localDeleteNotApplied(reference, { pageId: identity.pageId });
  }

  await assertConfluenceAttachmentKeyUnclaimed(client, identity);
  if (
    !await attachmentCacheDirectoryAbsent(identity.confluenceId) ||
    !await pageIconDirectoryAbsent(identity.pageId)
  ) {
    return { outcome: 'repair_required' as const, observedState: 'partially_applied' as const };
  }
  // Even with the directory already absent, repeat the cleanup service so its
  // Redis failure counters converge too. It is identity-bound and idempotent.
  await cleanPageAttachments(identity.confluenceId, { client, strict: true });
  await tombstoneCollabRoomAfterCommit(identity.pageId);
  await enqueuePageWriteInvalidation(client, intent.id);
  return {
    outcome: 'applied' as const,
    proof: {
      kind: 'local_intended_absence_verified' as const,
      observedAt: new Date().toISOString(),
      reference,
      details: {
        syscallSettled: true as const,
        observedAbsent: true as const,
        intendedIdentity: `deleted-page:${identityDigest}`,
      },
    },
    result: { pageId: identity.pageId },
  };
};

const repairLocalDelete: PageWriteIntentRepairer = async (intent) => {
  await advancePageWriteIntent(intent, async (client) => {
    if (intent.kind === 'pages.delete.standalone') {
      const deletedIds = standaloneDeleteIds(intent);
      if (!sameIds(deletedIds, intent.pageIds)) {
        throw new Error('Standalone deletion repair has no complete committed-page tombstone');
      }
      for (const pageId of deletedIds) {
        await cleanupStandalonePageAttachmentDirs({ id: pageId }, client);
        if (!await deletedStandaloneNamespacesAbsent({ id: pageId }, client)) {
          throw new Error(`Standalone deletion repair did not remove page ${pageId} namespaces`);
        }
      }
      return;
    }

    const identity = syncedDeleteIdentity(intent);
    if (!identity.deleted) {
      throw new Error('Local Confluence-page deletion repair has no committed-page tombstone');
    }
    await assertConfluenceAttachmentKeyUnclaimed(client, identity);
    await cleanPageAttachments(identity.confluenceId, { client, strict: true });
    await discardPageIconForDeletedPage({ id: identity.pageId }, client);
    if (
      !await attachmentCacheDirectoryAbsent(identity.confluenceId) ||
      !await pageIconDirectoryAbsent(identity.pageId)
    ) {
      throw new Error('Local Confluence-page deletion repair did not remove its exact namespaces');
    }
  });
};


let registered = false;

export function registerOrdinaryPageWriteReconcilers(): void {
  if (registered) return;
  for (const kind of LABEL_KINDS) registerPageWriteIntentReconciler(kind, reconcileLabels);
  registerGeneratedLabelCompensator(compensateGeneratedLabels);
  registerCanonicalLabelRepairer(repairCanonicalLabels);
  registerCommittedPolicyLabelDispatcher(dispatchCommittedPolicyLabels);
  registerPageWriteIntentReconciler('pages.create.confluence', reconcilePageCreate);
  registerPageWriteIntentReconciler('pages.update.confluence', reconcilePagePut);
  registerPageWriteIntentReconciler('pages.draft.publish.confluence', reconcilePagePut);
  registerPageWriteIntentReconciler('pages.delete.confluence', reconcileDelete);
  for (const kind of LOCAL_DELETE_KINDS) {
    registerPageWriteIntentReconciler(kind, reconcileLocalDelete, repairLocalDelete);
  }
  registerPageWriteIntentReconciler('pages.bulk.delete.remote', reconcileDelete);
  registered = true;
}
