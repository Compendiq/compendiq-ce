import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { confluenceToHtml, htmlToText } from '../../../core/services/content-converter.js';
import { discardPageIconForDeletedPage } from '../../../core/services/page-icon-store.js';
import { enqueuePageWriteInvalidation } from '../../../core/services/page-write-invalidation.js';
import {
  PageWriteError,
  registerPageWriteIntentReconciler,
  type PageWriteIntentReconciler,
  type PageWriteRecoveryIntent,
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


const reconcileLabels: PageWriteIntentReconciler = async (client, intent) => {
  const pageId = intent.pageIds[0];
  if (pageId === undefined || intent.pageIds.length !== 1) {
    throw new PageWriteError(409, 'intent_recovery_metadata_invalid', 'A label intent must cover one page');
  }
  const actorId = await assertPageAccess(client, intent, pageId);
  const confluenceId = stringValue(intent.effect.confluenceId, 'confluenceId');
  const desired = exactLabels(intent.effect.targetLabels);
  if (intent.remoteEffectStartedAt === null) {
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
  await client.query('UPDATE pages SET labels = $2 WHERE id = $1', [pageId, desired]);
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
    result: desired,
  };
};

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

let registered = false;

export function registerOrdinaryPageWriteReconcilers(): void {
  if (registered) return;
  for (const kind of LABEL_KINDS) registerPageWriteIntentReconciler(kind, reconcileLabels);
  registerPageWriteIntentReconciler('pages.update.confluence', reconcilePagePut);
  registerPageWriteIntentReconciler('pages.draft.publish.confluence', reconcilePagePut);
  registerPageWriteIntentReconciler('pages.delete.confluence', reconcileDelete);
  registerPageWriteIntentReconciler('pages.bulk.delete.remote', reconcileDelete);
  registered = true;
}
