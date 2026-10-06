import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  confluenceToHtml,
  htmlToConfluence,
  htmlToText,
} from '../../../core/services/content-converter.js';
import { invalidateCollabDocAfterBodyWrite } from '../../../core/services/collab-guard.js';
import { enqueuePageWriteInvalidation } from '../../../core/services/page-write-invalidation.js';
import { getUserAccessibleSpaces } from '../../../core/services/rbac-service.js';
import {
  PageWriteError,
  registerPageWriteIntentReconciler,
  type PageWriteIntentReconciler,
  type PageWriteRecoveryIntent,
} from '../../../core/services/page-write-admission.js';
import { getClientForUser } from './sync-service.js';

interface PagePutState {
  pageId: number;
  confluenceId: string;
  title: string;
  bodyStorage: string;
  expectedRemoteVersion: number;
}

type PublicationKindState =
  | {
      kind: 'page.ai_apply';
      improvementId: string | null;
    }
  | {
      kind: 'page.version_restore';
      targetVersion: number;
    };

export type ConfluencePagePutPublication = PublicationKindState & {
  actorId: string;
  pageId: number;
  confluenceId: string;
  expectedRemoteVersion: number;
  intendedStateDigest: string;
  effect: Record<string, unknown>;
};

interface ObservedPagePut {
  confluenceId: unknown;
  title: unknown;
  bodyStorage: unknown;
  remoteVersion: unknown;
}

export interface ConfluencePagePutPublicationResult {
  pageId: number;
  title: string;
  newVersion: number;
  bodyHtml: string;
  bodyText: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMON_EFFECT_KEYS = [
  'effectClass',
  'pageId',
  'confluenceId',
  'expectedRemoteVersion',
  'intendedStateDigest',
] as const;

export function confluencePagePutDigest(state: PagePutState): string {
  return createHash('sha256').update(JSON.stringify({
    pageId: state.pageId,
    confluenceId: state.confluenceId,
    title: state.title,
    bodyStorage: state.bodyStorage,
    expectedRemoteVersion: state.expectedRemoteVersion,
  })).digest('hex');
}

/**
 * Build the durable descriptor shared by the ordinary completion and crash
 * recovery paths. Authored title/body are used only to derive the digest and
 * are deliberately absent from the persisted effect.
 */
export function describeConfluencePagePut(
  input: PagePutState & { actorId: string } & PublicationKindState,
): ConfluencePagePutPublication {
  const intendedStateDigest = confluencePagePutDigest(input);
  const common = {
    actorId: input.actorId,
    pageId: input.pageId,
    confluenceId: input.confluenceId,
    expectedRemoteVersion: input.expectedRemoteVersion,
    intendedStateDigest,
  };
  const effectCommon = {
    effectClass: 'remote',
    pageId: input.pageId,
    confluenceId: input.confluenceId,
    expectedRemoteVersion: String(input.expectedRemoteVersion),
    intendedStateDigest,
  };
  if (input.kind === 'page.ai_apply') {
    return {
      ...common,
      kind: input.kind,
      improvementId: input.improvementId,
      effect: { ...effectCommon, improvementId: input.improvementId },
    };
  }
  return {
    ...common,
    kind: input.kind,
    targetVersion: input.targetVersion,
    effect: { ...effectCommon, targetVersion: input.targetVersion },
  };
}

function publicationFromRecoveryIntent(
  intent: PageWriteRecoveryIntent,
): ConfluencePagePutPublication {
  const effect = intent.effect;
  const pageId = effect.pageId;
  const confluenceId = effect.confluenceId;
  const expectedRemoteVersionText = effect.expectedRemoteVersion;
  const intendedStateDigest = effect.intendedStateDigest;
  const expectedRemoteVersion =
    typeof expectedRemoteVersionText === 'string' && /^[1-9]\d*$/.test(expectedRemoteVersionText)
      ? Number(expectedRemoteVersionText)
      : Number.NaN;
  const commonValid =
    effect.effectClass === 'remote'
    && typeof pageId === 'number' && Number.isSafeInteger(pageId) && pageId > 0
    && typeof confluenceId === 'string' && confluenceId.length > 0
    && Number.isSafeInteger(expectedRemoteVersion)
    && expectedRemoteVersion >= 1
    && expectedRemoteVersion < Number.MAX_SAFE_INTEGER
    && typeof intendedStateDigest === 'string'
    && /^[a-f0-9]{64}$/.test(intendedStateDigest)
    && intent.pageIds.length === 1
    && intent.pageIds[0] === pageId
    && intent.actorId !== null;
  if (!commonValid) {
    throw new PageWriteError(
      409,
      'intent_recovery_metadata_invalid',
      'The conditional page update intent lacks trusted recovery metadata',
    );
  }

  const common = {
    actorId: intent.actorId!,
    pageId: pageId as number,
    confluenceId: confluenceId as string,
    expectedRemoteVersion,
    intendedStateDigest: intendedStateDigest as string,
    effect,
  };
  if (
    intent.kind === 'page.ai_apply'
    && Object.keys(effect).length === COMMON_EFFECT_KEYS.length + 1
    && COMMON_EFFECT_KEYS.every((key) => Object.hasOwn(effect, key))
    && Object.hasOwn(effect, 'improvementId')
    && (effect.improvementId === null
      || (typeof effect.improvementId === 'string' && UUID_PATTERN.test(effect.improvementId)))
  ) {
    return { ...common, kind: intent.kind, improvementId: effect.improvementId as string | null };
  }
  if (
    intent.kind === 'page.version_restore'
    && typeof effect.targetVersion === 'number'
    && Object.keys(effect).length === COMMON_EFFECT_KEYS.length + 1
    && COMMON_EFFECT_KEYS.every((key) => Object.hasOwn(effect, key))
    && effect.targetVersion !== expectedRemoteVersion
    && Number.isSafeInteger(effect.targetVersion)
    && effect.targetVersion > 0
  ) {
    return { ...common, kind: intent.kind, targetVersion: effect.targetVersion };
  }
  throw new PageWriteError(
    409,
    'intent_recovery_metadata_invalid',
    `The ${intent.kind} intent lacks its exact local publication identity`,
  );
}

/**
 * Publish one proven Confluence E+1 response into local authored state.
 *
 * Both the request path and recovery use this function, so a reconciled
 * remote success cannot settle without the same page/history/status commit as
 * an uninterrupted request. The caller's transaction owns intent settlement.
 */
export async function publishConfluencePagePut(
  dbClient: PoolClient,
  publication: ConfluencePagePutPublication,
  observed: ObservedPagePut,
  intentId: string,
): Promise<ConfluencePagePutPublicationResult> {
  const acceptedVersion = publication.expectedRemoteVersion + 1;
  if (
    typeof observed.confluenceId !== 'string'
    || observed.confluenceId !== publication.confluenceId
    || typeof observed.title !== 'string'
    || typeof observed.bodyStorage !== 'string'
    || typeof observed.remoteVersion !== 'number'
    || !Number.isSafeInteger(observed.remoteVersion)
    || observed.remoteVersion !== acceptedVersion
    || confluencePagePutDigest({
      pageId: publication.pageId,
      confluenceId: publication.confluenceId,
      title: observed.title,
      bodyStorage: observed.bodyStorage,
      expectedRemoteVersion: publication.expectedRemoteVersion,
    }) !== publication.intendedStateDigest
  ) {
    throw new PageWriteError(
      409,
      'intent_remote_observation_mismatch',
      'The accepted Confluence version does not match the durable intended page state',
    );
  }
  // Admission already holds the page lifecycle lock. Collaboration init must
  // be fenced before taking the page row lock so a recovered body write cannot
  // leave persisted editor bytes for the previous authored body.
  await invalidateCollabDocAfterBodyWrite(publication.pageId, dbClient);

  const pageResult = await dbClient.query<{
    version: number;
    title: string;
    body_html: string | null;
    body_text: string | null;
    source: string;
    confluence_id: string | null;
    space_key: string | null;
  }>(
    `SELECT version, title, body_html, body_text, source, confluence_id, space_key
       FROM pages
      WHERE id = $1 AND deleted_at IS NULL
      FOR UPDATE`,
    [publication.pageId],
  );
  const page = pageResult.rows[0];
  if (
    !page
    || page.source !== 'confluence'
    || page.confluence_id !== publication.confluenceId
    || page.version !== publication.expectedRemoteVersion
  ) {
    throw new PageWriteError(
      409,
      'intent_local_publication_stale',
      'The local page revision, source, or Confluence identity changed before publication',
    );
  }
  const actor = await dbClient.query(
    'SELECT 1 FROM users WHERE id = $1 AND deactivated_at IS NULL',
    [publication.actorId],
  );
  if (actor.rows.length !== 1) {
    throw new PageWriteError(
      409,
      'intent_actor_authority_unavailable',
      'The original writer is no longer active, so local publication requires operator repair',
    );
  }

  if (publication.kind === 'page.version_restore') {
    if (page.space_key) {
      const spaces = await getUserAccessibleSpaces(publication.actorId, dbClient);
      if (!spaces.includes(page.space_key)) {
        throw new PageWriteError(
          409,
          'intent_actor_authority_unavailable',
          'The original writer no longer has access to the restored page',
        );
      }
    }
    const targetResult = await dbClient.query<{
      title: string;
      body_html: string | null;
    }>(
      `SELECT title, body_html
         FROM page_versions
        WHERE page_id = $1 AND version_number = $2`,
      [publication.pageId, publication.targetVersion],
    );
    const target = targetResult.rows[0];
    if (!target || target.body_html === null) {
      throw new PageWriteError(
        409,
        'intent_restore_target_unavailable',
        `Historical version ${publication.targetVersion} is unavailable for local publication`,
      );
    }
    const targetStorage = htmlToConfluence(target.body_html);
    const targetDigest = confluencePagePutDigest({
      pageId: publication.pageId,
      confluenceId: publication.confluenceId,
      title: target.title,
      bodyStorage: targetStorage,
      expectedRemoteVersion: publication.expectedRemoteVersion,
    });
    if (targetDigest !== publication.intendedStateDigest) {
      throw new PageWriteError(
        409,
        'intent_restore_target_changed',
        `Historical version ${publication.targetVersion} no longer matches the durable restore intent`,
      );
    }

    const inserted = await dbClient.query(
      `INSERT INTO page_versions (page_id, version_number, title, body_html, body_text, synced_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (page_id, version_number) DO NOTHING
       RETURNING id`,
      [publication.pageId, page.version, page.title, page.body_html, page.body_text],
    );
    if (inserted.rowCount !== 1) {
      // Backfill may already have created a metadata-only row for E. Complete
      // only its missing authored fields; a conflicting payload is unrelated
      // history and must leave the intent pending rather than be overwritten.
      const completed = await dbClient.query(
        `UPDATE page_versions
            SET body_html = COALESCE(body_html, $4),
                body_text = COALESCE(body_text, $5),
                synced_at = COALESCE(synced_at, NOW())
          WHERE page_id = $1
            AND version_number = $2
            AND title = $3
            AND (body_html IS NULL OR body_html = $4)
            AND (body_text IS NULL OR body_text = $5)
        RETURNING id`,
        [publication.pageId, page.version, page.title, page.body_html, page.body_text],
      );
      if (completed.rowCount !== 1) {
        throw new PageWriteError(
          409,
          'intent_restore_history_unavailable',
          'The pre-restore local version cannot be recorded without overwriting unrelated history',
        );
      }
    }
  } else if (publication.improvementId !== null) {
    const improvement = await dbClient.query<{
      user_id: string;
      page_id: number;
      status: string;
    }>(
      `SELECT user_id, page_id, status
         FROM llm_improvements
        WHERE id = $1
        FOR UPDATE`,
      [publication.improvementId],
    );
    const linked = improvement.rows[0];
    if (
      !linked
      || linked.user_id !== publication.actorId
      || linked.page_id !== publication.pageId
      || !['streaming', 'completed'].includes(linked.status)
    ) {
      throw new PageWriteError(
        409,
        'intent_ai_improvement_unavailable',
        'The exact AI improvement linked to this write is unavailable or no longer applicable',
      );
    }
  }

  let bodyHtml: string;
  let bodyText: string;
  try {
    bodyHtml = confluenceToHtml(
      observed.bodyStorage,
      publication.confluenceId,
      page.space_key ?? '',
    );
    bodyText = htmlToText(bodyHtml);
  } catch {
    throw new PageWriteError(
      409,
      'intent_local_conversion_failed',
      'The proven Confluence page could not be converted for local publication',
    );
  }

  const updated = await dbClient.query(
    `UPDATE pages SET
       title = $2, body_storage = $3, body_html = $4, body_text = $5,
       version = $6, last_modified_at = NOW(), last_synced = NOW(),
       embedding_dirty = TRUE,
       image_analysis_dirty = CASE
         WHEN body_html IS DISTINCT FROM $4 THEN TRUE
         ELSE image_analysis_dirty
       END,
       embedding_status = 'not_embedded', embedded_at = NULL,
       local_modified_at = NULL, local_modified_by = NULL
     WHERE id = $1
       AND version = $7
       AND source = 'confluence'
       AND confluence_id = $8`,
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
      'The local page changed before the proven Confluence state could be published',
    );
  }

  if (publication.kind === 'page.ai_apply' && publication.improvementId !== null) {
    const marked = await dbClient.query(
      `UPDATE llm_improvements
          SET status = 'applied'
        WHERE id = $1
          AND user_id = $2
          AND page_id = $3
          AND status IN ('streaming', 'completed')`,
      [publication.improvementId, publication.actorId, publication.pageId],
    );
    if (marked.rowCount !== 1) {
      throw new PageWriteError(
        409,
        'intent_ai_improvement_unavailable',
        'The exact AI improvement could not be marked applied atomically',
      );
    }
  }
  await enqueuePageWriteInvalidation(dbClient, intentId);

  return {
    pageId: publication.pageId,
    title: observed.title,
    newVersion: acceptedVersion,
    bodyHtml,
    bodyText,
  };
}

const reconcilePagePut: PageWriteIntentReconciler = async (dbClient, intent) => {
  const publication = publicationFromRecoveryIntent(intent);
  const confluence = await getClientForUser(publication.actorId, dbClient);
  if (!confluence) {
    throw new PageWriteError(409, 'intent_actor_credentials_unavailable', 'The original writer credentials are unavailable for reconciliation');
  }

  const current = await confluence.getPage(publication.confluenceId);
  const currentVersion = current.version?.number;
  if (
    typeof currentVersion !== 'number'
    || !Number.isSafeInteger(currentVersion)
    || currentVersion <= publication.expectedRemoteVersion
  ) {
    throw new PageWriteError(409, 'intent_remote_outcome_unknown', 'The conditional update may still land; the intent must remain pending');
  }

  const acceptedVersion = publication.expectedRemoteVersion + 1;
  const observed = currentVersion === acceptedVersion
    ? current
    : await confluence.getHistoricalPage(publication.confluenceId, acceptedVersion);
  const observedStorage = observed.body?.storage?.value;
  if (
    typeof observed.id !== 'string'
    || observed.id !== publication.confluenceId
    || observed.version?.number !== acceptedVersion
    || typeof observedStorage !== 'string'
    || typeof observed.title !== 'string'
  ) {
    throw new PageWriteError(409, 'intent_remote_observation_incomplete', 'The exact accepted page version could not be read');
  }
  const observedStateDigest = confluencePagePutDigest({
    pageId: publication.pageId,
    confluenceId: publication.confluenceId,
    title: observed.title,
    bodyStorage: observedStorage,
    expectedRemoteVersion: publication.expectedRemoteVersion,
  });
  const matches = observedStateDigest === publication.intendedStateDigest;
  if (matches) {
    await publishConfluencePagePut(dbClient, publication, {
      confluenceId: observed.id,
      title: observed.title,
      bodyStorage: observedStorage,
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
        observedStateDigest,
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

let registered = false;

export function registerConfluencePagePutIntentReconcilers(): void {
  if (registered) return;
  registerPageWriteIntentReconciler('page.ai_apply', reconcilePagePut);
  registerPageWriteIntentReconciler('page.version_restore', reconcilePagePut);
  registered = true;
}
