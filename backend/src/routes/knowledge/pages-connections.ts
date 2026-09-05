import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ConnectionEventSchema } from '@compendiq/contracts';
import { recordConnectionEvent } from '../../core/services/audit-service.js';
import { authorizedPageIds } from '../../core/services/authorized-pages.js';
import { getPageConnections } from '../../domains/knowledge/services/page-connections-service.js';

const PageIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
}).strict();

export async function pagesConnectionRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.get('/pages/:id/connections', async (request, reply) => {
    const { id } = PageIdParamSchema.parse(request.params);
    const connections = await getPageConnections(request.userId, id);
    if (!connections) return reply.notFound('Page not found');
    return connections;
  });

  fastify.post('/pages/:id/connections/events', async (request, reply) => {
    const { id } = PageIdParamSchema.parse(request.params);
    const event = ConnectionEventSchema.parse(request.body);

    const sourceAccess = await authorizedPageIds(request.userId, [id]);
    if (!sourceAccess.has(id)) return reply.notFound('Page not found');

    if (event.event === 'connection_click') {
      const targetId = Number(event.targetPageId);
      const targetAccess = await authorizedPageIds(request.userId, [targetId]);
      if (!targetAccess.has(targetId)) return reply.notFound('Target page not found');
    }

    await recordConnectionEvent(request.userId, id, event, request);
    return { recorded: true as const };
  });
}
