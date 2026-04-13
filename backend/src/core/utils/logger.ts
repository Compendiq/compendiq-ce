import pino from 'pino';
import type { Logger } from 'pino';

export const logger: Logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  ...(process.env.NODE_ENV !== 'production' && {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true },
    },
  }),
});

/**
 * Create a child logger with additional context (e.g., correlation ID).
 * Use this when you need to attach request-scoped metadata to logs
 * outside of Fastify's request lifecycle.
 */
export function createChildLogger(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}
