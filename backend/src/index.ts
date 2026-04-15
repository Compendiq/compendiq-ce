// OpenTelemetry must be initialized before any other imports
// so auto-instrumentation can monkey-patch modules.
import { initTelemetry, shutdownTelemetry } from './telemetry.js';

import { buildApp } from './app.js';
import { runMigrations, closePool, closeVectorPool, query } from './core/db/postgres.js';
import { addAllowedBaseUrl } from './core/utils/ssrf-guard.js';
import { startQueueWorkers, stopQueueWorkers } from './core/services/queue-service.js';
import { markStartupComplete } from './routes/foundation/health.js';
import { logger } from './core/utils/logger.js';
import { getSharedLlmSettings } from './core/services/admin-settings-service.js';
import { setActiveProvider } from './domains/llm/services/ollama-service.js';
import { initLlmQueue } from './domains/llm/services/llm-queue.js';
import { initRateLimiter } from './domains/confluence/services/confluence-rate-limiter.js';
import { initEmailService, closeEmailService } from './core/services/email-service.js';

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
    if (patKey.length < 32 || patKey.startsWith('change-me')) {
      throw new Error('PAT_ENCRYPTION_KEY must be at least 32 chars and not default in production');
    }
  }

  // Run database migrations
  logger.info('Running database migrations...');
  await runMigrations();
  logger.info('Migrations complete');

  // Pre-register all user-configured Confluence URLs so the SSRF guard
  // allows requests to on-premises instances on private networks (#480).
  try {
    const urlRows = await query<{ confluence_url: string }>(
      'SELECT DISTINCT confluence_url FROM user_settings WHERE confluence_url IS NOT NULL',
      [],
    );
    for (const row of urlRows.rows) {
      addAllowedBaseUrl(row.confluence_url);
    }
    if (urlRows.rows.length > 0) {
      logger.info({ count: urlRows.rows.length }, 'Registered Confluence URLs in SSRF allowlist');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to pre-register Confluence URLs in SSRF allowlist');
  }

  const sharedLlmSettings = await getSharedLlmSettings();
  setActiveProvider(sharedLlmSettings.llmProvider);
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

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down...');
    await stopQueueWorkers();
    closeEmailService();
    await app.close();
    await closeVectorPool();
    await closePool();
    await shutdownTelemetry();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((err) => {
  logger.fatal({ err }, 'Failed to start server');
  process.exit(1);
});
