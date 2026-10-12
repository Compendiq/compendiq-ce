import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import type { PoolClient } from 'pg';
import { confluenceToHtml, htmlToText } from '../../../core/services/content-converter.js';
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
  applyAiPolicyOnClient,
  applyPageLabelsOnClient,
  canonicalAiPolicyLabel,
  emitAiPolicyChanges,
  isAiPolicy,
  lockAiPolicyForPages,
  planLabelPolicyChange,
  reservedAiPolicyLabel,
  stricterPolicy,
  type AiPolicy,
  type AiPolicyChangeRecord,
} from '../../../core/services/ai-policy-service.js';
import {
  PageWriteError,
  advancePageWriteIntent,
  registerPageWriteIntentReconciler,
  type PageWriteIntentReconciler,
  type PageWriteRecoveryIntent,
  type PageWriteIntentRepairer,
} from '../../../core/services/page-write-admission.js';
import { getUserAccessibleSpaces, userCanAccessPage } from '../../../core/services/rbac-service.js';
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
  onPolicyChanges?: (changes: AiPolicyChangeRecord[]) => void;
}

export interface PublishedConfluencePage {
  id: number;
  labels: string[] | null;
  aiPolicy: AiPolicy;
  contentRevision: string;
  lifecycleRevision: string;
}

/**
 * Read the admitted first-publication policy from a durable create effect.
 * Malformed values are refused (409) rather than defaulted: a create whose
 * policy statement cannot be trusted is not published at `all`.
 */
export function initialPolicyFromEffect(effect: Record<string, unknown>): {
  initialPolicy: AiPolicy | undefined;
  initialLabels: string[] | undefined;
} {
  const rawPolicy = effect.initialPolicy;
  const rawLabels = effect.initialLabels;
  if (rawPolicy === undefined && rawLabels === undefined) {
    return { initialPolicy: undefined, initialLabels: undefined };
  }
  if (!isAiPolicy(rawPolicy)) {
    throw new PageWriteError(409, 'intent_recovery_metadata_invalid', 'The initial AI policy is invalid');
  }
  if (!Array.isArray(rawLabels) || rawLabels.some((label) => typeof label !== 'string')) {
    throw new PageWriteError(409, 'intent_recovery_metadata_invalid', 'The initial labels are invalid');
  }
  // Never looser than its own labels, even if the effect was edited.
  const planned = planLabelPolicyChange({ currentPolicy: 'all', currentLabels: [], targetLabels: rawLabels });
  return { initialPolicy: stricterPolicy(rawPolicy, planned.policy), initialLabels: planned.labels };
}

/**
 * Publish an acknowledged upstream create into the local corpus. Re-running
 * after an acknowledgement loss accepts only the exact already-published row;
 * an unrelated collision is never overwritten.
 */
export async function publishCreatedConfluencePage(
  client: PoolClient,
  publication: CreatedConfluencePagePublication,
): Promise<PublishedConfluencePage> {
  const bodyHtml = confluenceToHtml(
    publication.storage,
    publication.confluenceId,
    publication.spaceKey,
  );
  const bodyText = htmlToText(bodyHtml);
  const initialLabels = [...(publication.initialLabels ?? [])];
  const initialPolicy: AiPolicy = publication.initialPolicy ?? 'all';
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
      initialLabels,
      initialPolicy,
    ],
  );
  if (inserted.rows[0]) return inserted.rows[0];
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
  }>(
    `SELECT id, labels, ai_policy AS "aiPolicy", content_revision::text AS "contentRevision",
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
    publication.initialPolicy === undefined
    || stricterPolicy(row.aiPolicy, publication.initialPolicy) === row.aiPolicy
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
  const finalPolicy = publication.initialPolicy;
  const mergedLabels: string[] = [];
  for (const label of [...(row.labels ?? []), ...initialLabels]) {
    if (reservedAiPolicyLabel(label) !== null || mergedLabels.includes(label)) continue;
    mergedLabels.push(label);
  }
  // One canonical reserved label naming the policy the row now holds.
  mergedLabels.push(canonicalAiPolicyLabel(finalPolicy));
  const applied = await applyAiPolicyOnClient(client, {
    userId: publication.actorId,
    items: [{ pageId: row.id, policy: finalPolicy }],
  });
  if (!applied.ok) {
    throw new PageWriteError(409, applied.reason, 'The initial AI policy could not be applied to the published row');
  }
  const relabeled = await client.query<{ labels: string[] | null }>(
    `UPDATE pages SET labels = $2 WHERE id = $1 RETURNING labels`,
    [row.id, mergedLabels],
  );
  publication.onPolicyChanges?.(applied.changes);
  return {
    id: row.id,
    labels: relabeled.rows[0]?.labels ?? mergedLabels,
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
  const actorId = await assertPageAccess(client, intent, parentPageId);
  const rawParentConfluenceId = intent.effect.parentConfluenceId;
  if (
    rawParentConfluenceId !== null &&
    (typeof rawParentConfluenceId !== 'string' || rawParentConfluenceId.length === 0)
  ) {
    throw new PageWriteError(409, 'intent_recovery_metadata_invalid', 'Missing parentConfluenceId');
  }
  const parentConfluenceId = rawParentConfluenceId as string | null;
  const parentSource = parentConfluenceId === null ? 'standalone' : 'confluence';
  const parentReferenceId = parentConfluenceId ?? String(parentPageId);
  const spaceKey = stringValue(intent.effect.spaceKey, 'spaceKey');
  const expectedTitleDigest = sha256Value(intent.effect.titleSha256, 'titleSha256');
  const expectedStorageDigest = sha256Value(intent.effect.storageSha256, 'storageSha256');
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
  if (intent.remoteEffectStartedAt === null) {
    return remoteNotStarted(
      `confluence-page-create:${parentReferenceId}:not-dispatched`,
      { parentPageId },
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
  const createChanges: AiPolicyChangeRecord[] = [];
  const published = await publishCreatedConfluencePage(client, {
    confluenceId: terminal.confluenceId,
    spaceKey,
    parentConfluenceId: parentReferenceId,
    title: observed.title,
    storage,
    version: observed.version.number,
    ...initialPolicyFromEffect(intent.effect),
    actorId,
    onPolicyChanges: (changes) => { createChanges.push(...changes); },
  });
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
    // A sync-first row tightened here is a real transition: emitted by the
    // recovery driver strictly after its COMMIT (#281).
    afterCommit: createChanges.length > 0 ? () => emitAiPolicyChanges(createChanges) : undefined,
  };
};

const reconcileLabels: PageWriteIntentReconciler = async (client, intent) => {
  const pageId = intent.pageIds[0];
  if (pageId === undefined || intent.pageIds.length !== 1) {
    throw new PageWriteError(409, 'intent_recovery_metadata_invalid', 'A label intent must cover one page');
  }
  const actorId = await assertPageAccess(client, intent, pageId);
  const confluenceId = stringValue(intent.effect.confluenceId, 'confluenceId');
  const desired = exactLabels(intent.effect.targetLabels);
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
  // The provider holds the intended set; the local row now takes it through
  // the policy primitive so `ai_policy`, its revision and the label set land
  // in this same recovery transaction — exactly as the original writer would
  // have committed them. The policy lock precedes the row lock the
  // primitive takes; recovery holds no earlier `FOR UPDATE` on `pages`.
  const applied = await applyPageLabelsOnClient(client, { userId: actorId, pageId, targetLabels: desired });
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
  const changes: AiPolicyChangeRecord[] = applied.changes;
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
    // Emitted by the recovery driver strictly after its COMMIT (#281).
    afterCommit: changes.length > 0 ? () => emitAiPolicyChanges(changes) : undefined,
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
  const bodyHtml = confluenceToHtml(storage, expectedConfluenceId, local.rows[0].space_key ?? undefined);
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
