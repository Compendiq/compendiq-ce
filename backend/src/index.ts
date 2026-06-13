// OpenTelemetry must be initialized before any other imports
// so auto-instrumentation can monkey-patch modules.
import { initTelemetry, shutdownTelemetry } from './telemetry.js';

import { buildApp } from './app.js';
import { runMigrations, closePool, closeVectorPool } from './core/db/postgres.js';
import { startQueueWorkers, stopQueueWorkers } from './core/services/queue-service.js';
import { markStartupComplete } from './routes/foundation/health.js';
import { logger } from './core/utils/logger.js';
import {
  createShutdownHandler,
  resolveShutdownTimeoutMs,
} from './core/utils/graceful-shutdown.js';
import { initLlmQueue } from './domains/llm/services/llm-queue.js';
import { initRateLimiter } from './domains/confluence/services/confluence-rate-limiter.js';
import { initEmailService, closeEmailService } from './core/services/email-service.js';
import { isValidEncryptionKey } from './core/utils/crypto.js';

const PORT = parseInt(process.env.BACKEND_PORT ?? '3051', 10);
const HOST = process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1';

async function start() {
  // Initialize OpenTelemetry (no-op if OTEL_ENABLED is not 'true')
  await initTelemetry();

  // Validate required secrets in production
  if (process.env.NODE_ENV === 'production') {
    const jwtSecret = process.env.JWT_SECRET ?? '';
    const patKey = process.env.PAT_ENCRYPTION_KEY ?? '';
    if (jwtSecret.length < 32 || jwtSecret.startsWith('change-me')) {
      throw new Error('JWT_SECRET must be at least 32 chars and not default in production');
    }
    // issue #738 — validate UTF-8 BYTE length (matches what the crypto module
    // accepts), not UTF-16 char length. Identical to the old check for ASCII
    // keys, but no longer lets a multi-byte key pass boot only to fail later.
    if (!isValidEncryptionKey(patKey) || patKey.startsWith('change-me')) {
      throw new Error('PAT_ENCRYPTION_KEY must be at least 32 bytes (UTF-8) and not default in production');
    }
  }

  // Run database migrations
  logger.info('Running database migrations...');
  await runMigrations();
  logger.info('Migrations complete');

  // SSRF allowlist bootstrap is now wired inside `buildApp()` alongside the
  // Redis pub/sub subscriber (issue #306) so every pod, in every process,
  // populates its local allowlist in the same place.

  // Legacy single-provider setup (`LLM_PROVIDER`) removed — providers are
  // now registered in `llm_providers` and selected per use-case.
  await initLlmQueue();
  await initRateLimiter();
  await initEmailService();

  // Build and start the app
  const app = await buildApp();

  await app.listen({ port: PORT, host: HOST });
  logger.info({ port: PORT, host: HOST }, 'Server started');

  // Mark startup as complete for health checks
  markStartupComplete();

  // Start background workers (BullMQ or legacy setInterval, controlled by USE_BULLMQ)
  await startQueueWorkers();

  // Graceful shutdown (issue #745): re-entrancy-guarded, each step isolated
  // so one failure (e.g. Redis already gone inside app.close()) cannot skip
  // the remaining cleanup, with a hard deadline (default 50s, tunable via
  // SHUTDOWN_TIMEOUT_MS — keep below the container stop grace period, see
  // ADR-024) before forcing exit.
  const shutdown = createShutdownHandler({
    timeoutMs: resolveShutdownTimeoutMs(),
    steps: [
      { name: 'queue-workers', run: () => stopQueueWorkers() },
      { name: 'email-service', run: () => closeEmailService() },
      { name: 'http-server', run: () => app.close() },
      { name: 'vector-pool', run: () => closeVectorPool() },
      { name: 'pg-pool', run: () => closePool() },
      { name: 'telemetry', run: () => shutdownTelemetry() },
    ],
  });

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
}

start().catch((err) => {
  logger.fatal({ err }, 'Failed to start server');
  process.exit(1);
});
