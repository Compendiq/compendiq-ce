import fp from 'fastify-plugin';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import { logger as rootLogger } from '../utils/logger.js';
import type { Logger } from 'pino';

declare module 'fastify' {
  interface FastifyRequest {
    correlationId: string;
  }
}

/**
 * AsyncLocalStorage to propagate correlation ID across async boundaries
 * (e.g., sync workers, embedding pipeline) without manual parameter threading.
 */
export const correlationStorage = new AsyncLocalStorage<string>();

/**
 * Get the current correlation ID from AsyncLocalStorage, or undefined if none is set.
 */
export function getCorrelationId(): string | undefined {
  return correlationStorage.getStore();
}

/**
 * Create a child logger with the given correlation ID attached.
 */
export function createCorrelationLogger(correlationId: string): Logger {
  return rootLogger.child({ correlationId });
}

export default fp(async (fastify: FastifyInstance) => {
  fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    // Read from header or generate a new UUID
    const correlationId =
      (request.headers['x-correlation-id'] as string) || randomUUID();

    request.correlationId = correlationId;

    // Create a child logger with the correlation ID
    request.log = rootLogger.child({ correlationId });

    // Add to response header
    reply.header('X-Correlation-ID', correlationId);
  });

  // Wrap request handling in AsyncLocalStorage so downstream async code can access the ID
  fastify.addHook('preHandler', async (request: FastifyRequest) => {
    // Store runs synchronously here but the context persists for the handler
    correlationStorage.enterWith(request.correlationId);
  });
}, {
  name: 'correlation-id',
  fastify: '5.x',
});
