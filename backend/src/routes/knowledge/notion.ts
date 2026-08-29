import type { FastifyInstance } from 'fastify';
import {
  ConnectNotionSchema,
  NotionConnectionResponseSchema,
  NotionImportRequestSchema,
  NotionImportResponseSchema,
  NotionTreeResponseSchema,
} from '@compendiq/contracts';
import { logAuditEvent } from '../../core/services/audit-service.js';
import { RedisCache } from '../../core/services/redis-cache.js';
import { NotionClient, NotionError } from '../../domains/knowledge/services/notion-client.js';
import { fetchNotionWorkspaceTree } from '../../domains/knowledge/services/notion-tree.js';
import {
  NotionImportError,
  runNotionImport,
} from '../../domains/knowledge/services/notion-import-service.js';
import {
  connectNotionToken,
  disconnectNotionToken,
  getDecryptedNotionToken,
  getNotionConnectionStatus,
} from '../../domains/knowledge/services/notion-token-service.js';

function toResponse(status: { hasToken: boolean }) {
  return NotionConnectionResponseSchema.parse(status);
}

export async function notionRoutes(fastify: FastifyInstance) {
  const cache = new RedisCache(fastify.redis);
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.get('/notion/connection', async (request) => {
    return toResponse(await getNotionConnectionStatus(request.userId));
  });

  fastify.put('/notion/connection', async (request, reply) => {
    const { token } = ConnectNotionSchema.parse(request.body);
    try {
      const status = await connectNotionToken(request.userId, token);
      await cache.invalidate(request.userId, 'notion_tree');
      await logAuditEvent(
        request.userId,
        'NOTION_TOKEN_UPDATED',
        'settings',
        request.userId,
        { connected: status.hasToken },
        request,
      );
      return toResponse(status);
    } catch (err) {
      if (err instanceof NotionError && err.statusCode >= 400 && err.statusCode < 500) {
        const body = { error: 'ClientError', message: err.message, statusCode: err.statusCode };
        expectNoSecret(body, token);
        return reply.status(err.statusCode).send(body);
      }
      throw err;
    }
  });

  fastify.delete('/notion/connection', async (request) => {
    const status = await disconnectNotionToken(request.userId);
    await cache.invalidate(request.userId, 'notion_tree');
    await logAuditEvent(request.userId, 'NOTION_TOKEN_UPDATED', 'settings', request.userId, { connected: false }, request);
    return toResponse(status);
  });

  fastify.get('/notion/tree', async (request, reply) => {
    const token = await getDecryptedNotionToken(request.userId);
    if (!token) {
      return reply.status(400).send({
        error: 'ClientError',
        message: 'Notion is not connected',
        statusCode: 400,
      });
    }
    const cached = await cache.get<{ nodes: unknown[] }>(request.userId, 'notion_tree', 'workspace');
    if (cached) {
      return NotionTreeResponseSchema.parse(cached);
    }
    try {
      const client = new NotionClient(token);
      const nodes = await fetchNotionWorkspaceTree(client, { userId: request.userId });
      const response = NotionTreeResponseSchema.parse({ nodes });
      await cache.set(request.userId, 'notion_tree', 'workspace', response, 120);
      return response;
    } catch (err) {
      if (err instanceof NotionError && err.statusCode >= 400) {
        const status =
          err.statusCode === 503 || err.statusCode === 529
            ? 503
            : err.statusCode >= 500
              ? 502
              : err.statusCode;
        const body = { error: 'ClientError', message: err.message, statusCode: status };
        expectNoSecret(body, token);
        return reply.status(status).send(body);
      }
      throw err;
    }
  });

  fastify.post('/notion/import', async (request, reply) => {
    const body = NotionImportRequestSchema.parse(request.body);
    const token = await getDecryptedNotionToken(request.userId);
    if (!token) {
      return reply.status(400).send({
        error: 'ClientError',
        message: 'Notion is not connected',
        statusCode: 400,
      });
    }
    try {
      const client = new NotionClient(token);
      const items = await runNotionImport({
        userId: request.userId,
        client,
        pageIds: body.pageIds,
        spaceKey: body.spaceKey,
        parentId: body.parentId,
        visibility: body.visibility,
        overwriteExisting: body.overwriteExisting,
        databaseModes: body.databaseModes,
      });
      const created = items.filter((i) => i.status === 'success');
      if (created.length > 0) {
        if (body.visibility === 'shared') {
          await cache.invalidateAcrossUsers('pages');
        } else {
          await cache.invalidate(request.userId, 'pages');
        }
      }
      for (const item of created) {
        await logAuditEvent(
          request.userId,
          item.updated ? 'PAGE_UPDATED' : 'PAGE_CREATED',
          'page',
          String(item.localPageId),
          { source: 'standalone', notionPageId: item.notionPageId },
          request,
        );
      }
      await cache.invalidate(request.userId, 'notion_tree');
      return NotionImportResponseSchema.parse({ items });
    } catch (err) {
      if (err instanceof NotionImportError) {
        const bodyOut = { error: 'ClientError', message: err.message, statusCode: err.statusCode };
        expectNoSecret(bodyOut, token);
        return reply.status(err.statusCode).send(bodyOut);
      }
      if (err instanceof NotionError && err.statusCode >= 400) {
        const status =
          err.statusCode === 503 || err.statusCode === 529
            ? 503
            : err.statusCode >= 500
              ? 502
              : err.statusCode;
        const bodyOut = { error: 'ClientError', message: err.message, statusCode: status };
        expectNoSecret(bodyOut, token);
        return reply.status(status).send(bodyOut);
      }
      throw err;
    }
  });
}

/** Defense in depth: a 4xx body must never include the pasted secret. */
function expectNoSecret(body: unknown, token: string): void {
  const serialized = JSON.stringify(body);
  if (token && serialized.includes(token)) {
    throw new Error('Refusing to send a response that contains the Notion token');
  }
}
