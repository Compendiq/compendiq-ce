/**
 * Collab gateway (#1444/#1445/#1448): GET /api/collab/config, GET /api/collab/:pageId
 * (WebSocket), POST /api/pages/:id/collab/commit (standalone + Confluence).
 * Completes the 101, then 4401/4403/4404 before SyncStep1. Do not throw
 * `authenticate` in onRequest on the WS route — browsers cannot see HTTP 401.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import {
  COLLAB_UPGRADE_WINDOW_SEC,
  COLLAB_WS_PROTOCOL,
  CollabCommitResponseSchema,
  CollabCommitSchema,
  CollabConfigSchema,
  PagePrimaryKeySchema,
  type CollabCommit,
} from '@compendiq/contracts';
import { query } from '../../core/db/postgres.js';
import { logger } from '../../core/utils/logger.js';
import { verifyToken } from '../../core/plugins/auth.js';
import { getUserSecurityState } from '../../core/services/user-security-cache.js';
import { userCanAccessPage, userCanEditPage } from '../../core/services/rbac-service.js';
import { isCollabEditingEnabled } from '../../core/services/collab-flag.js';
import { getRedisClient } from '../../core/services/redis-cache.js';
import {
  COLLAB_PING_INTERVAL_MS,
  getDefaultCollabRuntime,
  refreshCollabActiveTtl,
  type CollabRuntime,
} from '../../core/services/collab-room-service.js';
import { assignTaskIds, htmlToConfluence, htmlToText } from '../../core/services/content-converter.js';
import type { CollabTaskItem } from '../../core/services/collab-schema.js';
import { RedisCache } from '../../core/services/redis-cache.js';
import { logAuditEvent } from '../../core/services/audit-service.js';
import { getClientForUser } from '../../domains/confluence/services/sync-service.js';
import {
  ConfluenceError,
  type ConfluenceClient,
} from '../../domains/confluence/services/confluence-client.js';
import {
  planLocalImagesForConfluence,
  preparePastedImagePlan,
  uploadPreparedPastedImage,
  type PastedImageUploadReceipt,
  type PreparedPastedImage,
} from '../../domains/confluence/services/pasted-image-uploader.js';
import { pageWriteStaysLocal } from '../../domains/confluence/services/standalone-mode.js';
import {
  completePageWriteIntent,
  cancelPageWriteIntentBeforeEffect,
  deferPageRequestAdmissionRelease,
  PageWriteError,
  releasePageRuntime,
  reservePageWriteIntentInTransaction,
  runPageWriteIntentEffect,
  withPageWriteTransaction,
  type PageRuntimeAdmission,
} from '../../core/services/page-write-admission.js';
import {
  confirmPagePublication,
  pagePublicationReceipt,
} from '../../domains/confluence/services/ordinary-page-write-reconciler.js';
import {
  describeCollabCommit,
  publishCollabCommit,
} from '../../domains/confluence/services/collab-commit-intent-reconciler.js';

const UPGRADE_LIMIT_PER_MIN = 20;
// Frames that arrive before the join completes wait in arrival order and are
// handled before any later frame. y-websocket sends SyncStep1 and awareness on
// open and renews awareness every 15 s, so a slow join must not refuse them;
// the bound only caps memory for a socket that is not live yet (#1895).
const PRELIVE_FRAME_LIMIT = 64;
const PRELIVE_BYTE_LIMIT = 1024 * 1024;

function throwConfluenceModified(
  fastify: FastifyInstance,
  remoteVersion: number,
  localVersion: number,
): never {
  throw Object.assign(
    fastify.httpErrors.conflict(
      'This page was modified in Confluence. Your collaborative session is still open — nobody\'s edits were overwritten.',
    ),
    { code: 'confluence_modified', remoteVersion, localVersion },
  );
}

type CollabCommitPage = {
  id: number;
  version: number;
  source: string;
  visibility: string;
  confluence_id: string | null;
  space_key: string | null;
  lifecycle_revision: string;
  baseline_id: string | null;
  body_storage: string | null;
};

async function assertCurrentCollabMutationAuthority(
  client: PoolClient,
  expected: CollabCommitPage,
  userId: string,
): Promise<void> {
  const state = await client.query<{
    version: number;
    source: string;
    confluence_id: string | null;
    lifecycle_revision: string;
    baseline_id: string | null;
    deleted_at: Date | null;
  }>(
    `SELECT version, source, confluence_id, lifecycle_revision::text,
            baseline_id, deleted_at
       FROM pages
      WHERE id = $1`,
    [expected.id],
  );
  const current = state.rows[0];
  if (
    !current
    || current.deleted_at !== null
    || current.source !== expected.source
    || current.confluence_id !== expected.confluence_id
    || current.lifecycle_revision !== expected.lifecycle_revision
    || (expected.source === 'confluence' && current.version !== expected.version)
  ) {
    throw new PageWriteError(
      409,
      'collab_commit_identity_changed',
      'The page identity or lifecycle changed during collaborative publication',
    );
  }
  if (current.baseline_id !== null) {
    throw new PageWriteError(423, 'page_is_frozen', 'Frozen pages cannot be changed');
  }
  const actor = await client.query(
    'SELECT 1 FROM users WHERE id = $1 AND deactivated_at IS NULL',
    [userId],
  );
  if (
    actor.rowCount !== 1
    || !(await userCanAccessPage(userId, expected.id, client))
    || !(await userCanEditPage(userId, expected.id, client))
  ) {
    throw new PageWriteError(
      403,
      'collab_commit_authority_changed',
      'The collaborative writer is no longer authorized',
    );
  }
}

async function currentConfluenceCommitClient(
  dbClient: PoolClient,
  expected: CollabCommitPage,
  userId: string,
): Promise<ConfluenceClient> {
  await assertCurrentCollabMutationAuthority(dbClient, expected, userId);
  const client = await getClientForUser(userId, dbClient);
  if (!client) {
    throw new PageWriteError(
      409,
      'intent_actor_credentials_unavailable',
      'The collaborative writer credentials are no longer available',
    );
  }
  return client;
}

async function commitConfluencePage(args: {
  fastify: FastifyInstance;
  request: FastifyRequest;
  pageId: number;
  userId: string;
  existing: CollabCommitPage;
  body: CollabCommit;
  html: string;
  taskItems: CollabTaskItem[];
  taskIdsCarried: boolean;
  runtime: CollabRuntime;
  admission: PageRuntimeAdmission;
}) {
  const { fastify, request, pageId, userId, existing, body, html, taskItems, taskIdsCarried, runtime, admission } = args;
  if (!existing.confluence_id) {
    throw fastify.httpErrors.badRequest('Confluence page is missing a remote id');
  }

  const imagePlan = await planLocalImagesForConfluence(html);
  // #1751: the room keeps its HTML, so the Save stores the task ids it writes
  // in the room once it settles (markWrittenTaskIds below); the n-th task item
  // of the snapshot is the n-th task of `html`. The room persists its own HTML
  // into body_html every 2 s, so whether the page predates carried ids comes
  // from the room's flag (collabCarriesTaskIds), not from that column.
  const assigned = assignTaskIds(imagePlan.bodyHtml, {
    previousStorage: existing.body_storage,
    legacyTasks: !taskIdsCarried,
  });
  const storageBody = htmlToConfluence(assigned.html);
  const taskIdMarkers = assigned.taskIds.length === taskItems.length
    ? taskItems.flatMap((item, index) => {
      const taskId = assigned.taskIds[index]!;
      return item.taskId === taskId ? [] : [{ client: item.client, clock: item.clock, taskId }];
    })
    : [];

  // The room admission and a fresh authority/client read immediately precede
  // the provider read. A revoked actor must not carry initial-route authority
  // across any awaited filesystem or provider work.
  let readClient: ConfluenceClient;
  try {
    readClient = await withPageWriteTransaction(
      [pageId],
      (dbClient) => currentConfluenceCommitClient(dbClient, existing, userId),
      { admission },
    );
  } catch (error) {
    if (
      error instanceof PageWriteError
      && error.reason === 'intent_actor_credentials_unavailable'
    ) {
      throw fastify.httpErrors.badRequest('Confluence not configured');
    }
    throw error;
  }
  const remote = await readClient.getPage(existing.confluence_id);
  const remoteVersion = remote.version.number;
  if (remoteVersion !== existing.version) {
    throwConfluenceModified(fastify, remoteVersion, existing.version);
  }

  const publication = describeCollabCommit({
    actorId: userId,
    pageId,
    confluenceId: existing.confluence_id,
    title: body.title,
    bodyStorage: storageBody,
    expectedRemoteVersion: existing.version,
    expectedLifecycleRevision: existing.lifecycle_revision,
    images: imagePlan.images.map((image) => ({
      filename: image.filename,
      mimeType: image.mimeType,
      size: image.size,
      contentSha256: image.contentSha256,
    })),
  });
  // No `expectedRevisions` (#1762): the published body is the room snapshot,
  // not the row read before it, so a content pin only refused the Save when a
  // non-conflicting write (typically this room's own 2 s persist) landed
  // meanwhile. `{ admission }` still pins the lifecycle on this transaction
  // (409 `stale_lifecycle`), the authority check pins identity and local
  // version, and the intent stores the revisions of the row locked here.
  const intent = await withPageWriteTransaction([pageId], async (dbClient) => {
    await assertCurrentCollabMutationAuthority(dbClient, existing, userId);
    return reservePageWriteIntentInTransaction(dbClient, {
      pageIds: [pageId],
      kind: imagePlan.images.length > 0
        ? 'collab.commit.confluence.media'
        : 'collab.commit.confluence',
      actorId: userId,
      effect: publication.effect,
    });
  }, { admission });

  let preparedImages: PreparedPastedImage[];
  try {
    preparedImages = await preparePastedImagePlan(imagePlan);
  } catch (error) {
    await cancelPageWriteIntentBeforeEffect(intent);
    throw error;
  }

  const attachmentReceipts: PastedImageUploadReceipt[] = [];
  for (const image of preparedImages) {
    let attachmentClient: ConfluenceClient;
    try {
      attachmentClient = await withPageWriteTransaction(
        [pageId],
        (dbClient) => currentConfluenceCommitClient(dbClient, existing, userId),
        { intent },
      );
    } catch (error) {
      if (attachmentReceipts.length === 0) {
        await cancelPageWriteIntentBeforeEffect(intent);
      }
      throw error;
    }
    const receipt = await runPageWriteIntentEffect(
      intent,
      { kind: 'remote', completesRemoteWork: false },
      () => uploadPreparedPastedImage(
        image,
        existing.confluence_id!,
        attachmentClient,
        request.log,
      ),
    );
    attachmentReceipts.push(receipt);
  }

  let updateClient: ConfluenceClient;
  try {
    updateClient = await withPageWriteTransaction(
      [pageId],
      (dbClient) => currentConfluenceCommitClient(dbClient, existing, userId),
      { intent },
    );
  } catch (error) {
    if (attachmentReceipts.length === 0) {
      await cancelPageWriteIntentBeforeEffect(intent);
    }
    throw error;
  }

  const remotePublication = await (async () => {
    try {
      return await runPageWriteIntentEffect(
        intent,
        {
          kind: 'remote',
          completesRemoteWork: true,
          terminalResult: (remote) => ({
            ...remote.receipt,
            attachments: attachmentReceipts,
          }),
        },
        async () => {
          const confPage = await updateClient.updatePage(
            existing.confluence_id!,
            body.title,
            storageBody,
            existing.version,
          );
          return {
            confPage,
            receipt: pagePublicationReceipt(
              existing.confluence_id!,
              existing.version + 1,
              confPage,
            ),
          };
        },
      );
    } catch (err) {
      if (err instanceof ConfluenceError && err.statusCode === 409) {
        let observedVersion = existing.version + 1;
        try {
          observedVersion = (await readClient.getPage(existing.confluence_id!)).version.number;
        } catch {
          // The durable intent remains pending for exact reconciliation.
        }
        throwConfluenceModified(fastify, observedVersion, existing.version);
      }
      throw err;
    }
  })();
  const confPage = await confirmPagePublication(
    updateClient,
    remotePublication.receipt,
    remotePublication.confPage,
  );
  const result = await completePageWriteIntent(intent, (dbClient) =>
    publishCollabCommit(dbClient, publication, {
      id: confPage.id,
      title: confPage.title,
      bodyStorage: confPage.body.storage.value,
      remoteVersion: confPage.version.number,
    }, intent.id, assigned.html));
  // The published body carries the markers of the images this commit
  // uploaded; the room must carry them too, or its next persist drops them and
  // the next Save uploads every image again. After settlement and before the
  // `pages_version` control, so the flush that control starts keeps them (#1764).
  await runtime.markUploadedImages(pageId, admission, imagePlan.markers);
  // The room also records that its tasks carry ids, when it has not yet: also
  // after a Save in which every task already carried its id (#1751).
  if (taskIdMarkers.length > 0 || (!taskIdsCarried && assigned.taskIds.length > 0)) {
    await runtime.markWrittenTaskIds(pageId, admission, taskIdMarkers);
  }
  runtime.broadcastControl(pageId, { type: 'pages_version', version: result.newVersion });
  logger.info({ pageId, version: result.newVersion, confluence: true }, 'collab.commit');

  const cache = new RedisCache(fastify.redis);
  await cache.invalidateAcrossUsers('pages');
  await logAuditEvent(
    userId,
    'PAGE_UPDATED',
    'page',
    String(pageId),
    { source: 'collab_commit', title: body.title, confluence: true },
    request,
  );
  return CollabCommitResponseSchema.parse({
    id: pageId,
    title: body.title,
    version: result.newVersion,
    source: 'confluence' as const,
    pushedToConfluence: true as const,
  });
}

export function mapWsProtocolToAuthorization(request: FastifyRequest): void {
  if (request.headers.authorization?.startsWith('Bearer ')) return;
  const raw = request.headers['sec-websocket-protocol'];
  if (typeof raw !== 'string' || raw.length === 0) return;
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.includes(COLLAB_WS_PROTOCOL)) return;
  const token = parts.find((p) => p !== COLLAB_WS_PROTOCOL);
  if (token) request.headers.authorization = `Bearer ${token}`;
}

function toUint8(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) {
    return new Uint8Array(data);
  }
  if (Array.isArray(data)) {
    return new Uint8Array(Buffer.concat(data as Buffer[]));
  }
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(0);
}

async function authenticateSocket(
  request: FastifyRequest,
): Promise<{ userId: string; username: string; role: 'user' | 'admin' } | '4401'> {
  mapWsProtocolToAuthorization(request);
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return '4401';
  try {
    const payload = await verifyToken(header.slice(7));
    const security = await getUserSecurityState(payload.sub);
    if (security.kind === 'deactivated' || security.kind === 'missing') return '4401';
    if (security.kind === 'active' && security.role !== payload.role) return '4401';
    return { userId: payload.sub, username: payload.username, role: payload.role };
  } catch {
    return '4401';
  }
}

async function fetchUserMeta(userId: string): Promise<{ name: string; role: string }> {
  const r = await query<{ username: string; display_name: string | null; role: string }>(
    'SELECT username, display_name, role FROM users WHERE id = $1',
    [userId],
  );
  const row = r.rows[0];
  if (!row) return { name: userId, role: '' };
  return {
    name: row.display_name && row.display_name.length > 0 ? row.display_name : row.username,
    role: row.role,
  };
}

function awarenessColor(userId: string): string {
  let h = 0;
  for (let i = 0; i < userId.length; i++) {
    h = Math.imul(h, 31) + userId.charCodeAt(i);
  }
  return `hsl(${Math.abs(h) % 360} 50% 40%)`;
}

async function rateLimitUpgrade(userId: string): Promise<boolean> {
  const redis = getRedisClient();
  if (!redis) return true;
  try {
    const key = `collab:upgrade:${userId}`;
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, COLLAB_UPGRADE_WINDOW_SEC);
    return n <= UPGRADE_LIMIT_PER_MIN;
  } catch {
    return true;
  }
}

function decodeCommitDocumentState(value: string): Y.Snapshot {
  try {
    const bytes = Buffer.from(value, 'base64');
    const snapshot = Y.decodeSnapshot(bytes);
    if (!bytes.equals(Y.encodeSnapshot(snapshot))) throw new Error('Non-canonical snapshot');
    return snapshot;
  } catch {
    throw new PageWriteError(400, 'invalid_collab_snapshot', 'Invalid collaborative document state');
  }
}

function assertCommitSnapshotIncludes(actual: Y.Snapshot, requested: Y.Snapshot): void {
  let clocksPresent = true;
  for (const [client, clock] of requested.sv) {
    if ((actual.sv.get(client) ?? 0) < clock) {
      clocksPresent = false;
      break;
    }
  }
  const deletionsPresent = clocksPresent && Y.equalDeleteSets(
    actual.ds,
    Y.mergeDeleteSets([actual.ds, requested.ds]),
  );
  if (!deletionsPresent) {
    throw new PageWriteError(
      409,
      'collab_snapshot_not_received',
      'Some edits have not reached the server. Keep this draft open and try Save again.',
    );
  }
}

export async function pagesCollabRoutes(fastify: FastifyInstance) {
  fastify.get('/collab/config', {
    onRequest: [fastify.authenticate],
  }, async () => {
    return CollabConfigSchema.parse({ enabled: isCollabEditingEnabled() });
  });

  fastify.post<{ Params: { id: string } }>('/pages/:id/collab/commit', {
    onRequest: [fastify.authenticate],
    bodyLimit: 2 * 1024 * 1024,
  }, async (request) => {
    const parsedId = PagePrimaryKeySchema.safeParse(request.params.id);
    if (!parsedId.success) {
      throw fastify.httpErrors.notFound('Page not found');
    }
    const pageId = parsedId.data;
    const body = CollabCommitSchema.parse(request.body);
    const requestedDocumentState = decodeCommitDocumentState(body.expectedDocumentState);
    const userId = request.userId;

    const writable = await userCanEditPage(userId, pageId);
    if (!writable) {
      throw fastify.httpErrors.forbidden('Not authorized to edit this page');
    }

    const page = await query<{
      id: number;
      version: number;
      source: string;
      visibility: string;
      deleted_at: Date | null;
      page_type: string | null;
      confluence_id: string | null;
      space_key: string | null;
      lifecycle_revision: string;
      baseline_id: string | null;
      body_storage: string | null;
    }>(
      `SELECT id, version, source, visibility, deleted_at, page_type,
              confluence_id, space_key,
              lifecycle_revision::text, baseline_id, body_storage
         FROM pages
        WHERE id = $1`,
      [pageId],
    );
    if (page.rows.length === 0 || page.rows[0]!.deleted_at) {
      throw fastify.httpErrors.notFound('Page not found');
    }
    const existing = page.rows[0]!;
    if (existing.baseline_id !== null) {
      throw new PageWriteError(423, 'page_is_frozen', 'Frozen pages cannot be changed');
    }
    if ((existing.page_type ?? 'page') === 'folder') {
      throw fastify.httpErrors.badRequest('Folder pages cannot have body content');
    }
    if (existing.source !== 'standalone' && existing.source !== 'confluence') {
      throw fastify.httpErrors.unprocessableEntity('Unsupported page source');
    }
    if (body.expectedLifecycleRevision !== existing.lifecycle_revision) {
      throw new PageWriteError(
        409,
        'stale_lifecycle',
        'The page lifecycle changed after the collaborative editing session began',
      );
    }

    const runtime = getDefaultCollabRuntime();
    let admission: PageRuntimeAdmission | null = null;
    try {
      if (!runtime) {
        throw new PageWriteError(
          409,
          'collab_writable_join_required',
          'A fresh writable collaborative join is required before saving',
        );
      }
      const snapshot = await runtime.prepareCommitSnapshot(
        pageId,
        userId,
        body.expectedLifecycleRevision,
      );
      admission = snapshot.admission;
      assertCommitSnapshotIncludes(snapshot.documentState, requestedDocumentState);
      const html = snapshot.html;
      const bodyText = htmlToText(html);

      // #1623 — ONE rule: a synced page whose owner switched the integration off
      // takes exactly the path a standalone page takes below. Nothing goes
      // upstream, and no credential prompt is reachable from here.
      if (!(await pageWriteStaysLocal(userId, existing.source))) {
        return await commitConfluencePage({
          fastify,
          request,
          pageId,
          userId,
          existing,
          body,
          html,
          taskItems: snapshot.taskItems,
          taskIdsCarried: snapshot.taskIdsCarried,
          runtime,
          admission,
        });
      }

      const newVersion = await withPageWriteTransaction([pageId], async (client) => {
        await assertCurrentCollabMutationAuthority(client, existing, userId);
        const locked = await client.query<{ version: number }>(
          'SELECT version FROM pages WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
          [pageId],
        );
        if (locked.rows.length === 0) throw fastify.httpErrors.notFound('Page not found');
        const expected = locked.rows[0]!.version;
        const updated = await client.query<{ version: number }>(
          `UPDATE pages SET
             title = $2, body_html = $3, body_text = $4,
             version = version + 1,
             last_modified_at = NOW(),
             local_modified_at = NOW(),
             local_modified_by = $5,
             embedding_dirty = TRUE,
             image_analysis_dirty = CASE
               WHEN body_html IS DISTINCT FROM $3 THEN TRUE
               ELSE image_analysis_dirty
             END,
             embedding_status = 'not_embedded', embedded_at = NULL,
             summary_status = 'pending', summary_retry_count = 0,
             quality_status = 'pending', quality_retry_count = 0
           WHERE id = $1 AND version = $6
           RETURNING version`,
          [pageId, body.title, html, bodyText, userId, expected],
        );
        if (updated.rowCount !== 1) {
          throw fastify.httpErrors.conflict(
            'Page has been modified since you loaded it. Please refresh and try again.',
          );
        }
        return updated.rows[0]!.version;
      }, { admission });

      runtime.broadcastControl(pageId, { type: 'pages_version', version: newVersion });
      logger.info(
        { pageId, version: newVersion, confluence: false, source: existing.source },
        'collab.commit',
      );

      const cache = new RedisCache(fastify.redis);
      // A Confluence-sourced page is visible to every user with space access
      // (#893) even when this user's integration is off, so its local write
      // clears every cache the remote path would have cleared.
      if (existing.visibility === 'shared' || existing.source === 'confluence') {
        await cache.invalidateAcrossUsers('pages');
      } else {
        await cache.invalidate(userId, 'pages');
      }
      await logAuditEvent(
        userId,
        'PAGE_UPDATED',
        'page',
        String(pageId),
        // `confluence: false` on a Confluence-sourced page is the audit trail's
        // record that the edit stayed local (#1623).
        { source: 'collab_commit', title: body.title, ...(existing.source === 'confluence' ? { confluence: false } : {}) },
        request,
      );

      return CollabCommitResponseSchema.parse({
        id: pageId,
        title: body.title,
        version: newVersion,
        source: existing.source as 'standalone' | 'confluence',
        ...(existing.source === 'confluence' ? { pushedToConfluence: false as const } : {}),
      });
    } finally {
      if (admission) {
        try {
          await releasePageRuntime(admission);
        } catch (error) {
          deferPageRequestAdmissionRelease(admission);
          logger.warn({ err: error, pageId, admissionId: admission.id }, 'collab: request cleanup deferred; durable admission retained');
        }
      }
    }
  });

  fastify.get<{ Params: { pageId: string } }>('/collab/:pageId', {
    websocket: true,
    // @fastify/compress must not wrap the upgrade.
    compress: false,
    config: { rateLimit: false },
  } as never, (socket, request) => {
    mapWsProtocolToAuthorization(request);

    const pending: Uint8Array[] = [];
    let pendingBytes = 0;
    let live = false;
    let closed = false;
    let pageId: number | null = null;
    let connId: string | null = null;
    const runtime = getDefaultCollabRuntime();
    let frameChain = Promise.resolve();

    const pingTimer = setInterval(() => {
      if (socket.readyState === 1) {
        try { socket.ping(); } catch { /* */ }
        if (pageId !== null) void refreshCollabActiveTtl(pageId);
      }
    }, COLLAB_PING_INTERVAL_MS);
    if (typeof pingTimer.unref === 'function') pingTimer.unref();

    let securityTimer: ReturnType<typeof setInterval> | null = null;

    const finish = (code: number, reason: string): void => {
      if (closed) return;
      closed = true;
      pending.length = 0;
      clearInterval(pingTimer);
      clearInterval(securityTimer ?? undefined);
      try { socket.close(code, reason); } catch { /* */ }
    };

    socket.on('message', (data) => {
      const buf = toUint8(data);
      if (closed) return;
      if (!live || pageId === null || connId === null || !runtime) {
        // An over-full buffer is a transient backlog, never a refusal: 1013
        // lets y-websocket reconnect instead of reporting a permission loss.
        if (pending.length >= PRELIVE_FRAME_LIMIT || pendingBytes + buf.byteLength > PRELIVE_BYTE_LIMIT) {
          // Debug, not info: this runs before the JWT check and the per-user
          // upgrade limiter, so any client could emit it once per connection.
          logger.debug({ pageId, frames: pending.length, bytes: pendingBytes }, 'collab.prelive_backlog');
          finish(1013, 'join_backlog');
          return;
        }
        pending.push(buf);
        pendingBytes += buf.byteLength;
        return;
      }
      const joinedPageId = pageId;
      const joinedConnId = connId;
      frameChain = frameChain.then(async () => {
        const result = await runtime.handleInboundFrame(joinedPageId, joinedConnId, buf);
        if (result === 'close_4403') finish(4403, 'readonly');
      }).catch((err) => {
        logger.warn({ err, pageId: joinedPageId }, 'collab: inbound frame failed');
        finish(1001, 'internal');
      });
    });

    socket.on('pong', () => {
      if (pageId !== null) void refreshCollabActiveTtl(pageId);
    });

    socket.on('close', () => {
      closed = true;
      clearInterval(pingTimer);
      clearInterval(securityTimer ?? undefined);
      if (pageId !== null && connId !== null && runtime) {
        void runtime.detachSocket(pageId, connId).catch((err) => {
          logger.warn({ err, pageId }, 'collab: detach failed; durable admission retained');
        });
      }
    });

    void (async () => {
      const parsedId = PagePrimaryKeySchema.safeParse(request.params.pageId);
      if (!parsedId.success) {
        finish(4404, 'not_found');
        return;
      }
      pageId = parsedId.data;

      const auth = await authenticateSocket(request);
      if (auth === '4401') {
        finish(4401, 'unauthorized');
        return;
      }

      if (!isCollabEditingEnabled()) {
        finish(4403, 'flag_off');
        return;
      }

      const page = await query<{ page_type: string | null; deleted_at: Date | null }>(
        `SELECT page_type, deleted_at FROM pages WHERE id = $1`,
        [pageId],
      );
      if (page.rows.length === 0) {
        finish(4404, 'not_found');
        return;
      }
      // Authorize before revealing lifecycle state: a page the caller may not
      // access closes exactly like a missing one, so `trashed`/`folder` never
      // confirm that an unreadable page exists. The trash-inclusive check
      // keeps the specific reasons for users who could access the page.
      if (!(await userCanAccessPage(auth.userId, pageId, undefined, true))) {
        finish(4404, 'not_found');
        return;
      }
      const row = page.rows[0]!;
      if (row.deleted_at) {
        finish(4404, 'trashed');
        return;
      }
      if ((row.page_type ?? 'page') === 'folder') {
        finish(4404, 'folder');
        return;
      }

      if (!(await rateLimitUpgrade(auth.userId))) {
        finish(4403, 'rate_limited');
        return;
      }

      if (!runtime) {
        finish(1001, 'no_runtime');
        return;
      }

      const rawExpectedLifecycleRevision = (
        request.query as { expectedLifecycleRevision?: unknown }
      ).expectedLifecycleRevision;
      const expectedLifecycleRevision = typeof rawExpectedLifecycleRevision === 'string'
        && /^\d+$/.test(rawExpectedLifecycleRevision)
        ? rawExpectedLifecycleRevision
        : null;
      const requestedWritable = await userCanEditPage(auth.userId, pageId);
      const meta = await fetchUserMeta(auth.userId);
      connId = randomUUID();
      const attached = await runtime.attachSocket(pageId, {
        id: connId,
        ws: socket,
        userId: auth.userId,
        writable: requestedWritable,
        expectedLifecycleRevision,
        identity: {
          id: auth.userId,
          name: meta.name,
          color: awarenessColor(auth.userId),
        },
      });
      logger.debug(
        {
          pageId,
          userId: auth.userId,
          writable: attached.writable,
          connId,
          name: meta.name,
          color: awarenessColor(auth.userId),
          writableRefusalReason: attached.writableRefusalReason,
        },
        'collab.identity',
      );

      if (closed) {
        await runtime.detachSocket(pageId, connId);
        return;
      }
      const securityPageId = pageId;
      const securityConnId = connId;
      securityTimer = setInterval(() => {
        void (async () => {
          const security = await getUserSecurityState(auth.userId);
          if (security.kind === 'deactivated' || security.kind === 'missing') {
            finish(4401, 'unauthorized');
            return;
          }
          if (security.kind === 'active' && security.role !== auth.role) {
            finish(4401, 'unauthorized');
            return;
          }
          if (!(await userCanAccessPage(auth.userId, securityPageId))) {
            finish(4403, 'forbidden');
            return;
          }
          if (!(await userCanEditPage(auth.userId, securityPageId))) {
            await runtime.demoteSocket(securityPageId, securityConnId);
          }
        })().catch((err) => logger.warn(
          { err, pageId: securityPageId },
          'collab: permission refresh failed',
        ));
      }, 60_000);
      if (typeof securityTimer.unref === 'function') securityTimer.unref();
      live = true;
      const queuedFrames = pending.splice(0);
      for (const buf of queuedFrames) {
        frameChain = frameChain.then(async () => {
          const result = await runtime.handleInboundFrame(securityPageId, securityConnId, buf);
          if (result === 'close_4403') finish(4403, 'readonly');
        });
      }
      await frameChain;
    })().catch((err) => {
      logger.warn({ err }, 'collab: join failed');
      finish(1001, 'internal');
    });
  });
}
