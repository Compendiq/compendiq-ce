import crypto from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { PoolClient } from 'pg';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ATTACHMENT_SNAPSHOT_LOCK_ID } from '../../core/db/advisory-locks.js';
import { getPool, query } from '../../core/db/postgres.js';
import { getPageBaselineGovernanceHook } from '../../core/services/page-baseline-governance.js';
import { readFrozenPageAttachment } from '../../core/services/page-baseline-service.js';
import { getRedisClient } from '../../core/services/redis-cache.js';
import { getUserAccessibleSpaces, userCanAccessPage } from '../../core/services/rbac-service.js';
import { logger } from '../../core/utils/logger.js';
import { readAttachment, fetchAndCachePageImage, getMimeType } from '../../domains/confluence/services/attachment-handler.js';
import { ConfluenceError } from '../../domains/confluence/services/confluence-client.js';
import type { ConfluenceClient } from '../../domains/confluence/services/confluence-client.js';
import { getClientForUser } from '../../domains/confluence/services/sync-service.js';
import {
  advancePageWriteIntent,
  cancelPageWriteIntentBeforeEffect,
  completePageWriteIntent,
  getPageWriterRuntimeId,
  lockPageLifecycle,
  lockPageWriterRuntime,
  PageWriteError,
  registerPageWriteIntentReconciler,
  reservePageWriteIntentInTransaction,
  runPageWriteIntentEffect,
  withPageWriteTransaction,
  type PageRevision,
  type PageWriteIntent,
  type PageWriteIntentReconciler,
} from '../../core/services/page-write-admission.js';
import { enqueuePageWriteInvalidation } from '../../core/services/page-write-invalidation.js';

const UpdateAttachmentBodySchema = z.object({
  dataUri: z.string().min(1, 'dataUri is required'),
  /**
   * Optional draw.io XML source for the diagram (#302 Gap 2). When
   * present, the route uploads the XML as a sibling `.drawio` attachment
   * alongside the rendered PNG so Confluence's native draw.io viewer can
   * re-open and edit the diagram. Omit for non-draw.io attachments.
   */
  xml: z.string().max(25 * 1024 * 1024, 'XML exceeds 25 MB limit').optional(),
});

/** Maximum allowed PNG upload size: 10 MB. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Maximum allowed draw.io XML upload size: 25 MB (XML compresses well). */
const MAX_XML_BYTES = 25 * 1024 * 1024;

const ATTACHMENTS_BASE = process.env.ATTACHMENTS_DIR ?? 'data/attachments';

// Validation errors thrown by `safeAttachmentPath` and its helpers in
// `attachment-handler.ts`. Used by the GET route to map a rejected
// attachment path to 404 instead of letting it bubble up as an
// uncaught 500.
const ATTACHMENT_VALIDATION_MESSAGES = new Set([
  'Invalid page ID',
  'Invalid filename',
  'Path traversal detected',
]);

function isAttachmentValidationError(err: unknown): err is Error {
  return err instanceof Error && ATTACHMENT_VALIDATION_MESSAGES.has(err.message);
}

interface ConfluenceCacheStage {
  filename: string;
  data: Buffer;
  stagePath: string;
}

function confluenceCacheFilePath(pageKey: string, filename: string): string {
  if (
    path.basename(pageKey) !== pageKey ||
    path.basename(filename) !== filename ||
    pageKey.includes('\\') ||
    filename.includes('\\') ||
    !pageKey ||
    !filename ||
    filename.startsWith('.')
  ) {
    throw new Error('Invalid attachment path');
  }
  const base = path.resolve(ATTACHMENTS_BASE);
  const resolved = path.resolve(base, pageKey, filename);
  if (!resolved.startsWith(`${base}${path.sep}`)) {
    throw new Error('Invalid attachment path');
  }
  return resolved;
}

type AttachmentAuthority = PageRevision & {
  id: number;
  source: string;
  confluenceId: string | null;
  spaceKey: string | null;
};

async function loadAttachmentAuthority(
  client: PoolClient,
  input: {
    actorId: string;
    pageId: number;
    remotePageId: string;
    spaceKey: string;
    expected: PageRevision;
  },
): Promise<AttachmentAuthority> {
  const actor = await client.query(
    'SELECT 1 FROM users WHERE id = $1 AND deactivated_at IS NULL',
    [input.actorId],
  );
  if (actor.rowCount !== 1) {
    throw new PageWriteError(403, 'intent_actor_inactive', 'The original actor is no longer active');
  }
  const result = await client.query<AttachmentAuthority>(
    `SELECT id, source, confluence_id AS "confluenceId", space_key AS "spaceKey",
            content_revision::text AS "contentRevision",
            lifecycle_revision::text AS "lifecycleRevision"
       FROM pages
      WHERE id = $1
        AND deleted_at IS NULL
      FOR UPDATE`,
    [input.pageId],
  );
  const page = result.rows[0];
  if (
    !page ||
    page.source !== 'confluence' ||
    page.confluenceId !== input.remotePageId ||
    page.spaceKey !== input.spaceKey
  ) {
    throw new PageWriteError(409, 'intent_page_identity_changed', 'The attachment page identity changed');
  }
  if (page.lifecycleRevision !== input.expected.lifecycleRevision) {
    throw new PageWriteError(409, 'stale_lifecycle', 'The page lifecycle changed after attachment admission');
  }
  if (page.contentRevision !== input.expected.contentRevision) {
    throw new PageWriteError(409, 'stale_content_revision', 'The page content changed after attachment admission');
  }
  const spaces = await getUserAccessibleSpaces(input.actorId, client);
  const pageAccessible = await userCanAccessPage(input.actorId, input.pageId, client);
  if (!pageAccessible || !spaces.includes(input.spaceKey)) {
    throw new PageWriteError(403, 'intent_access_changed', 'Attachment publication authority changed');
  }
  return page;
}

async function currentAttachmentClient(
  intent: PageWriteIntent,
  input: {
    actorId: string;
    pageId: number;
    remotePageId: string;
    spaceKey: string;
  },
): Promise<ConfluenceClient> {
  return withPageWriteTransaction(
    [input.pageId],
    async (client) => {
      await loadAttachmentAuthority(client, {
        ...input,
        expected: intent.revisions[input.pageId]!,
      });
      const confluence = await getClientForUser(input.actorId, client);
      if (!confluence) {
        throw new PageWriteError(
          403,
          'intent_connection_changed',
          'The original actor no longer has an active Confluence connection',
        );
      }
      return confluence;
    },
    { intent },
  );
}


async function stageConfluenceCacheFiles(
  pageKey: string,
  intent: PageWriteIntent,
  files: readonly { filename: string; data: Buffer }[],
): Promise<ConfluenceCacheStage[]> {
  const stages: ConfluenceCacheStage[] = [];
  for (const [index, file] of files.entries()) {
    const livePath = confluenceCacheFilePath(pageKey, file.filename);
    await mkdir(path.dirname(livePath), { recursive: true });
    const stagePath = path.join(
      path.dirname(livePath),
      `.page-write-${intent.id}-${index}.stage`,
    );
    const handle = await open(stagePath, 'wx', 0o600);
    try {
      await handle.writeFile(file.data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    stages.push({ ...file, stagePath });
  }
  return stages;
}
type RecoverableAttachment = {
  filename: string;
  size: number;
  sha256: string;
};

type AttachmentReceipt = {
  filename: string;
  serverId: string;
  versionNumber: number | null;
  versionWhen: string | null;
};

function attachmentReceipt(
  expected: RecoverableAttachment,
  value: {
    id?: unknown;
    title?: unknown;
    version?: { number?: unknown; when?: unknown };
  },
): AttachmentReceipt {
  const versionNumber = value.version?.number;
  const versionWhen = value.version?.when;
  if (
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    value.id.length > 1024 ||
    value.title !== expected.filename ||
    (versionNumber !== undefined &&
      (typeof versionNumber !== 'number' || !Number.isSafeInteger(versionNumber) || versionNumber < 1)) ||
    (versionWhen !== undefined &&
      (typeof versionWhen !== 'string' || versionWhen.length === 0 || versionWhen.length > 256))
  ) {
    throw new PageWriteError(
      502,
      'attachment_receipt_invalid',
      `Confluence returned an incomplete identity for ${expected.filename}`,
    );
  }
  return {
    filename: expected.filename,
    serverId: value.id,
    versionNumber: versionNumber === undefined ? null : versionNumber as number,
    versionWhen: versionWhen === undefined ? null : versionWhen as string,
  };
}

function terminalAttachmentReceipts(
  terminal: Record<string, unknown> | null,
  expected: readonly RecoverableAttachment[],
): AttachmentReceipt[] {
  const values = terminal?.receipts;
  if (!Array.isArray(values) || values.length !== expected.length) {
    throw new PageWriteError(
      409,
      'intent_terminal_result_invalid',
      'Every remote attachment receipt is required for recovery',
    );
  }
  return values.map((value, index) => {
    if (value === null || Array.isArray(value) || typeof value !== 'object') {
      throw new PageWriteError(409, 'intent_terminal_result_invalid', 'An attachment receipt is invalid');
    }
    const record = value as Record<string, unknown>;
    if (
      typeof record.filename !== 'string' ||
      typeof record.serverId !== 'string' ||
      (record.versionNumber !== null &&
        (typeof record.versionNumber !== 'number' ||
          !Number.isSafeInteger(record.versionNumber) ||
          record.versionNumber < 1)) ||
      (record.versionWhen !== null && typeof record.versionWhen !== 'string')
    ) {
      throw new PageWriteError(409, 'intent_terminal_result_invalid', 'An attachment receipt is invalid');
    }
    try {
      return attachmentReceipt(expected[index]!, {
        id: record.serverId,
        title: record.filename,
        version: {
          ...(record.versionNumber === null ? {} : { number: record.versionNumber }),
          ...(record.versionWhen === null ? {} : { when: record.versionWhen }),
        },
      });
    } catch {
      throw new PageWriteError(409, 'intent_terminal_result_invalid', 'An attachment receipt is invalid');
    }
  });
}


function exactAttachmentBytes(bytes: Buffer, expected: RecoverableAttachment): boolean {
  return bytes.length === expected.size &&
    crypto.createHash('sha256').update(bytes).digest('hex') === expected.sha256;
}

async function verifyRemoteAttachmentReceipts(
  confluence: ConfluenceClient,
  remotePageId: string,
  expected: readonly RecoverableAttachment[],
  receipts: readonly AttachmentReceipt[],
): Promise<void> {
  const current = await confluence.getPageAttachments(remotePageId);
  for (let index = 0; index < expected.length; index++) {
    const file = expected[index]!;
    const receipt = receipts[index]!;
    const attachment = current.results.find(
      (candidate) => candidate.id === receipt.serverId && candidate.title === file.filename,
    );
    if (!attachment) {
      throw new PageWriteError(
        409,
        'intent_remote_evidence_conflict',
        `The current remote identity for ${file.filename} no longer matches the upload receipt`,
      );
    }
    const currentVersion = attachment.version as
      | { number?: unknown; when?: unknown }
      | undefined;
    if (
      receipt.versionNumber !== null &&
      typeof currentVersion?.number === 'number'
    ) {
      if (currentVersion.number !== receipt.versionNumber) {
        throw new PageWriteError(
          409,
          'intent_remote_evidence_conflict',
          `The current remote version for ${file.filename} no longer matches the upload receipt`,
        );
      }
      continue;
    }
    if (
      receipt.versionWhen !== null &&
      typeof currentVersion?.when === 'string'
    ) {
      if (currentVersion.when !== receipt.versionWhen) {
        throw new PageWriteError(
          409,
          'intent_remote_evidence_conflict',
          `The current remote version for ${file.filename} no longer matches the upload receipt`,
        );
      }
      continue;
    }
    const downloadPath = attachment._links?.download;
    if (!downloadPath) {
      throw new PageWriteError(
        409,
        'intent_remote_evidence_incomplete',
        `The current remote bytes for ${file.filename} cannot be verified`,
      );
    }
    const bytes = await confluence.downloadAttachment(downloadPath);
    if (!exactAttachmentBytes(bytes, file)) {
      throw new PageWriteError(
        409,
        'intent_remote_evidence_conflict',
        `The current remote bytes for ${file.filename} conflict with the admitted upload`,
      );
    }
  }
}

function recoverableAttachments(effect: Record<string, unknown>): {
  pageId: number;
  remotePageId: string;
  spaceKey: string;
  files: RecoverableAttachment[];
} {
  if (
    typeof effect.pageId !== 'number' ||
    !Number.isSafeInteger(effect.pageId) ||
    typeof effect.remotePageId !== 'string' ||
    typeof effect.spaceKey !== 'string' ||
    effect.spaceKey.length === 0 ||
    !Array.isArray(effect.files)
  ) {
    throw new PageWriteError(409, 'intent_recovery_metadata_invalid', 'Attachment recovery metadata is incomplete');
  }
  const files = effect.files.map((value) => {
    if (
      value === null ||
      Array.isArray(value) ||
      typeof value !== 'object' ||
      typeof value.filename !== 'string' ||
      typeof value.size !== 'number' ||
      !Number.isSafeInteger(value.size) ||
      value.size < 0 ||
      typeof value.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.sha256)
    ) {
      throw new PageWriteError(409, 'intent_recovery_metadata_invalid', 'Attachment identity is invalid');
    }
    return { filename: value.filename, size: value.size, sha256: value.sha256 };
  });
  return {
    pageId: effect.pageId,
    remotePageId: effect.remotePageId,
    spaceKey: effect.spaceKey,
    files,
  };
}

async function readExactAttachment(pathname: string, expected: RecoverableAttachment): Promise<Buffer | null> {
  try {
    const bytes = await readFile(pathname);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== expected.size || digest !== expected.sha256) {
      throw new PageWriteError(
        409,
        'intent_local_evidence_mismatch',
        `The staged bytes for ${expected.filename} do not match the admitted attachment`,
      );
    }
    return bytes;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

const reconcileConfluenceAttachmentPut: PageWriteIntentReconciler = async (client, intent) => {
  const metadata = recoverableAttachments(intent.effect);
  if (intent.pageIds.length !== 1 || intent.pageIds[0] !== metadata.pageId) {
    throw new PageWriteError(409, 'intent_recovery_metadata_invalid', 'Attachment page identity changed');
  }
  const stagePaths = metadata.files.map((file, index) =>
    path.join(
      path.dirname(confluenceCacheFilePath(metadata.remotePageId, file.filename)),
      `.page-write-${intent.id}-${index}.stage`,
    ));

  if (intent.remoteEffectStartedAt === null) {
    for (const stagePath of stagePaths) await rm(stagePath, { force: true });
    for (const stagePath of stagePaths) {
      try {
        await stat(stagePath);
        throw new PageWriteError(409, 'intent_local_cleanup_incomplete', 'An intent-owned stage file remains');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return {
      outcome: 'not_applied',
      proof: {
        kind: 'remote_effect_not_started',
        observedAt: new Date().toISOString(),
        reference: `attachment-stage:${intent.id}:absent`,
        details: { syscallSettled: true, remoteEffectStarted: false, observedAbsent: true },
      },
      result: { removedStages: stagePaths.length },
    };
  }

  if (intent.remoteEffectsCompletedAt === null || !intent.actorId) {
    throw new PageWriteError(409, 'intent_outcome_unrecoverable', 'The remote attachment outcome is unknown');
  }
  const currentRevision = intent.revisions[metadata.pageId];
  if (!currentRevision) {
    throw new PageWriteError(409, 'intent_recovery_metadata_invalid', 'Attachment revision identity is unavailable');
  }
  await loadAttachmentAuthority(client, {
    actorId: intent.actorId,
    pageId: metadata.pageId,
    remotePageId: metadata.remotePageId,
    spaceKey: metadata.spaceKey,
    expected: currentRevision,
  });
  const confluence = await getClientForUser(intent.actorId, client);
  if (!confluence) {
    throw new PageWriteError(
      403,
      'intent_connection_changed',
      'The original actor no longer has an active Confluence connection',
    );
  }
  const receipts = terminalAttachmentReceipts(intent.remoteTerminalResult, metadata.files);
  await verifyRemoteAttachmentReceipts(
    confluence,
    metadata.remotePageId,
    metadata.files,
    receipts,
  );

  const localEvidence: Array<{ stagePath: string; livePath: string; staged: boolean }> = [];
  for (let index = 0; index < metadata.files.length; index++) {
    const expected = metadata.files[index]!;
    const stagePath = stagePaths[index]!;
    const livePath = confluenceCacheFilePath(metadata.remotePageId, expected.filename);
    const staged = await readExactAttachment(stagePath, expected);
    if (!staged && !(await readExactAttachment(livePath, expected))) {
      throw new PageWriteError(
        409,
        'intent_local_evidence_missing',
        `Neither staged nor published bytes exist for ${expected.filename}`,
      );
    }
    localEvidence.push({ stagePath, livePath, staged: staged !== null });
  }
  let stagedBytesPublished = false;
  for (const evidence of localEvidence) {
    if (!evidence.staged) continue;
    await rename(evidence.stagePath, evidence.livePath);
    stagedBytesPublished = true;
  }

  const terminalRevision = intent.remoteTerminalResult?.publicationContentRevision;
  const currentContentRevision = currentRevision.contentRevision;
  if (typeof terminalRevision !== 'string') {
    throw new PageWriteError(409, 'intent_terminal_result_invalid', 'Attachment publication revision is unavailable');
  }
  if (stagedBytesPublished || currentContentRevision === terminalRevision) {
    const updated = await client.query<{ content_revision: string }>(
      `UPDATE pages
          SET image_analysis_dirty = TRUE,
              content_revision = content_revision + 1
        WHERE id = $1
        RETURNING content_revision::text`,
      [metadata.pageId],
    );
    await getPageBaselineGovernanceHook()?.invalidateProposalForMutation?.({
      client,
      pageId: metadata.pageId,
      contentRevision: updated.rows[0]!.content_revision,
    });
  }
  await enqueuePageWriteInvalidation(client, intent.id);
  const evidence = crypto.createHash('sha256')
    .update(JSON.stringify({ files: metadata.files, receipts }))
    .digest('hex');
  return {
    outcome: 'applied',
    proof: {
      kind: 'remote_terminal_effect_verified',
      observedAt: new Date().toISOString(),
      reference: `confluence-attachments:${metadata.remotePageId}:${evidence}`,
      details: { remoteEffectsCompleted: true, terminalEvidence: evidence },
    },
    result: { files: metadata.files.length },
  };
};

let attachmentReconcilerRegistered = false;

export function registerAttachmentReconciler(): void {
  if (attachmentReconcilerRegistered) return;
  registerPageWriteIntentReconciler('attachment.confluence.put', reconcileConfluenceAttachmentPut);
  attachmentReconcilerRegistered = true;
}


export async function attachmentRoutes(fastify: FastifyInstance) {
  registerAttachmentReconciler();
  fastify.addHook('onRequest', fastify.authenticate);

  // GET /api/attachments/:pageId/list - list all cached attachments for a page
  fastify.get('/attachments/:pageId/list', async (request, reply) => {
    const { pageId } = request.params as { pageId: string };
    const userId = request.userId;

    // Verify the page belongs to the user's accessible spaces (RBAC)
    const listSpaces = await getUserAccessibleSpaces(userId);
    const pageResult = await query<{ confluence_id: string }>(
      `SELECT cp.confluence_id
       FROM pages cp
       WHERE cp.space_key = ANY($1::text[])
         AND cp.confluence_id = $2`,
      [listSpaces, pageId],
    );
    if (pageResult.rows.length === 0) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Page not found in accessible spaces',
      });
    }

    const resolvedId = pageResult.rows[0]!.confluence_id;
    const dirPath = path.join(ATTACHMENTS_BASE, path.basename(resolvedId));

    try {
      const entries = await readdir(dirPath);
      const results = await Promise.allSettled(
        entries.map(async (filename) => {
          const filePath = path.join(dirPath, filename);
          const fileStat = await stat(filePath);
          return {
            filename,
            size: fileStat.size,
            url: `/api/attachments/${pageId}/${encodeURIComponent(filename)}`,
          };
        }),
      );
      const attachments = results
        .filter((r): r is PromiseFulfilledResult<{ filename: string; size: number; url: string }> => r.status === 'fulfilled')
        .map(r => r.value);
      return reply.send({ attachments });
    } catch (err) {
      // Directory doesn't exist — no attachments cached yet, not an error
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return reply.send({ attachments: [] });
      }
      logger.error({ err, userId, pageId, dirPath }, 'Failed to list attachments');
      throw fastify.httpErrors.internalServerError('Failed to list attachments');
    }
  });

  // GET /api/attachments/:pageId/:filename - serve cached or on-demand fetched attachment
  fastify.get('/attachments/:pageId/:filename', async (request, reply) => {
    const { pageId, filename } = request.params as { pageId: string; filename: string };
    const userId = request.userId;

    const attachSpaces = await getUserAccessibleSpaces(userId);
    // Look up by confluence_id (Confluence pages) in accessible spaces
    let pageResult = await query<{
      id: number;
      body_storage: string | null;
      space_key: string;
      source: string;
    }>(
      `SELECT cp.id, cp.body_storage, cp.space_key, cp.source
       FROM pages cp
       WHERE cp.space_key = ANY($1::text[])
         AND cp.confluence_id = $2`,
      [attachSpaces, pageId],
    );
    // Fallback: standalone pages use integer PK as their attachment pageId.
    // Deliberately NOT visiblePagesPredicate(): this branch is standalone-only
    // by construction (Confluence pages were handled by the query above).
    if (pageResult.rows.length === 0 && /^\d+$/.test(pageId)) {
      pageResult = await query<{
        id: number;
        body_storage: string | null;
        space_key: string;
        source: string;
      }>(
        `SELECT cp.id, cp.body_storage, cp.space_key, cp.source
         FROM pages cp
         WHERE cp.id = $1
           AND cp.source = 'standalone'
           AND (cp.visibility = 'shared' OR cp.created_by_user_id = $2)
           AND cp.deleted_at IS NULL`,
        [Number(pageId), userId],
      );
    }
    const cachedPage = pageResult.rows[0];
    if (!cachedPage) {
      logger.warn({ userId, pageId, filename }, 'Attachment 404: page not found in user accessible spaces');
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Attachment not found',
        reason: 'page_not_in_selected_spaces',
      });
    }

    const frozen = await readFrozenPageAttachment({
      pageId: cachedPage.id,
      actorId: userId,
      locator: {
        store: 'confluence',
        pageKey: pageId,
        filename,
      },
    });
    if (frozen.state === 'frozen_missing') {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Attachment not found',
      });
    }
    if (frozen.state === 'frozen') {
      const mimeType = getMimeType(filename);
      reply
        .header('Content-Type', mimeType)
        .header('Content-Length', String(frozen.size))
        .header('Cache-Control', 'private, max-age=3600');
      if (mimeType === 'image/svg+xml') {
        reply.header('Content-Security-Policy', 'sandbox');
        reply.header('Content-Disposition', 'attachment');
      }
      return reply.send(frozen.stream);
    }

    // Try local cache first. `readAttachment` (and the on-demand
    // `fetchAndCachePageImage` below) call `safeAttachmentPath`, which
    // throws on inputs that fail the allow-list (`Invalid page ID`,
    // `Invalid filename`, `Path traversal detected`). Map those throws
    // to a clean 404 so an unreachable on-disk path is indistinguishable
    // from a missing attachment to the client, while logging the rejection.
    let data: Buffer | null;
    try {
      data = await readAttachment(pageId, filename);
    } catch (err) {
      if (isAttachmentValidationError(err)) {
        logger.warn(
          { userId, pageId, filename, reason: err.message },
          'Rejected attachment request with invalid path',
        );
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: 'Attachment not found',
        });
      }
      throw err;
    }
    if (data) {
      logger.debug({ pageId, filename, size: data.length }, 'Serving attachment from local cache');
    }

    // On cache miss, fetch from Confluence on-demand (skip for standalone pages — no Confluence source)
    if (!data && cachedPage.source !== 'standalone') {
      logger.debug({ pageId, filename }, 'Attachment cache miss — attempting on-demand fetch');

      // Check for a cached failure sentinel — avoids hammering Confluence for known-broken attachments
      const failureSentinelKey = `attachment:failure:${userId}:${pageId}:${filename}`;
      try {
        const redis = getRedisClient();
        if (redis) {
          const sentinel = await redis.get(failureSentinelKey);
          if (sentinel) {
            logger.warn({ userId, pageId, filename }, 'Attachment fetch skipped: cached failure sentinel found');
            return reply.status(502).send({
              statusCode: 502,
              error: 'Bad Gateway',
              message: 'Attachment unavailable: Confluence returned a server error',
              reason: 'confluence_upstream_error',
            });
          }
        }
      } catch {
        // Redis may be unavailable — proceed with the fetch attempt
      }

      const client = await getClientForUser(userId);
      if (!client) {
        // User has no Confluence PAT configured — can't fetch on-demand
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: 'Attachment not found',
          reason: 'no_confluence_client',
        });
      }

      try {
        if (cachedPage.body_storage) {
          data = await fetchAndCachePageImage({
            client,
            userId,
            pageId,
            localFilename: filename,
            bodyStorage: cachedPage.body_storage,
            currentSpaceKey: cachedPage.space_key,
            redis: getRedisClient(),
          });
        } else {
          data = null;
        }
      } catch (err) {
        if (err instanceof ConfluenceError && err.statusCode >= 500) {
          // Confluence returned a server error (e.g. broken/legacy attachment) — cache the failure
          // to avoid repeated hammering, then surface as 502 Bad Gateway
          logger.warn({ err, userId, pageId, filename, statusCode: err.statusCode }, 'Confluence server error fetching attachment — caching failure sentinel');
          try {
            const redis = getRedisClient();
            if (redis) {
              await redis.setEx(failureSentinelKey, 300, '1');
            }
          } catch {
            // Redis may be unavailable — non-fatal
          }
          return reply.status(502).send({
            statusCode: 502,
            error: 'Bad Gateway',
            message: 'Attachment unavailable: Confluence returned a server error',
            reason: 'confluence_upstream_error',
          });
        }
        logger.error({ err, userId, pageId, filename }, 'On-demand attachment fetch failed');
        // Infrastructure error — don't expose as a "not found"
        throw fastify.httpErrors.internalServerError('Failed to fetch attachment from Confluence');
      }

      if (!data) {
        // fetchAndCachePageImage returned null — asset genuinely not in source system
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: 'Attachment not found',
          reason: 'not_found_in_confluence',
        });
      }
    }

    // If data is still null after all lookup attempts, return 404
    if (!data) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Attachment not found',
      });
    }

    const mimeType = getMimeType(filename);
    reply.header('Content-Type', mimeType);
    reply.header('Cache-Control', 'public, max-age=3600');

    // SVG files can contain embedded JavaScript — prevent execution
    if (mimeType === 'image/svg+xml') {
      reply.header('Content-Security-Policy', 'sandbox');
      reply.header('Content-Disposition', 'attachment');
    }

    return reply.send(data);
  });

  // PUT /api/attachments/:pageId/:filename - update a diagram attachment
  // Accepts a JSON body with { dataUri: "data:image/png;base64,...", xml?: "..." }
  // Validates PNG, enforces 10 MB limit, uploads to Confluence, and updates local cache.
  //
  // `bodyLimit` must be set per-route: Fastify's default JSON body limit is
  // 1 MiB, so the in-handler caps (10 MB PNG + 25 MB .drawio XML) would be
  // unreachable without this option. Base64 inflates binary by ~33 %, plus
  // JSON overhead for key names and the xml field — 40 MB comfortably
  // covers the combined 10 MB PNG (base64) + 25 MB XML payload.
  // Mirrors the same pattern on the local-attachments route (PR #318).
  fastify.put('/attachments/:pageId/:filename', { bodyLimit: 40 * 1024 * 1024 }, async (request, reply) => {
    const { pageId, filename } = request.params as { pageId: string; filename: string };
    const userId = request.userId;

    // Validate request body with Zod
    const parseResult = UpdateAttachmentBodySchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: parseResult.error.issues[0]?.message ?? 'Missing or invalid dataUri in request body',
      });
    }
    const { dataUri, xml } = parseResult.data;

    const pngPrefix = 'data:image/png;base64,';
    if (!dataUri.startsWith(pngPrefix)) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Only PNG data URIs are supported (must start with data:image/png;base64,)',
      });
    }

    // Decode the base64 data
    const base64Data = dataUri.slice(pngPrefix.length);
    let pngBuffer: Buffer;
    try {
      pngBuffer = Buffer.from(base64Data, 'base64');
    } catch {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Invalid base64 data in dataUri',
      });
    }

    // Validate PNG magic bytes
    const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (pngBuffer.length < 8 || !pngBuffer.subarray(0, 8).equals(PNG_MAGIC)) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Data is not a valid PNG file',
      });
    }

    // Enforce size limit
    if (pngBuffer.length > MAX_UPLOAD_BYTES) {
      return reply.status(413).send({
        statusCode: 413,
        error: 'Payload Too Large',
        message: `Attachment exceeds maximum size of ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB`,
      });
    }

    let xmlFilename: string | undefined;
    let xmlBuffer: Buffer | undefined;
    if (xml) {
      xmlFilename = filename.toLowerCase().endsWith('.png')
        ? filename.slice(0, -4) + '.drawio'
        : `${filename}.drawio`;
      xmlBuffer = Buffer.from(xml, 'utf8');
      if (xmlBuffer.length > MAX_XML_BYTES) {
        return reply.status(413).send({
          statusCode: 413,
          error: 'Payload Too Large',
          message: `XML exceeds maximum size of ${MAX_XML_BYTES / (1024 * 1024)} MB`,
        });
      }
    }

    // Reject unsafe names before durable admission or remote I/O.
    try {
      confluenceCacheFilePath(pageId, filename);
      if (xmlFilename) confluenceCacheFilePath(pageId, xmlFilename);
    } catch {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Invalid attachment path',
      });
    }

    const putSpaces = await getUserAccessibleSpaces(userId);
    const pageResult = await query<{
      id: number;
      source: string;
      confluence_id: string | null;
      space_key: string;
      content_revision: string;
      lifecycle_revision: string;
    }>(
      `SELECT cp.id, cp.source, cp.confluence_id, cp.space_key,
              cp.content_revision::text, cp.lifecycle_revision::text
         FROM pages cp
        WHERE cp.space_key = ANY($1::text[])
          AND cp.confluence_id = $2
          AND cp.source = 'confluence'
          AND cp.deleted_at IS NULL`,
      [putSpaces, pageId],
    );
    const page = pageResult.rows[0];
    if (!page || !page.confluence_id) {
      return reply.status(404).send({
        statusCode: 404,
        error: 'Not Found',
        message: 'Page not found in accessible spaces',
      });
    }


    const files = [
      { filename, data: pngBuffer, contentType: 'image/png' },
      ...(xmlFilename && xmlBuffer
        ? [{ filename: xmlFilename, data: xmlBuffer, contentType: 'application/xml' }]
        : []),
    ];
    const recoverableFiles = files.map((file) => ({
      filename: file.filename,
      size: file.data.length,
      sha256: crypto.createHash('sha256').update(file.data).digest('hex'),
    }));
    const expectedRevision: PageRevision = {
      contentRevision: page.content_revision,
      lifecycleRevision: page.lifecycle_revision,
    };
    const runtimeId = await getPageWriterRuntimeId();
    const reservationClient = await getPool().connect();
    let intent: PageWriteIntent;
    try {
      await reservationClient.query('BEGIN');
      await lockPageWriterRuntime(reservationClient, runtimeId);
      await lockPageLifecycle(reservationClient, [page.id]);
      intent = await reservePageWriteIntentInTransaction(reservationClient, {
        pageIds: [page.id],
        kind: 'attachment.confluence.put',
        actorId: userId,
        expectedRevisions: { [page.id]: expectedRevision },
        effect: {
          effectClass: 'remote',
          pageId: page.id,
          remotePageId: page.confluence_id,
          spaceKey: page.space_key,
          files: recoverableFiles,
          receipts: [],
        },
      });
      await loadAttachmentAuthority(reservationClient, {
        actorId: userId,
        pageId: page.id,
        remotePageId: page.confluence_id,
        spaceKey: page.space_key,
        expected: expectedRevision,
      });
      if (!(await getClientForUser(userId, reservationClient))) {
        throw new PageWriteError(
          400,
          'confluence_not_configured',
          'No Confluence connection configured. Please set up your PAT in settings.',
        );
      }
      await reservationClient.query('COMMIT');
    } catch (error) {
      await reservationClient.query('ROLLBACK');
      throw error;
    } finally {
      reservationClient.release();
    }

    try {
      try {
        await withPageWriteTransaction(
          [page.id],
          (client) => loadAttachmentAuthority(client, {
            actorId: userId,
            pageId: page.id,
            remotePageId: page.confluence_id!,
            spaceKey: page.space_key,
            expected: intent.revisions[page.id]!,
          }),
          { intent },
        );
      } catch (error) {
        await cancelPageWriteIntentBeforeEffect(intent);
        throw error;
      }
      const staged = await runPageWriteIntentEffect(
        intent,
        { kind: 'local' },
        () => stageConfluenceCacheFiles(page.confluence_id!, intent, files),
      );

      // Re-resolve the original actor's current credentials on the same
      // authoritative DB snapshot used for the phase authorization.
      const remoteClient = await currentAttachmentClient(intent, {
        actorId: userId,
        pageId: page.id,
        remotePageId: page.confluence_id,
        spaceKey: page.space_key,
      });
      const receipts = await runPageWriteIntentEffect(
        intent,
        {
          kind: 'remote',
          completesRemoteWork: true,
          terminalResult: (completed) => ({
            remotePageId: page.confluence_id,
            publicationContentRevision: intent.revisions[page.id]!.contentRevision,
            receipts: completed,
          }),
        },
        async () => {
          const completed: AttachmentReceipt[] = [];
          for (let index = 0; index < files.length; index++) {
            const file = files[index]!;
            const phaseClient = index === 0
              ? remoteClient
              : await currentAttachmentClient(intent, {
                  actorId: userId,
                  pageId: page.id,
                  remotePageId: page.confluence_id!,
                  spaceKey: page.space_key,
                });
            const uploaded = await phaseClient.updateAttachment(
              page.confluence_id!,
              file.filename,
              file.data,
              file.contentType,
            );
            const receipt = attachmentReceipt(recoverableFiles[index]!, uploaded);
            await advancePageWriteIntent(intent, async (client) => {
              await client.query(
                `UPDATE page_write_intents
                    SET effect = jsonb_set(
                      effect,
                      '{receipts}',
                      COALESCE(effect->'receipts', '[]'::jsonb) || $2::jsonb
                    )
                  WHERE id = $1
                    AND status = 'pending'`,
                [intent.id, JSON.stringify([receipt])],
              );
            });
            completed.push(receipt);
          }
          return completed;
        },
      );

      const publicationClient = await currentAttachmentClient(intent, {
        actorId: userId,
        pageId: page.id,
        remotePageId: page.confluence_id,
        spaceKey: page.space_key,
      });
      await verifyRemoteAttachmentReceipts(
        publicationClient,
        page.confluence_id,
        recoverableFiles,
        receipts,
      );
      await runPageWriteIntentEffect(
        intent,
        { kind: 'local' },
        () => advancePageWriteIntent(intent, async (lockedClient) => {
          await loadAttachmentAuthority(lockedClient, {
            actorId: userId,
            pageId: page.id,
            remotePageId: page.confluence_id!,
            spaceKey: page.space_key,
            expected: intent.revisions[page.id]!,
          });
          await lockedClient.query(
            'SELECT pg_advisory_xact_lock_shared($1)',
            [ATTACHMENT_SNAPSHOT_LOCK_ID],
          );
          for (const stage of staged) {
            await rename(
              stage.stagePath,
              confluenceCacheFilePath(page.confluence_id!, stage.filename),
            );
          }
          const updated = await lockedClient.query<{ content_revision: string }>(
            `UPDATE pages
                SET image_analysis_dirty = TRUE,
                    content_revision = content_revision + 1
              WHERE id = $1
              RETURNING content_revision::text`,
            [page.id],
          );
          await getPageBaselineGovernanceHook()?.invalidateProposalForMutation?.({
            client: lockedClient,
            pageId: page.id,
            contentRevision: updated.rows[0]!.content_revision,
          });
          await enqueuePageWriteInvalidation(lockedClient, intent.id);
        }),
      );
      await completePageWriteIntent(intent, async () => undefined);

      try {
        const redis = getRedisClient();
        if (redis) {
          const pattern = `*:page:${pageId}*`;
          let cursor = '0';
          do {
            const result = await redis.scan(cursor, { MATCH: pattern, COUNT: 100 });
            cursor = String(result.cursor);
            if (result.keys.length > 0) await redis.del(result.keys);
          } while (cursor !== '0');
        }
      } catch {
        // Cache delivery is derived and may recover by expiry.
      }

      logger.info(
        { userId, pageId, files: files.map((file) => file.filename), intentId: intent.id },
        'Diagram attachment mutation committed',
      );
      return reply.status(200).send({
        success: true,
        filename,
        size: pngBuffer.length,
        xmlFilename,
        xmlSize: xmlBuffer?.length,
      });
    } catch (err) {
      if (err instanceof PageWriteError) throw err;
      logger.error(
        { err, userId, pageId, filename, intentId: intent.id },
        'Attachment mutation left unresolved for reconciliation',
      );
      const message = err instanceof Error ? err.message : 'Unknown error';
      throw fastify.httpErrors.internalServerError(`Failed to update attachment: ${message}`);
    }
  });
}
