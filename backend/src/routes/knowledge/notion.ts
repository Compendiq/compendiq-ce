import type { FastifyInstance } from 'fastify';
import {
  ConnectNotionSchema,
  NotionConnectionResponseSchema,
  NotionTreeResponseSchema,
} from '@compendiq/contracts';
import { logAuditEvent } from '../../core/services/audit-service.js';
import { NotionClient, NotionError } from '../../domains/knowledge/services/notion-client.js';
import { fetchNotionWorkspaceTree } from '../../domains/knowledge/services/notion-tree.js';
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
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.get('/notion/connection', async (request) => {
    return toResponse(await getNotionConnectionStatus(request.userId));
  });

  fastify.put('/notion/connection', async (request, reply) => {
    const { token } = ConnectNotionSchema.parse(request.body);
    try {
      const status = await connectNotionToken(request.userId, token);
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
    try {
      const client = new NotionClient(token);
      const nodes = await fetchNotionWorkspaceTree(client);
      return NotionTreeResponseSchema.parse({ nodes });
    } catch (err) {
      if (err instanceof NotionError && err.statusCode >= 400 && err.statusCode < 500) {
        const body = { error: 'ClientError', message: err.message, statusCode: err.statusCode };
        expectNoSecret(body, token);
        return reply.status(err.statusCode).send(body);
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
