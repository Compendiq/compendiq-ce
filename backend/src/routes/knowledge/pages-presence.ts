/**
 * Real-time presence routes (issue #301).
 *
 *   GET    /api/pages/:id/presence              SSE stream of viewer-list events
 *   POST   /api/pages/:id/presence/heartbeat    Body: { isEditing }; refresh ZSET
 *   DELETE /api/pages/:id/presence              Best-effort beforeunload beacon
 *
 * The ACL check (authenticate + page-read access) MUST happen BEFORE
 * `reply.raw.writeHead(200, ...)`. Once the SSE headers are sent we cannot
 * return a 403. Mirrors the SSE pattern at
 * `backend/src/routes/llm/llm-ask.ts:254-321`.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../../core/db/postgres.js';
import { logger } from '../../core/utils/logger.js';
import { userCanAccessPage } from '../../core/services/rbac-service.js';
import {
  recordHeartbeat,
  removeViewer,
  getActiveViewers,
  subscribeToPage,
  type PresenceViewer,
} from '../../core/services/presence-service.js';

const IdParamSchema = z.object({ id: z.string().min(1) });
const HeartbeatBodySchema = z.object({ isEditing: z.boolean() });

/**
 * Resolve a page id from the URL (either numeric PK or confluence_id) to the
 * integer pages.id used by `userCanAccessPage`. Returns null if not found.
 */
async function resolvePageId(id: string): Promise<number | null> {
  const isNumericId = /^\d+$/.test(id);
  const result = await query<{ id: number }>(
    `SELECT id FROM pages
     WHERE ${isNumericId ? 'id = $1' : 'confluence_id = $1'}
       AND deleted_at IS NULL
     LIMIT 1`,
    [isNumericId ? parseInt(id, 10) : id],
  );
  return result.rows[0]?.id ?? null;
}

/**
 * Fetch display name and role for a user — used to stamp the per-user meta
 * HASH in Redis on every heartbeat.
 */
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

export async function pagesPresenceRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // GET /api/pages/:id/presence — SSE viewer-list stream
  fastify.get('/pages/:id/presence', async (request, reply) => {
    const { id } = IdParamSchema.parse(request.params);
    const userId = request.userId;

    // --- ACL BEFORE writeHead ---
    // Resolve page + space-read access first. Any failure here must return a
    // proper JSON response via the normal Fastify error pipeline — we have NOT
    // yet hijacked the reply.
    const pageId = await resolvePageId(id);
    if (pageId === null) {
      throw fastify.httpErrors.notFound('Page not found');
    }
    const allowed = await userCanAccessPage(userId, pageId);
    if (!allowed) {
      throw fastify.httpErrors.forbidden('Access denied');
    }

    // --- SSE stream ---
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const sendEvent = (viewers: PresenceViewer[]): void => {
      const payload = JSON.stringify({
        viewers,
        pageId: id,
        ts: Math.floor(Date.now() / 1000),
      });
      try {
        reply.raw.write(`event: presence\ndata: ${payload}\n\n`);
      } catch (err) {
        logger.debug({ err }, 'presence SSE write failed (client likely disconnected)');
      }
    };

    // Emit the current viewer snapshot immediately so the client doesn't have
    // to wait for the first pub/sub event.
    try {
      const initial = await getActiveViewers(id);
      sendEvent(initial);
    } catch (err) {
      logger.warn({ err, pageId: id }, 'presence: initial snapshot failed');
    }

    const unsubscribe = subscribeToPage(id, sendEvent);

    let closed = false;
    const onClose = (): void => {
      if (closed) return;
      closed = true;
      unsubscribe();
      try {
        reply.raw.end();
      } catch {
        // already torn down
      }
    };

    // Keep the returned promise pending so Fastify doesn't try to finalise
    // the reply — the raw socket is now ours. Resolves on client disconnect.
    // A single `close` listener handles both unsubscribe/cleanup and promise
    // resolution so we don't double-register.
    await new Promise<void>((resolve) => {
      request.raw.on('close', () => {
        onClose();
        resolve();
      });
    });
  });

  // POST /api/pages/:id/presence/heartbeat — refresh ZSET + meta
  //
  // Modest per-user rate limit: nominal cadence is one heartbeat per 10s
  // (~6/min). 30/min gives ~3x headroom for reconnect jitter and page reloads
  // while still capping the ZADD + PUBLISH + fetchUserMeta trio against abuse.
  fastify.post('/pages/:id/presence/heartbeat', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const { id } = IdParamSchema.parse(request.params);
    const { isEditing } = HeartbeatBodySchema.parse(request.body);
    const userId = request.userId;

    const pageId = await resolvePageId(id);
    if (pageId === null) {
      throw fastify.httpErrors.notFound('Page not found');
    }
    const allowed = await userCanAccessPage(userId, pageId);
    if (!allowed) {
      throw fastify.httpErrors.forbidden('Access denied');
    }

    const meta = await fetchUserMeta(userId);
    await recordHeartbeat(id, userId, isEditing, meta);
    return reply.code(204).send();
  });

  // DELETE /api/pages/:id/presence — best-effort beforeunload beacon
  fastify.delete('/pages/:id/presence', async (request, reply) => {
    const { id } = IdParamSchema.parse(request.params);
    const userId = request.userId;

    // Best-effort: even on ACL failure we shouldn't leak whether the page
    // exists, but we still refuse to remove a viewer the caller can't reach.
    const pageId = await resolvePageId(id);
    if (pageId === null) {
      // Treat as no-op — same status as a successful delete so beacons don't
      // clutter the audit log with 404s from deleted pages.
      return reply.code(204).send();
    }
    const allowed = await userCanAccessPage(userId, pageId);
    if (!allowed) {
      throw fastify.httpErrors.forbidden('Access denied');
    }

    await removeViewer(id, userId);
    return reply.code(204).send();
  });
}
