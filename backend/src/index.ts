// OpenTelemetry must be initialized before any other imports
// so auto-instrumentation can monkey-patch modules.
import { initTelemetry, shutdownTelemetry } from './telemetry.js';

import { buildApp } from './app.js';
import { runMigrations, closePool } from './core/db/postgres.js';
import { startSyncWorker, stopSyncWorker } from './domains/confluence/services/sync-service.js';
import { startQualityWorker, stopQualityWorker, triggerQualityBatch } from './domains/knowledge/services/quality-worker.js';
import { startSummaryWorker, stopSummaryWorker, triggerSummaryBatch } from './domains/knowledge/services/summary-worker.js';
import { markStartupComplete } from './routes/foundation/health.js';
import { logger } from './core/utils/logger.js';

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

  // Build and start the app
  const app = await buildApp();

  await app.listen({ port: PORT, host: HOST });
  logger.info({ port: PORT, host: HOST }, 'Server started');

  // Mark startup as complete for health checks
  markStartupComplete();

  // Start background sync worker
  const syncInterval = parseInt(process.env.SYNC_INTERVAL_MIN ?? '15', 10);
  startSyncWorker(syncInterval);

  // Start background quality analysis worker
  startQualityWorker();

  // Start background summary worker
  const summaryInterval = parseInt(process.env.SUMMARY_CHECK_INTERVAL_MINUTES ?? '60', 10);
  startSummaryWorker(summaryInterval);

  // Run initial worker batches after 30s delay to let server stabilize.
  // Uses lock-guarded trigger functions to prevent concurrent execution
  // if a worker interval fires at the same time.
  setTimeout(async () => {
    await triggerQualityBatch();
    await triggerSummaryBatch();
  }, 30_000);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down...');
    stopQualityWorker();
    stopSyncWorker();
    stopSummaryWorker();
<<<<<<< HEAD
    const { closeBrowser } = await import('./core/services/pdf-service.js');
    await closeBrowser();
=======
    try {
      const pdfModulePath = './core/services/pdf-service.js';
      const pdfService = await import(pdfModulePath);
      if (pdfService?.closeBrowser) await pdfService.closeBrowser();
    } catch {
      // pdf-service not available, skip browser cleanup
    }
>>>>>>> 46f8d99 (fix: restore missing worktree files + fix cached_pages references (#353))
    await app.close();
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
