/**
 * SSE progress stream for long-running bulk page operations
 * (Compendiq/compendiq-ee#117).
 *
 *   GET /api/pages/bulk/:jobId/progress
 *
 * Pairs with the bulk-action POST routes in pages-crud.ts (replace-tags,
 * tag, sync, embed, delete) and the EE-overlay bulk/permission route. The
 * client opens the SSE first, then issues the POST with the same `jobId`.
 * Events are pushed via Redis (see `bulk-page-progress.ts`); when the client
 * disconnects, the route fires `cancelBulkJob(jobId)` so the in-flight POST
 * can bail at the next chunk boundary.
 *
 * Auth: `fastify.authenticate` is applied via `addHook('onRequest')` — the
 * bulk routes already require auth, so the SSE observer must as well. Cross-
 * user observation of someone else's job is intentionally left open at the
 * route layer (jobIds are unguessable UUIDs); we do NOT scope by `userId`
 * because future async features (e.g. an admin watching a long sync) need
 * cross-user visibility. The unguessability of the jobId is the access
 * control.
 *
 * SSE pattern follows `routes/knowledge/pages-presence.ts:85-138` and
 * `routes/llm/_helpers.ts:151-220`. Specifically:
 *   - `reply.hijack()` BEFORE writing headers
 *   - `request.raw.on('close')` registers an AbortController abort
 *   - the route returns a never-resolving Promise so Fastify doesn't
 *     finalise the reply early; the abort listener resolves on disconnect
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { logger } from '../../core/utils/logger.js';
import {
  streamBulkProgress,
  cancelBulkJob,
  type BulkProgressEvent,
} from '../../core/services/bulk-page-progress.js';

const JobIdParamSchema = z.object({ jobId: z.string().uuid() });

export async function pagesBulkProgressRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.get('/pages/bulk/:jobId/progress', async (request, reply) => {
    const { jobId } = JobIdParamSchema.parse(request.params);

    // --- SSE stream ---
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      // Suppress NGINX / cloud-LB buffering so chunked progress reaches the
      // browser in real time. Critical for the cancel-button UX.
      'X-Accel-Buffering': 'no',
    });

    const controller = new AbortController();
    let closed = false;
    const onClose = (): void => {
      if (closed) return;
      closed = true;
      controller.abort();
      // Fire-and-forget: surface cancellation to the in-flight POST. We do
      // NOT await this — the SSE socket is already gone.
      cancelBulkJob(jobId).catch((err) => {
        logger.debug({ err, jobId }, 'pages-bulk-progress: cancel-on-disconnect failed');
      });
    };
    request.raw.on('close', onClose);

    const writeEvent = (ev: BulkProgressEvent): void => {
      try {
        // Use the SSE `event:` field for keepalive ticks so the client can
        // ignore them in its progress UI without parsing the JSON.
        const eventName = ev.note === 'keepalive' ? 'keepalive' : 'progress';
        reply.raw.write(`event: ${eventName}\ndata: ${JSON.stringify(ev)}\n\n`);
      } catch (err) {
        logger.debug({ err, jobId }, 'pages-bulk-progress: SSE write failed (client disconnected)');
        controller.abort();
      }
    };

    try {
      for await (const ev of streamBulkProgress(jobId, controller.signal)) {
        writeEvent(ev);
        if (ev.done || ev.cancelled) break;
      }
    } catch (err) {
      logger.error({ err, jobId }, 'pages-bulk-progress: stream error');
      try {
        reply.raw.write(`event: error\ndata: ${JSON.stringify({ message: 'stream error' })}\n\n`);
      } catch {
        // socket gone
      }
    } finally {
      try {
        reply.raw.end();
      } catch {
        // already torn down
      }
    }

    // Promise resolves on client disconnect via the registered close handler.
    if (!closed) {
      await new Promise<void>((resolve) => {
        request.raw.on('close', () => {
          onClose();
          resolve();
        });
      });
    }
  });
}
