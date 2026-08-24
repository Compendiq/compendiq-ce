/**
 * Collab gateway (#1444/#1445/#1448): GET /api/collab/config, GET /api/collab/:pageId
 * (WebSocket), POST /api/pages/:id/collab/commit (standalone + Confluence).
 * Completes the 101, then 4401/4403/4404 before SyncStep1. Do not throw
 * `authenticate` in onRequest on the WS route — browsers cannot see HTTP 401.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import {
  COLLAB_WS_PROTOCOL,
  CollabCommitResponseSchema,
  CollabCommitSchema,
  CollabConfigSchema,
  type CollabCommit,
} from '@compendiq/contracts';
import { getPool, query } from '../../core/db/postgres.js';
import { logger } from '../../core/utils/logger.js';
import { verifyToken } from '../../core/plugins/auth.js';
import { getUserSecurityState } from '../../core/services/user-security-cache.js';
import { userCanAccessPage, userCanEditPage } from '../../core/services/rbac-service.js';
import { isCollabEditingEnabled } from '../../core/services/collab-flag.js';
import { getRedisClient } from '../../core/services/redis-cache.js';
import {
  COLLAB_COMMIT_DUMP_TIMEOUT_MS,
  COLLAB_PING_INTERVAL_MS,
  getDefaultCollabRuntime,
  refreshCollabActiveTtl,
  type CollabRuntime,
} from '../../core/services/collab-room-service.js';
import { htmlFromPersistedDoc, snapshotRoomHtml } from '../../core/services/collab-persistence.js';
import { htmlToConfluence, htmlToText } from '../../core/services/content-converter.js';
import { RedisCache } from '../../core/services/redis-cache.js';
import { logAuditEvent } from '../../core/services/audit-service.js';
import { getClientForUser } from '../../domains/confluence/services/sync-service.js';
import { ConfluenceError } from '../../domains/confluence/services/confluence-client.js';
import { uploadLocalImagesToConfluence } from '../../domains/confluence/services/pasted-image-uploader.js';

const UPGRADE_LIMIT_PER_MIN = 20;

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
};

async function commitConfluencePage(args: {
  fastify: FastifyInstance;
  request: FastifyRequest;
  pageId: number;
  userId: string;
  existing: CollabCommitPage;
  body: CollabCommit;
  html: string;
  bodyText: string;
  runtime: CollabRuntime | null | undefined;
}) {
  const { fastify, request, pageId, userId, existing, body, html, bodyText, runtime } = args;
  if (!existing.confluence_id) {
    throw fastify.httpErrors.badRequest('Confluence page is missing a remote id');
  }
  const client = await getClientForUser(userId);
  if (!client) {
    throw fastify.httpErrors.badRequest('Confluence not configured');
  }

  const remote = await client.getPage(existing.confluence_id);
  const remoteVersion = remote.version.number;
  if (remoteVersion !== existing.version) {
    throwConfluenceModified(fastify, remoteVersion, existing.version);
  }

  const uploadedBodyHtml = await uploadLocalImagesToConfluence(
    html, existing.confluence_id, client, request.log,
  );
  const storageBody = htmlToConfluence(uploadedBodyHtml);

  let confPage: { version: { number: number }; body?: { storage?: { value: string } } };
  try {
    confPage = await client.updatePage(
      existing.confluence_id,
      body.title,
      storageBody,
      existing.version,
    );
  } catch (err) {
    if (err instanceof ConfluenceError && err.statusCode === 409) {
      throwConfluenceModified(fastify, existing.version + 1, existing.version);
    }
    throw err;
  }
  const newVersion = confPage.version.number;
  const bodyStorage = confPage.body?.storage?.value ?? storageBody;

  const poolClient = await getPool().connect();
  try {
    await poolClient.query('BEGIN');
    const locked = await poolClient.query<{ version: number }>(
      'SELECT version FROM pages WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
      [pageId],
    );
    if (locked.rows.length === 0) {
      await poolClient.query('ROLLBACK');
      throw fastify.httpErrors.notFound('Page not found');
    }
    await poolClient.query(
      `UPDATE pages SET
         title = $2, body_html = $3, body_text = $4, body_storage = $5,
         version = $6, last_synced = NOW(), last_modified_at = NOW(),
         local_modified_at = NULL, local_modified_by = NULL,
         embedding_dirty = TRUE,
         image_embedding_dirty = CASE
           WHEN body_html IS DISTINCT FROM $3 THEN TRUE
           ELSE image_embedding_dirty
         END,
         embedding_status = 'not_embedded', embedded_at = NULL,
         summary_status = 'pending', summary_retry_count = 0,
         quality_status = 'pending', quality_retry_count = 0
       WHERE id = $1`,
      [pageId, body.title, html, bodyText, bodyStorage, newVersion],
    );
    await poolClient.query('COMMIT');
  } catch (err) {
    try { await poolClient.query('ROLLBACK'); } catch { /* */ }
    throw err;
  } finally {
    poolClient.release();
  }

  runtime?.broadcastControl(pageId, { type: 'pages_version', version: newVersion });
  logger.info({ pageId, version: newVersion, confluence: true }, 'collab.commit');

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
    version: newVersion,
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
    if (n === 1) await redis.expire(key, 60);
    return n <= UPGRADE_LIMIT_PER_MIN;
  } catch {
    return true;
  }
}

export async function pagesCollabRoutes(fastify: FastifyInstance) {
  fastify.get('/collab/config', {
    onRequest: [fastify.authenticate],
  }, async () => {
    return CollabConfigSchema.parse({ enabled: isCollabEditingEnabled() });
  });

  fastify.post('/pages/:id/collab/commit', {
    onRequest: [fastify.authenticate],
  }, async (request) => {
    const rawId = (request.params as { id: string }).id;
    const pageId = Number(rawId);
    if (!Number.isInteger(pageId) || pageId <= 0) {
      throw fastify.httpErrors.notFound('Page not found');
    }
    const body = CollabCommitSchema.parse(request.body);
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
    }>(
      `SELECT id, version, source, visibility, deleted_at, page_type, confluence_id, space_key FROM pages WHERE id = $1`,
      [pageId],
    );
    if (page.rows.length === 0 || page.rows[0]!.deleted_at) {
      throw fastify.httpErrors.notFound('Page not found');
    }
    const existing = page.rows[0]!;
    if ((existing.page_type ?? 'page') === 'folder') {
      throw fastify.httpErrors.badRequest('Folder pages cannot have body content');
    }
    if (existing.source !== 'standalone' && existing.source !== 'confluence') {
      throw fastify.httpErrors.unprocessableEntity('Unsupported page source');
    }

    const runtime = getDefaultCollabRuntime();
    const local = runtime?.getRoom(pageId);
    let html: string | null = null;
    if (local) {
      html = snapshotRoomHtml(local.doc);
    } else {
      let live = 0;
      try {
        const redis = getRedisClient();
        if (redis) live = Number(await redis.sCard(`collab:active:${pageId}`));
      } catch {
        // unread SET: fall through to BYTEA
      }
      if (live > 0) {
        if (!runtime) {
          throw fastify.httpErrors.serviceUnavailable('Collaborative state is not available on this pod');
        }
        const created = await runtime.getOrCreateRoom(pageId);
        const dumped = await runtime.waitForPeerStateDump(pageId, COLLAB_COMMIT_DUMP_TIMEOUT_MS);
        if (!dumped) {
          if (created.sockets.size === 0) {
            // Dump never arrived — do not snapshot the BYTEA-loaded heap onto body_html.
            created.persistable = false;
            await runtime.dropRoom(pageId);
          }
          throw fastify.httpErrors.serviceUnavailable('Collaborative state is not available on this pod');
        }
        html = snapshotRoomHtml(created.doc);
        if (created.sockets.size === 0) await runtime.dropRoom(pageId);
      } else {
        html = await htmlFromPersistedDoc(pageId);
      }
    }
    if (html === null) {
      throw fastify.httpErrors.conflict('No collaborative session for this page');
    }
    const bodyText = htmlToText(html);

    if (existing.source === 'confluence') {
      return commitConfluencePage({
        fastify,
        request,
        pageId,
        userId,
        existing,
        body,
        html,
        bodyText,
        runtime,
      });
    }

    const client = await getPool().connect();
    let newVersion = existing.version;
    try {
      await client.query('BEGIN');
      const locked = await client.query<{ version: number }>(
        'SELECT version FROM pages WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
        [pageId],
      );
      if (locked.rows.length === 0) {
        await client.query('ROLLBACK');
        throw fastify.httpErrors.notFound('Page not found');
      }
      let expected = locked.rows[0]!.version;
      const write = async (expectedVersion: number) => client.query(
        `UPDATE pages SET
           title = $2, body_html = $3, body_text = $4,
           version = version + 1,
           last_modified_at = NOW(),
           local_modified_at = NOW(),
           local_modified_by = $5,
           embedding_dirty = TRUE,
           image_embedding_dirty = CASE
             WHEN body_html IS DISTINCT FROM $3 THEN TRUE
             ELSE image_embedding_dirty
           END,
           embedding_status = 'not_embedded', embedded_at = NULL,
           summary_status = 'pending', summary_retry_count = 0,
           quality_status = 'pending', quality_retry_count = 0
         WHERE id = $1 AND version = $6
         RETURNING version`,
        [pageId, body.title, html, bodyText, userId, expectedVersion],
      );
      let updated = await write(expected);
      if ((updated.rowCount ?? 0) === 0) {
        const again = await client.query<{ version: number }>(
          'SELECT version FROM pages WHERE id = $1 FOR UPDATE',
          [pageId],
        );
        expected = again.rows[0]!.version;
        updated = await write(expected);
      }
      if ((updated.rowCount ?? 0) === 0) {
        await client.query('ROLLBACK');
        throw fastify.httpErrors.conflict('Page has been modified since you loaded it. Please refresh and try again.');
      }
      newVersion = updated.rows[0]!.version as number;
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* */ }
      throw err;
    } finally {
      client.release();
    }

    runtime?.broadcastControl(pageId, { type: 'pages_version', version: newVersion });
    logger.info({ pageId, version: newVersion, confluence: false }, 'collab.commit');

    const cache = new RedisCache(fastify.redis);
    if (existing.visibility === 'shared') {
      await cache.invalidateAcrossUsers('pages');
    } else {
      await cache.invalidate(userId, 'pages');
    }
    await logAuditEvent(userId, 'PAGE_UPDATED', 'page', String(pageId), { source: 'collab_commit', title: body.title }, request);

    return CollabCommitResponseSchema.parse({
      id: pageId,
      title: body.title,
      version: newVersion,
      source: 'standalone' as const,
    });
  });

  fastify.get('/collab/:pageId', {
    websocket: true,
    // @fastify/compress must not wrap the upgrade.
    compress: false,
    config: { rateLimit: false },
  } as never, (socket, request) => {
    mapWsProtocolToAuthorization(request);

    const pending: Uint8Array[] = [];
    let live = false;
    let closed = false;
    let pageId: number | null = null;
    let connId: string | null = null;
    const runtime = getDefaultCollabRuntime();

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
      clearInterval(pingTimer);
      if (securityTimer) clearInterval(securityTimer);
      try { socket.close(code, reason); } catch { /* */ }
    };

    socket.on('message', (data) => {
      const buf = toUint8(data);
      if (closed) return;
      if (!live || pageId === null || connId === null || !runtime) {
        pending.push(buf);
        return;
      }
      const result = runtime.handleInboundFrame(pageId, connId, buf);
      if (result === 'close_4403') finish(4403, 'readonly');
    });

    socket.on('pong', () => {
      if (pageId !== null) void refreshCollabActiveTtl(pageId);
    });

    socket.on('close', () => {
      closed = true;
      clearInterval(pingTimer);
      if (securityTimer) clearInterval(securityTimer);
      if (pageId !== null && connId !== null && runtime) {
        void runtime.detachSocket(pageId, connId);
      }
    });

    void (async () => {
      const raw = (request.params as { pageId: string }).pageId;
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        finish(4404, 'not_found');
        return;
      }
      pageId = parsed;

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
      const row = page.rows[0]!;
      if (row.deleted_at) {
        finish(4404, 'trashed');
        return;
      }
      if ((row.page_type ?? 'page') === 'folder') {
        finish(4404, 'folder');
        return;
      }

      const allowed = await userCanAccessPage(auth.userId, pageId);
      if (!allowed) {
        finish(4403, 'forbidden');
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

      const writable = await userCanEditPage(auth.userId, pageId);
      const meta = await fetchUserMeta(auth.userId);
      connId = randomUUID();
      await runtime.attachSocket(pageId, {
        id: connId,
        ws: socket,
        userId: auth.userId,
        writable,
        identity: {
          id: auth.userId,
          name: meta.name,
          color: awarenessColor(auth.userId),
        },
      });
      logger.debug(
        { pageId, userId: auth.userId, writable, connId, name: meta.name, color: awarenessColor(auth.userId) },
        'collab.identity',
      );

      if (closed) {
        await runtime.detachSocket(pageId, connId);
        return;
      }
      securityTimer = setInterval(() => {
        void (async () => {
          const security = await getUserSecurityState(auth.userId);
          if (security.kind === 'deactivated' || security.kind === 'missing') {
            finish(4401, 'unauthorized');
            return;
          }
          if (security.kind === 'active' && security.role !== auth.role) {
            finish(4401, 'unauthorized');
          }
        })();
      }, 60_000);
      if (typeof securityTimer.unref === 'function') securityTimer.unref();
      live = true;
      for (const buf of pending) {
        const result = runtime.handleInboundFrame(pageId, connId, buf);
        if (result === 'close_4403') {
          finish(4403, 'readonly');
          return;
        }
      }
      pending.length = 0;
    })().catch((err) => {
      logger.warn({ err }, 'collab: join failed');
      finish(1001, 'internal');
    });
  });
}
