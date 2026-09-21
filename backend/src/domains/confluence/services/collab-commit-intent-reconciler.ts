import type { PoolClient } from 'pg';
import { confluenceToHtml, htmlToText } from '../../../core/services/content-converter.js';
import { enqueuePageWriteInvalidation } from '../../../core/services/page-write-invalidation.js';
import {
  userCanAccessPage,
  userCanEditPage,
} from '../../../core/services/rbac-service.js';
import {
  MAX_EFFECT_BYTES,
  PageWriteError,
  registerPageWriteIntentReconciler,
  type PageWriteIntentReconciler,
  type PageWriteRecoveryIntent,
} from '../../../core/services/page-write-admission.js';
import { confluencePagePutDigest } from './page-put-intent-reconciler.js';
import {
  confirmPagePublication,
} from './ordinary-page-write-reconciler.js';
import { getClientForUser } from './sync-service.js';

export interface CollabCommitImage {
  filename: string;
  mimeType: string;
  size: number;
  contentSha256: string;
}

export interface CollabCommitPublication {
  actorId: string;
  pageId: number;
  confluenceId: string;
  expectedRemoteVersion: number;
  expectedLifecycleRevision: string;
  intendedStateDigest: string;
  images: CollabCommitImage[];
  effect: Record<string, unknown>;
}

export interface CollabCommitObservedPage {
  id: string;
  title: string;
  bodyStorage: string;
  remoteVersion: number;
}

export interface CollabCommitPublicationResult {
  pageId: number;
  title: string;
  newVersion: number;
  bodyHtml: string;
  bodyText: string;
}

const EFFECT_KEYS = [
  'effectClass',
  'pageId',
  'confluenceId',
  'expectedRemoteVersion',
  'intendedStateDigest',
] as const;

const MEDIA_EFFECT_KEYS = [...EFFECT_KEYS, 'images'] as const;

const MAX_DIGEST = 'f'.repeat(64);

function assertTerminalResultFits(input: {
  confluenceId: string;
  expectedRemoteVersion: number;
  images: readonly CollabCommitImage[];
}): void {
  // Include every optional bounded field that a valid provider response can
  // add. Attachment acknowledgments are positional markers backed by the
  // immutable plan; their version is provider metadata, not byte attestation.
  const maximalTerminalResult = {
    accepted: true,
    confluenceId: input.confluenceId,
    expectedVersion: input.expectedRemoteVersion + 1,
    observedConfluenceId: input.confluenceId,
    version: input.expectedRemoteVersion + 1,
    titleSha256: MAX_DIGEST,
    storageSha256: MAX_DIGEST,
    attachments: input.images.map((image) => ({
      accepted: true,
      filename: image.filename,
      attachmentVersion: Number.MAX_SAFE_INTEGER,
    })),
  };
  const encoded = JSON.stringify(maximalTerminalResult);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_EFFECT_BYTES) {
    throw new PageWriteError(
      400,
      'invalid_remote_terminal_result',
      'remote_terminal_result exceeds the durable metadata limit',
    );
  }
}

function plannedImages(value: unknown): CollabCommitImage[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const images: CollabCommitImage[] = [];
  const filenames = new Set<string>();
  for (const image of value) {
    if (
      image === null
      || Array.isArray(image)
      || typeof image !== 'object'
    ) {
      return null;
    }
    const candidate = image as Record<string, unknown>;
    if (
      Object.keys(candidate).length !== 4
      || typeof candidate.filename !== 'string'
      || candidate.filename.length === 0
      || filenames.has(candidate.filename)
      || typeof candidate.mimeType !== 'string'
      || candidate.mimeType.length === 0
      || typeof candidate.size !== 'number'
      || !Number.isSafeInteger(candidate.size)
      || candidate.size < 0
      || typeof candidate.contentSha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(candidate.contentSha256)
    ) {
      return null;
    }
    filenames.add(candidate.filename);
    images.push({
      filename: candidate.filename,
      mimeType: candidate.mimeType,
      size: candidate.size,
      contentSha256: candidate.contentSha256,
    });
  }
  return images;
}

export function describeCollabCommit(input: {
  actorId: string;
  pageId: number;
  confluenceId: string;
  title: string;
  bodyStorage: string;
  expectedRemoteVersion: number;
  expectedLifecycleRevision: string;
  images?: CollabCommitImage[];
}): CollabCommitPublication {
  const intendedStateDigest = confluencePagePutDigest(input);
  const images = input.images === undefined || input.images.length === 0
    ? []
    : plannedImages(input.images);
  if (images === null) {
    throw new PageWriteError(
      400,
      'invalid_collab_image_plan',
      'The collaborative pasted-image plan is malformed or contains duplicate filenames',
    );
  }
  assertTerminalResultFits({
    confluenceId: input.confluenceId,
    expectedRemoteVersion: input.expectedRemoteVersion,
    images,
  });
  return {
    actorId: input.actorId,
    pageId: input.pageId,
    confluenceId: input.confluenceId,
    expectedRemoteVersion: input.expectedRemoteVersion,
    expectedLifecycleRevision: input.expectedLifecycleRevision,
    intendedStateDigest,
    images,
    effect: {
      effectClass: 'remote',
      pageId: input.pageId,
      confluenceId: input.confluenceId,
      expectedRemoteVersion: String(input.expectedRemoteVersion),
      intendedStateDigest,
      ...(images.length > 0 ? { images } : {}),
    },
  };
}

function publicationFromRecoveryIntent(intent: PageWriteRecoveryIntent): CollabCommitPublication {
  const effect = intent.effect;
  const expectedText = effect.expectedRemoteVersion;
  const expectedRemoteVersion = typeof expectedText === 'string' && /^[1-9]\d*$/.test(expectedText)
    ? Number(expectedText)
    : Number.NaN;
  const mediaIntent = intent.kind === 'collab.commit.confluence.media';
  const images = mediaIntent ? plannedImages(effect.images) : [];
  const pageId = typeof effect.pageId === 'number' ? effect.pageId : Number.NaN;
  const revision = Number.isSafeInteger(pageId) ? intent.revisions[pageId] : undefined;
  const expectedKeys = mediaIntent ? MEDIA_EFFECT_KEYS : EFFECT_KEYS;
  const valid = (intent.kind === 'collab.commit.confluence' || mediaIntent)
    && intent.actorId !== null
    && intent.pageIds.length === 1
    && effect.effectClass === 'remote'
    && Number.isSafeInteger(pageId)
    && pageId > 0
    && intent.pageIds[0] === pageId
    && typeof effect.confluenceId === 'string'
    && effect.confluenceId.length > 0
    && Number.isSafeInteger(expectedRemoteVersion)
    && expectedRemoteVersion > 0
    && typeof effect.intendedStateDigest === 'string'
    && /^[a-f0-9]{64}$/.test(effect.intendedStateDigest)
    && typeof revision?.lifecycleRevision === 'string'
    && revision.lifecycleRevision.length > 0
    && (!mediaIntent || images !== null)
    && Object.keys(effect).length === expectedKeys.length
    && expectedKeys.every((key) => Object.hasOwn(effect, key));
  if (!valid) {
    throw new PageWriteError(
      409,
      'intent_recovery_metadata_invalid',
      'The collaborative commit intent lacks trusted recovery metadata',
    );
  }
  return {
    actorId: String(intent.actorId),
    pageId,
    confluenceId: String(effect.confluenceId),
    expectedRemoteVersion,
    expectedLifecycleRevision: revision!.lifecycleRevision,
    intendedStateDigest: String(effect.intendedStateDigest),
    images: images ?? [],
    effect,
  };
}

export async function publishCollabCommit(
  client: PoolClient,
  publication: CollabCommitPublication,
  observed: CollabCommitObservedPage,
  intentId: string,
  preferredBodyHtml?: string,
): Promise<CollabCommitPublicationResult> {
  const acceptedVersion = publication.expectedRemoteVersion + 1;
  const digest = confluencePagePutDigest({
    pageId: publication.pageId,
    confluenceId: publication.confluenceId,
    title: observed.title,
    bodyStorage: observed.bodyStorage,
    expectedRemoteVersion: publication.expectedRemoteVersion,
  });
  if (
    observed.id !== publication.confluenceId
    || observed.remoteVersion !== acceptedVersion
    || digest !== publication.intendedStateDigest
  ) {
    throw new PageWriteError(
      409,
      'intent_remote_observation_mismatch',
      'The accepted Confluence version does not match the durable collaborative commit',
    );
  }

  const current = await client.query<{
    version: number;
    source: string;
    confluence_id: string | null;
    space_key: string | null;
    lifecycle_revision: string;
  }>(
    `SELECT version, source, confluence_id, space_key, lifecycle_revision::text
       FROM pages
      WHERE id = $1 AND deleted_at IS NULL
      FOR UPDATE`,
    [publication.pageId],
  );
  const page = current.rows[0];
  if (
    !page
    || page.version !== publication.expectedRemoteVersion
    || page.source !== 'confluence'
    || page.confluence_id !== publication.confluenceId
    || page.lifecycle_revision !== publication.expectedLifecycleRevision
  ) {
    throw new PageWriteError(
      409,
      'intent_local_publication_stale',
      'The local page changed before the collaborative commit could be published',
    );
  }
  const actor = await client.query(
    'SELECT 1 FROM users WHERE id = $1 AND deactivated_at IS NULL',
    [publication.actorId],
  );
  if (
    actor.rowCount !== 1
    || !(await userCanAccessPage(publication.actorId, publication.pageId, client))
    || !(await userCanEditPage(publication.actorId, publication.pageId, client))
  ) {
    throw new PageWriteError(
      409,
      'intent_actor_authority_unavailable',
      'The original collaborative writer is no longer authorized',
    );
  }

  let bodyHtml: string;
  try {
    bodyHtml = preferredBodyHtml ?? confluenceToHtml(
      observed.bodyStorage,
      publication.confluenceId,
      page.space_key ?? '',
    );
  } catch {
    throw new PageWriteError(
      409,
      'intent_local_conversion_failed',
      'The proven Confluence page could not be converted for local publication',
    );
  }
  const bodyText = htmlToText(bodyHtml);
  const updated = await client.query(
    `UPDATE pages SET
       title = $2, body_storage = $3, body_html = $4, body_text = $5,
       version = $6, last_synced = NOW(), last_modified_at = NOW(),
       local_modified_at = NULL, local_modified_by = NULL,
       embedding_dirty = TRUE,
       image_analysis_dirty = CASE
         WHEN body_html IS DISTINCT FROM $4 THEN TRUE
         ELSE image_analysis_dirty
       END,
       embedding_status = 'not_embedded', embedded_at = NULL,
       summary_status = 'pending', summary_retry_count = 0,
       quality_status = 'pending', quality_retry_count = 0
     WHERE id = $1 AND version = $7
       AND source = 'confluence' AND confluence_id = $8`,
    [
      publication.pageId,
      observed.title,
      observed.bodyStorage,
      bodyHtml,
      bodyText,
      acceptedVersion,
      publication.expectedRemoteVersion,
      publication.confluenceId,
    ],
  );
  if (updated.rowCount !== 1) {
    throw new PageWriteError(
      409,
      'intent_local_publication_stale',
      'The local page changed before the collaborative commit could be published',
    );
  }
  await enqueuePageWriteInvalidation(client, intentId);
  return {
    pageId: publication.pageId,
    title: observed.title,
    newVersion: acceptedVersion,
    bodyHtml,
    bodyText,
  };
}

const reconcileCollabCommit: PageWriteIntentReconciler = async (client, intent) => {
  const publication = publicationFromRecoveryIntent(intent);
  const confluence = await getClientForUser(publication.actorId, client);
  if (!confluence) {
    throw new PageWriteError(
      409,
      'intent_actor_credentials_unavailable',
      'The original collaborative writer credentials are unavailable for reconciliation',
    );
  }
  const current = await confluence.getPage(publication.confluenceId);
  const currentVersion = current.version?.number;
  if (
    typeof currentVersion !== 'number'
    || !Number.isSafeInteger(currentVersion)
    || currentVersion <= publication.expectedRemoteVersion
  ) {
    throw new PageWriteError(
      409,
      'intent_remote_outcome_unknown',
      'The collaborative update may still land; the intent must remain pending',
    );
  }
  const acceptedVersion = publication.expectedRemoteVersion + 1;
  const observed = currentVersion === acceptedVersion
    ? current
    : await confluence.getHistoricalPage(publication.confluenceId, acceptedVersion);
  const storage = observed.body?.storage?.value;
  if (
    observed.id !== publication.confluenceId
    || observed.version?.number !== acceptedVersion
    || typeof observed.title !== 'string'
    || typeof storage !== 'string'
  ) {
    throw new PageWriteError(
      409,
      'intent_remote_observation_incomplete',
      'The exact accepted collaborative page version could not be read',
    );
  }
  const observedDigest = confluencePagePutDigest({
    pageId: publication.pageId,
    confluenceId: publication.confluenceId,
    title: observed.title,
    bodyStorage: storage,
    expectedRemoteVersion: publication.expectedRemoteVersion,
  });
  const matches = observedDigest === publication.intendedStateDigest;
  if (matches) {
    await publishCollabCommit(client, publication, {
      id: observed.id,
      title: observed.title,
      bodyStorage: storage,
      remoteVersion: acceptedVersion,
    }, intent.id);
  }
  return {
    outcome: matches ? 'applied' as const : 'not_applied' as const,
    proof: {
      kind: 'remote_conditional_effect_converged' as const,
      observedAt: new Date().toISOString(),
      reference: `confluence-page:${publication.confluenceId}:version:${acceptedVersion}`,
      details: {
        recoveryAttempted: true as const,
        conditionalExpectedVersion: String(publication.expectedRemoteVersion),
        observedRemoteVersion: String(acceptedVersion),
        providerResult: matches && currentVersion === acceptedVersion
          ? 'applied' as const
          : 'historical_version_observed' as const,
        intendedStateDigest: publication.intendedStateDigest,
        observedStateDigest: observedDigest,
      },
    },
    result: {
      outcome: matches ? 'reconciled' : 'aborted',
      pageId: publication.pageId,
      confluenceId: publication.confluenceId,
      observedVersion: acceptedVersion,
    },
  };
};

type PagePublicationReceipt = Parameters<typeof confirmPagePublication>[1];

function terminalPageReceipt(
  intent: PageWriteRecoveryIntent,
  publication: CollabCommitPublication,
): PagePublicationReceipt {
  const terminal = intent.remoteTerminalResult;
  const acceptedVersion = publication.expectedRemoteVersion + 1;
  if (
    !terminal
    || terminal.accepted !== true
    || terminal.confluenceId !== publication.confluenceId
    || terminal.expectedVersion !== acceptedVersion
    || (terminal.observedConfluenceId !== undefined
      && terminal.observedConfluenceId !== publication.confluenceId)
    || (terminal.version !== undefined && terminal.version !== acceptedVersion)
    || (terminal.titleSha256 !== undefined
      && (typeof terminal.titleSha256 !== 'string'
        || !/^[a-f0-9]{64}$/.test(terminal.titleSha256)))
    || (terminal.storageSha256 !== undefined
      && (typeof terminal.storageSha256 !== 'string'
        || !/^[a-f0-9]{64}$/.test(terminal.storageSha256)))
  ) {
    throw new PageWriteError(
      409,
      'intent_terminal_result_invalid',
      'The collaborative page acknowledgment is incomplete or conflicting',
    );
  }
  return {
    accepted: true,
    confluenceId: publication.confluenceId,
    expectedVersion: acceptedVersion,
    ...(typeof terminal.observedConfluenceId === 'string'
      ? { observedConfluenceId: terminal.observedConfluenceId }
      : {}),
    ...(typeof terminal.version === 'number' ? { version: terminal.version } : {}),
    ...(typeof terminal.titleSha256 === 'string' ? { titleSha256: terminal.titleSha256 } : {}),
    ...(typeof terminal.storageSha256 === 'string'
      ? { storageSha256: terminal.storageSha256 }
      : {}),
  };
}

/**
 * Each array position corresponds to the same position in the immutable image
 * plan. A marker proves that upload returned a valid attachment object; it
 * does not claim that the provider attested the planned hash or byte count.
 */
function assertTerminalImageReceipts(
  intent: PageWriteRecoveryIntent,
  publication: CollabCommitPublication,
): void {
  const attachments = intent.remoteTerminalResult?.attachments;
  if (!Array.isArray(attachments) || attachments.length !== publication.images.length) {
    throw new PageWriteError(
      409,
      'intent_terminal_result_invalid',
      'The pasted-image acknowledgments are incomplete',
    );
  }
  for (let index = 0; index < attachments.length; index += 1) {
    const receipt = attachments[index];
    const planned = publication.images[index]!;
    if (
      receipt === null
      || Array.isArray(receipt)
      || typeof receipt !== 'object'
    ) {
      throw new PageWriteError(
        409,
        'intent_terminal_result_invalid',
        'A pasted-image acknowledgment is malformed',
      );
    }
    const candidate = receipt as Record<string, unknown>;
    const keys = Object.keys(candidate);
    if (
      candidate.accepted !== true
      || candidate.filename !== planned.filename
      || (keys.length !== 2 && keys.length !== 3)
      || keys.some((key) => (
        key !== 'accepted'
        && key !== 'filename'
        && key !== 'attachmentVersion'
      ))
      || (candidate.attachmentVersion !== undefined
        && (typeof candidate.attachmentVersion !== 'number'
          || !Number.isSafeInteger(candidate.attachmentVersion)
          || candidate.attachmentVersion < 1))
    ) {
      throw new PageWriteError(
        409,
        'intent_terminal_result_invalid',
        'A pasted-image acknowledgment does not match the durable plan',
      );
    }
  }
}

const reconcileCollabMediaCommit: PageWriteIntentReconciler = async (client, intent) => {
  const publication = publicationFromRecoveryIntent(intent);
  if (intent.remoteEffectStartedAt === null) {
    return {
      outcome: 'not_applied',
      proof: {
        kind: 'remote_effect_not_started',
        observedAt: new Date().toISOString(),
        reference: `confluence-collab-media:${publication.confluenceId}:not-dispatched`,
        details: {
          syscallSettled: true,
          remoteEffectStarted: false,
          observedAbsent: true,
        },
      },
      result: { pageId: publication.pageId, outcome: 'not_dispatched' },
    };
  }
  if (intent.remoteEffectsCompletedAt === null) {
    throw new PageWriteError(
      409,
      'intent_outcome_unrecoverable',
      'A pasted-image mutation has no durable terminal response',
    );
  }
  assertTerminalImageReceipts(intent, publication);
  const receipt = terminalPageReceipt(intent, publication);
  const confluence = await getClientForUser(publication.actorId, client);
  if (!confluence) {
    throw new PageWriteError(
      409,
      'intent_actor_credentials_unavailable',
      'The original collaborative writer credentials are unavailable for reconciliation',
    );
  }
  const observed = await confirmPagePublication(confluence, receipt);
  const storage = observed.body.storage.value;
  await publishCollabCommit(client, publication, {
    id: observed.id,
    title: observed.title,
    bodyStorage: storage,
    remoteVersion: observed.version.number,
  }, intent.id);
  return {
    outcome: 'applied',
    proof: {
      kind: 'remote_terminal_effect_verified',
      observedAt: new Date().toISOString(),
      reference: `confluence-collab-media:${publication.confluenceId}:version:${observed.version.number}`,
      details: {
        remoteEffectsCompleted: true,
        terminalEvidence: publication.intendedStateDigest,
      },
    },
    result: {
      pageId: publication.pageId,
      confluenceId: publication.confluenceId,
      observedVersion: observed.version.number,
      attachments: publication.images.length,
    },
  };
};
let registered = false;

export function registerCollabCommitIntentReconciler(): void {
  if (registered) return;
  registerPageWriteIntentReconciler('collab.commit.confluence', reconcileCollabCommit);
  registerPageWriteIntentReconciler('collab.commit.confluence.media', reconcileCollabMediaCommit);
  registered = true;
}
