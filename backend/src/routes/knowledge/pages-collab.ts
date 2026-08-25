/**
 * Collab gateway (#1444): GET /api/collab/config and GET /api/collab/:pageId
 * (WebSocket). Completes the 101, then 4401/4403/4404 before SyncStep1.
 * Do not throw `authenticate` in onRequest — browsers cannot see HTTP 401.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { COLLAB_WS_PROTOCOL, CollabConfigSchema } from '@compendiq/contracts';
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
} from '../../core/services/collab-room-service.js';

const UPGRADE_LIMIT_PER_MIN = 20;

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
