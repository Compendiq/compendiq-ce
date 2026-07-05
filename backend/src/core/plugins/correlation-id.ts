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

/** Upper bound on an accepted inbound correlation ID (generous; a UUID is 36). */
const MAX_CORRELATION_ID_LENGTH = 256;

/**
 * Resolve the correlation ID for a request: reuse the inbound `x-correlation-id`
 * header when present and within {@link MAX_CORRELATION_ID_LENGTH}, otherwise
 * mint a fresh UUID. Bounding the length stops an oversized client-supplied
 * value from bloating every log line and the reflected response header.
 */
function resolveCorrelationId(raw: string | string[] | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value && value.length > 0 && value.length <= MAX_CORRELATION_ID_LENGTH) {
    return value;
  }
  return randomUUID();
}

export default fp(async (fastify: FastifyInstance) => {
  fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    // Reuse a sane inbound ID, otherwise generate a new UUID.
    const correlationId = resolveCorrelationId(request.headers['x-correlation-id']);

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
