import pino from 'pino';
import type { Logger } from 'pino';

/** Collab JWTs ride these headers. Never log the raw values. */
export const PINO_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers["sec-websocket-protocol"]',
] as const;

export const logger: Logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: { paths: [...PINO_REDACT_PATHS] },
  ...(process.env.NODE_ENV !== 'production' && {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true },
    },
  }),
});
