import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ATTACHMENT_SNAPSHOT_LOCK_ID } from '../db/advisory-locks.js';
import { cachedAttachmentPath } from './attachment-store.js';
import { markPageImagesDirtyByAttachmentKey } from './image-analysis-dirty.js';
import { enqueuePageWriteInvalidation } from './page-write-invalidation.js';
import { getPageBaselineGovernanceHook } from './page-baseline-governance.js';
import {
  advancePageWriteIntent,
  completePageWriteIntent,
  PageWriteError,
  registerPageWriteIntentReconciler,
  reservePageWriteIntentInTransaction,
  runPageWriteIntentEffect,
  withPageWriteTransaction,
  type PageWriteIntentReconciler,
  type PageWriteRecoveryIntent,
} from './page-write-admission.js';
import { isSystemAdmin, userCanAccessPage } from './rbac-service.js';

export type ImageUploadPage = {
  id: number;
  source: string;
  confluence_id: string | null;
  created_by_user_id: string | null;
  space_key: string | null;
  visibility: string | null;
  content_revision: string;
  lifecycle_revision: string;
};

export function imageAttachmentPageKey(page: ImageUploadPage): string {
  return page.source === 'standalone' ? String(page.id) : (page.confluence_id ?? String(page.id));
}

/** Shared standalone pages stay writable by readers, including the current EE ACL check. */
export async function userCanUploadPageImage(
  userId: string,
  page: ImageUploadPage,
  client?: PoolClient,
): Promise<boolean> {
  if (await isSystemAdmin(userId, client)) return true;
  if (page.source === 'standalone') {
    return (page.created_by_user_id === userId || page.visibility === 'shared') &&
      userCanAccessPage(userId, page.id, client);
  }
  return !!page.space_key && userCanAccessPage(userId, page.id, client);
}

export async function loadAuthorizedImagePage(
  client: PoolClient,
  pageId: number,
  userId: string,
  expectedPageKey: string,
  forbiddenMessage: string,
): Promise<ImageUploadPage> {
  const actor = await client.query(
    'SELECT 1 FROM users WHERE id = $1 AND deactivated_at IS NULL', [userId],
  );
  if (actor.rowCount !== 1) throw new PageWriteError(403, 'not_authorized', forbiddenMessage);
  const result = await client.query<ImageUploadPage>(
    `SELECT id, source, confluence_id, created_by_user_id, space_key, visibility,
            content_revision::text, lifecycle_revision::text
       FROM pages WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
    [pageId],
  );
  const page = result.rows[0];
  if (!page) throw new PageWriteError(404, 'page_not_found', 'Page not found');
  if (!(await userCanUploadPageImage(userId, page, client))) {
    throw new PageWriteError(403, 'not_authorized', forbiddenMessage);
  }
  if (imageAttachmentPageKey(page) !== expectedPageKey) {
    throw new PageWriteError(409, 'stale_attachment_identity', 'The page attachment identity changed after admission');
  }
  return page;
}

const FileIdentitySchema = z.object({
  size: z.number().int().nonnegative().safe(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const ImageEffectSchema = FileIdentitySchema.extend({
  effectClass: z.literal('local'),
  store: z.literal('attachment-cache'),
  pageKey: z.string().min(1).max(255),
  filename: z.string().min(1).max(255),
  initialContentRevision: z.string().regex(/^\d+$/),
  previous: FileIdentitySchema.nullable(),
});
type FileIdentity = z.infer<typeof FileIdentitySchema>;
type ImageEffect = z.infer<typeof ImageEffectSchema>;

async function inspectImageFile(path: string): Promise<FileIdentity | null> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new PageWriteError(409, 'intent_local_evidence_invalid', 'Image evidence is not a regular file');
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.length;
      hash.update(chunk);
    }
    return { size, sha256: hash.digest('hex') };
  } finally {
    await handle.close();
  }
}

function sameFile(left: FileIdentity | null, right: FileIdentity | null): boolean {
  return left === null || right === null
    ? left === right
    : left.size === right.size && left.sha256 === right.sha256;
}

function imagePaths(intentId: string, effect: ImageEffect) {
  const live = cachedAttachmentPath(effect.pageKey, effect.filename);
  return { live, stage: join(dirname(live), `.page-write-${intentId}.image-stage`) };
}

async function recordImagePublication(client: PoolClient, pageId: number, pageKey: string, intentId: string) {
  await markPageImagesDirtyByAttachmentKey(pageKey, client);
  const updated = await client.query<{ content_revision: string }>(
    `UPDATE pages SET content_revision = content_revision + 1, image_analysis_dirty = TRUE
      WHERE id = $1 RETURNING content_revision::text`,
    [pageId],
  );
  await getPageBaselineGovernanceHook()?.invalidateProposalForMutation?.({
    client, pageId, contentRevision: updated.rows[0]!.content_revision,
  });
  await enqueuePageWriteInvalidation(client, intentId);
}

/** Atomic activation prevents a failed write from truncating an existing referenced image. */
export async function writePageImageCache(input: {
  page: ImageUploadPage;
  userId: string;
  filename: string;
  bytes: Buffer;
  kind: 'pages.image.upload' | 'pages.image.import.store';
  forbiddenMessage: string;
}): Promise<void> {
  const { page, userId, filename, bytes, kind, forbiddenMessage } = input;
  const pageKey = imageAttachmentPageKey(page);
  const live = cachedAttachmentPath(pageKey, filename);
  const effect: ImageEffect = {
    effectClass: 'local', store: 'attachment-cache', pageKey, filename,
    size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    initialContentRevision: page.content_revision, previous: null,
  };
  const intent = await withPageWriteTransaction([page.id], async (client) => {
    await client.query('SELECT pg_advisory_xact_lock_shared($1)', [ATTACHMENT_SNAPSHOT_LOCK_ID]);
    await loadAuthorizedImagePage(client, page.id, userId, pageKey, forbiddenMessage);
    effect.previous = await inspectImageFile(live);
    return reservePageWriteIntentInTransaction(client, {
      pageIds: [page.id], kind, actorId: userId,
      expectedRevisions: {
        [page.id]: { contentRevision: page.content_revision, lifecycleRevision: page.lifecycle_revision },
      },
      effect,
    });
  });
  const { stage } = imagePaths(intent.id, effect);
  await runPageWriteIntentEffect(intent, { kind: 'local' }, () =>
    advancePageWriteIntent(intent, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock_shared($1)', [ATTACHMENT_SNAPSHOT_LOCK_ID]);
      await loadAuthorizedImagePage(client, page.id, userId, pageKey, forbiddenMessage);
      if (!sameFile(await inspectImageFile(live), effect.previous)) {
        throw new PageWriteError(409, 'intent_local_evidence_mismatch', 'The cached image changed after admission');
      }
      await mkdir(dirname(live), { recursive: true });
      const handle = await open(stage, 'wx', 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(stage, live);
      await recordImagePublication(client, page.id, pageKey, intent.id);
    }),
  );
  await completePageWriteIntent(intent, async () => undefined);
}

async function observeImageWrite(intent: PageWriteRecoveryIntent) {
  const parsed = ImageEffectSchema.safeParse(intent.effect);
  if (!parsed.success) {
    throw new PageWriteError(409, 'intent_recovery_metadata_invalid', 'Image intent has no valid byte identities');
  }
  const effect = parsed.data;
  const pageId = intent.pageIds[0];
  if (pageId === undefined || intent.pageIds.length !== 1) {
    throw new PageWriteError(409, 'intent_recovery_metadata_invalid', 'Image intent must identify exactly one page');
  }
  const revision = intent.revisions[pageId]?.contentRevision;
  if (revision === undefined || BigInt(revision) < BigInt(effect.initialContentRevision)) {
    throw new PageWriteError(409, 'intent_recovery_metadata_invalid', 'Image publication revision is invalid');
  }
  const paths = imagePaths(intent.id, effect);
  const [live, stage] = await Promise.all([inspectImageFile(paths.live), inspectImageFile(paths.stage)]);
  return {
    effect, pageId, paths, live, stage,
    published: revision !== effect.initialContentRevision,
    intended: sameFile(live, effect),
    unchanged: sameFile(live, effect.previous),
  };
}

const reconcileImageWrite: PageWriteIntentReconciler = async (client, intent) => {
  await client.query('SELECT pg_advisory_xact_lock_shared($1)', [ATTACHMENT_SNAPSHOT_LOCK_ID]);
  const observed = await observeImageWrite(intent);
  if (!observed.published && observed.unchanged && observed.stage === null) {
    return {
      outcome: 'not_applied',
      proof: {
        kind: 'local_effect_absence_verified', observedAt: new Date().toISOString(),
        reference: `image-cache:${intent.id}:unchanged`,
        details: { syscallSettled: true, observedAbsent: true },
      },
      result: { pageId: observed.pageId, filename: observed.effect.filename },
    };
  }
  if (observed.published && observed.intended && observed.stage === null) {
    return {
      outcome: 'applied',
      proof: {
        kind: 'local_bytes_verified', observedAt: new Date().toISOString(),
        reference: `image-cache:${intent.id}:${observed.effect.sha256}`,
        details: {
          syscallSettled: true,
          intendedStateDigest: observed.effect.sha256,
          observedStateDigest: observed.live!.sha256,
          intendedSize: observed.effect.size,
          observedSize: observed.live!.size,
        },
      },
      result: { pageId: observed.pageId, filename: observed.effect.filename },
    };
  }
  if (!observed.published && observed.unchanged && observed.stage !== null) {
    return { outcome: 'repair_required', observedState: 'staged_only' };
  }
  if (observed.intended) {
    return { outcome: 'repair_required', observedState: 'partially_applied' };
  }
  throw new PageWriteError(409, 'intent_local_evidence_mismatch', 'Cached image bytes do not match the admitted write');
};

async function repairImageWrite(intent: PageWriteRecoveryIntent): Promise<void> {
  await advancePageWriteIntent(intent, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock_shared($1)', [ATTACHMENT_SNAPSHOT_LOCK_ID]);
    const observed = await observeImageWrite(intent);
    if (!observed.published && observed.unchanged && observed.stage !== null) {
      // The live image never changed. Only this UUID's unpublished bytes are
      // removed; a revoked/deleted actor cannot turn cleanup into publication.
      await rm(observed.paths.stage);
      return;
    }
    if (!observed.intended) {
      throw new PageWriteError(409, 'intent_local_evidence_mismatch', 'Image evidence changed before repair');
    }
    if (!observed.published) {
      if (!intent.actorId) throw new PageWriteError(403, 'intent_access_changed', 'The original image writer is unavailable');
      await loadAuthorizedImagePage(
        client, observed.pageId, intent.actorId, observed.effect.pageKey,
        'The original image writer can no longer publish this attachment',
      );
      await recordImagePublication(client, observed.pageId, observed.effect.pageKey, intent.id);
    }
    if (observed.stage !== null) await rm(observed.paths.stage);
  });
}

registerPageWriteIntentReconciler('pages.image.upload', reconcileImageWrite, repairImageWrite);
registerPageWriteIntentReconciler('pages.image.import.store', reconcileImageWrite, repairImageWrite);
