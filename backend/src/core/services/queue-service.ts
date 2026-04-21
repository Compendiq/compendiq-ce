/**
 * BullMQ queue service — replaces setInterval-based background workers.
 *
 * Manages queue creation, worker registration, job scheduling, and graceful shutdown.
 * Feature-flagged via USE_BULLMQ env var (default: true). When disabled, falls back
 * to the legacy setInterval workers.
 *
 * Uses ioredis (BullMQ's native client) which coexists with the existing node-redis client.
 */

import { Queue, Worker, type Job, type ConnectionOptions } from 'bullmq';
import { query } from '../db/postgres.js';
import { logger } from '../utils/logger.js';

// ─── Feature flag ────────────────────────────────────────────────────────────

const USE_BULLMQ = process.env.USE_BULLMQ !== 'false';

export function isBullMQEnabled(): boolean {
  return USE_BULLMQ;
}

// ─── Connection ──────────────────────────────────────────────────────────────

function getRedisConnectionOpts(): ConnectionOptions {
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {
      host: 'localhost',
      port: 6379,
      maxRetriesPerRequest: null,
    };
  }

  return {
    host: parsed.hostname,
    port: parseInt(parsed.port || '6379', 10),
    password: parsed.password || undefined,
    maxRetriesPerRequest: null, // Required by BullMQ
  };
}

// ─── Queue / Worker registry ─────────────────────────────────────────────────

const queues = new Map<string, Queue>();
const workers = new Map<string, Worker>();

/** Get or create a named queue. */
function getOrCreateQueue(name: string): Queue {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, { connection: getRedisConnectionOpts() });
    queues.set(name, q);
  }
  return q;
}

// ─── Job history ─────────────────────────────────────────────────────────────

async function recordJobHistory(
  queueName: string,
  jobId: string,
  jobName: string | undefined,
  status: 'completed' | 'failed',
  durationMs: number | undefined,
  errorMessage?: string,
  resultSummary?: string,
): Promise<void> {
  try {
    await query(
      `INSERT INTO job_history (queue_name, job_id, job_name, status, duration_ms, error_message, result_summary)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [queueName, jobId, jobName ?? null, status, durationMs ?? null, errorMessage ?? null, resultSummary ?? null],
    );
  } catch (err) {
    logger.error({ err, queueName, jobId }, 'Failed to record job history');
  }
}

// ─── Worker definitions ──────────────────────────────────────────────────────

interface WorkerDef {
  queueName: string;
  concurrency: number;
  /** Repeat pattern (cron or interval in ms) */
  repeatPattern?: { every: number };
  /** The processor function */
  processor: (job: Job) => Promise<string | void>;
}

const workerDefs: WorkerDef[] = [];

function registerWorkerDef(def: WorkerDef): void {
  workerDefs.push(def);
}

// ─── Start / Stop ────────────────────────────────────────────────────────────

/**
 * Initialize all BullMQ queues and workers.
 * Registers repeatable jobs and starts processing.
 */
export async function startQueueWorkers(): Promise<void> {
  if (!USE_BULLMQ) {
    logger.info('BullMQ disabled (USE_BULLMQ=false), using setInterval workers');
    return startLegacyWorkers();
  }

  logger.info('Starting BullMQ queue workers...');

  // Register all worker definitions
  await registerAllWorkers();

  // Create workers for each definition
  for (const def of workerDefs) {
    const q = getOrCreateQueue(def.queueName);

    // Create the worker
    const worker = new Worker(
      def.queueName,
      async (job: Job) => {
        const startTime = Date.now();
        try {
          const result = await def.processor(job);
          const durationMs = Date.now() - startTime;
          await recordJobHistory(
            def.queueName,
            job.id ?? 'unknown',
            job.name,
            'completed',
            durationMs,
            undefined,
            typeof result === 'string' ? result.slice(0, 500) : undefined,
          );
          return result;
        } catch (err) {
          const durationMs = Date.now() - startTime;
          const message = err instanceof Error ? err.message : 'Unknown error';
          await recordJobHistory(
            def.queueName,
            job.id ?? 'unknown',
            job.name,
            'failed',
            durationMs,
            message.slice(0, 1000),
          );
          throw err;
        }
      },
      {
        connection: getRedisConnectionOpts(),
        concurrency: def.concurrency,
      },
    );

    worker.on('error', (err) => {
      logger.error({ err, queue: def.queueName }, 'BullMQ worker error');
    });

    workers.set(def.queueName, worker);

    // Schedule repeatable job if pattern is defined
    if (def.repeatPattern) {
      await q.upsertJobScheduler(
        `${def.queueName}-scheduler`,
        { every: def.repeatPattern.every },
        { name: def.queueName },
      );
      logger.info(
        { queue: def.queueName, everyMs: def.repeatPattern.every },
        'Scheduled repeatable job',
      );
    }
  }

  // Register analytics-aggregation queue for future EE use
  getOrCreateQueue('analytics-aggregation');

  logger.info({ queues: workerDefs.map((d) => d.queueName) }, 'BullMQ workers started');
}

/**
 * Gracefully stop all BullMQ workers and close queues.
 * Waits for in-flight jobs to complete.
 */
export async function stopQueueWorkers(): Promise<void> {
  if (!USE_BULLMQ) {
    return stopLegacyWorkers();
  }

  logger.info('Stopping BullMQ workers...');

  // Close workers first (waits for in-flight jobs)
  const workerClosePromises = [...workers.values()].map((w) =>
    w.close().catch((err) => logger.error({ err }, 'Error closing BullMQ worker')),
  );
  await Promise.all(workerClosePromises);
  workers.clear();

  // Close queues
  const queueClosePromises = [...queues.values()].map((q) =>
    q.close().catch((err) => logger.error({ err }, 'Error closing BullMQ queue')),
  );
  await Promise.all(queueClosePromises);
  queues.clear();

  logger.info('BullMQ workers stopped');
}

/**
 * Enqueue a one-off job onto a named queue. Returns the resolved job id.
 *
 * Idempotency model (issue #257):
 *   - When `opts.jobId` is passed and a previous job with that id is in a
 *     *terminal* state (`completed` / `failed`), we explicitly `.remove()` it
 *     before calling `queue.add()`. BullMQ's auto-removal is lazy — it only
 *     runs when the NEXT job finishes — so without this sweep the second
 *     enqueue would silently dedupe against the stale record.
 *   - When the previous job is still `waiting` / `active` / `delayed` we do
 *     NOT remove it — the duplicate `add()` is ignored by BullMQ (emitting a
 *     `duplicated` event) and the second caller observes the same jobId.
 *     That's the "collapse concurrent POSTs" semantic.
 *
 * When BullMQ is disabled (`USE_BULLMQ=false`) this runs the queue's
 * registered processor inline synchronously (legacy fallback behaviour).
 */
export async function enqueueJob(
  queueName: string,
  data: Record<string, unknown>,
  opts?: { jobId?: string; removeOnComplete?: number; removeOnFail?: number },
): Promise<string> {
  if (!USE_BULLMQ) {
    const fakeId = opts?.jobId ?? `${queueName}-${Date.now()}`;
    const def = workerDefs.find((d) => d.queueName === queueName);
    if (def) {
      // Fire-and-forget inline execution. We don't await so the caller
      // observes the same "enqueue returns before processing finishes"
      // contract as the BullMQ path.
      void def.processor({
        id: fakeId,
        name: queueName,
        data,
        updateProgress: async () => {},
        remove: async () => {},
      } as unknown as Job);
    }
    return fakeId;
  }

  const q = getOrCreateQueue(queueName);

  // Explicitly sweep terminal stale jobs — see jsdoc above.
  if (opts?.jobId) {
    const existing = await q.getJob(opts.jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === 'completed' || state === 'failed') {
        await existing.remove().catch(() => {
          /* race-tolerant: another process may have removed it first */
        });
      }
    }
  }

  const addOpts: Record<string, unknown> = {};
  if (opts?.jobId) addOpts.jobId = opts.jobId;
  if (opts?.removeOnComplete !== undefined) {
    addOpts.removeOnComplete = { count: opts.removeOnComplete };
  }
  if (opts?.removeOnFail !== undefined) {
    addOpts.removeOnFail = { count: opts.removeOnFail };
  }

  const job = await q.add(queueName, data, addOpts);
  return job.id ?? opts?.jobId ?? `${queueName}-${Date.now()}`;
}

/**
 * Fetch a job's current status + progress. Returns null when the job is not
 * found (includes unknown queue / unknown id). Returns null when BullMQ is
 * disabled (legacy fallback has no observable job state).
 */
export async function getJobStatus(
  queueName: string,
  jobId: string,
): Promise<
  | {
      state: string;
      progress: number | object;
      returnvalue: unknown;
      failedReason?: string;
    }
  | null
> {
  if (!USE_BULLMQ) return null;
  const q = queues.get(queueName) ?? getOrCreateQueue(queueName);
  const job = await q.getJob(jobId);
  if (!job) return null;
  return {
    state: await job.getState(),
    progress: (job.progress ?? 0) as number | object,
    returnvalue: job.returnvalue,
    failedReason: job.failedReason,
  };
}

/**
 * Get metrics for all queues (for health endpoint).
 */
export async function getQueueMetrics(): Promise<
  Record<string, { waiting: number; active: number; completed: number; failed: number }>
> {
  const metrics: Record<string, { waiting: number; active: number; completed: number; failed: number }> = {};

  for (const [name, q] of queues) {
    try {
      const [waiting, active, completed, failed] = await Promise.all([
        q.getWaitingCount(),
        q.getActiveCount(),
        q.getCompletedCount(),
        q.getFailedCount(),
      ]);
      metrics[name] = { waiting, active, completed, failed };
    } catch {
      metrics[name] = { waiting: -1, active: -1, completed: -1, failed: -1 };
    }
  }

  return metrics;
}

// ─── Register all workers ────────────────────────────────────────────────────

async function registerAllWorkers(): Promise<void> {
  const syncInterval = parseInt(process.env.SYNC_INTERVAL_MIN ?? '15', 10);
  const qualityInterval = parseInt(process.env.QUALITY_CHECK_INTERVAL_MINUTES ?? '60', 10);
  const summaryInterval = parseInt(process.env.SUMMARY_CHECK_INTERVAL_MINUTES ?? '60', 10);
  const tokenCleanupHours = parseInt(process.env.TOKEN_CLEANUP_INTERVAL_HOURS ?? '24', 10);
  const retentionHours = 24;

  // Sync worker
  registerWorkerDef({
    queueName: 'sync',
    concurrency: 3,
    repeatPattern: { every: syncInterval * 60 * 1000 },
    processor: async () => {
      // eslint-disable-next-line boundaries/dependencies -- orchestrator needs cross-domain access
      const { runScheduledSync } = await import('../../domains/confluence/services/sync-service.js');
      const result = await runScheduledSync();
      return `Synced ${result} users`;
    },
  });

  // Quality scoring
  registerWorkerDef({
    queueName: 'quality',
    concurrency: 2,
    repeatPattern: { every: qualityInterval * 60 * 1000 },
    processor: async () => {
      // eslint-disable-next-line boundaries/dependencies -- orchestrator needs cross-domain access
      const { processBatch } = await import('../../domains/knowledge/services/quality-worker.js');
      const processed = await processBatch();
      return `Processed ${processed} pages`;
    },
  });

  // Summary generation
  registerWorkerDef({
    queueName: 'summary',
    concurrency: 2,
    repeatPattern: { every: summaryInterval * 60 * 1000 },
    processor: async () => {
      // eslint-disable-next-line boundaries/dependencies -- orchestrator needs cross-domain access
      const { runSummaryBatch } = await import('../../domains/knowledge/services/summary-worker.js');
      const result = await runSummaryBatch();
      return `Summarized ${result.processed} pages (${result.errors} errors)`;
    },
  });

  // Maintenance: token cleanup
  registerWorkerDef({
    queueName: 'maintenance',
    concurrency: 1,
    repeatPattern: { every: tokenCleanupHours * 60 * 60 * 1000 },
    processor: async (job: Job) => {
      // Maintenance queue handles multiple job types
      if (job.name === 'token-cleanup' || job.name === 'maintenance') {
        const { cleanupExpiredTokens } = await import('../plugins/auth.js');
        const deleted = await cleanupExpiredTokens();
        return `Cleaned ${deleted} expired tokens`;
      }
      if (job.name === 'data-retention') {
        const { runRetentionCleanup } = await import('./data-retention-service.js');
        const results = await runRetentionCleanup();
        return JSON.stringify(results);
      }
      // Default: run both
      const { cleanupExpiredTokens } = await import('../plugins/auth.js');
      const { runRetentionCleanup } = await import('./data-retention-service.js');
      const deleted = await cleanupExpiredTokens();
      const retentionResults = await runRetentionCleanup();
      return `Tokens: ${deleted}, Retention: ${JSON.stringify(retentionResults)}`;
    },
  });

  // Schedule additional data retention job (daily, on the maintenance queue)
  const maintenanceQueue = getOrCreateQueue('maintenance');
  await maintenanceQueue.upsertJobScheduler(
    'data-retention-scheduler',
    { every: retentionHours * 60 * 60 * 1000 },
    { name: 'data-retention' },
  );

  // Re-embed-all worker (issue #257) — NO repeatPattern: triggered on-demand
  // by `enqueueReembedAll` via `POST /api/admin/embedding/reembed`.
  // Concurrency 1 so a global re-embed is a true exclusive operation.
  registerWorkerDef({
    queueName: 'reembed-all',
    concurrency: 1,
    processor: async (job: Job) => {
      // eslint-disable-next-line boundaries/dependencies -- orchestrator needs cross-domain access
      const { runReembedAllJob } = await import('../../domains/llm/services/embedding-service.js');
      return runReembedAllJob(job);
    },
  });
}

// ─── Legacy setInterval fallback ─────────────────────────────────────────────

async function startLegacyWorkers(): Promise<void> {
  // eslint-disable-next-line boundaries/dependencies -- orchestrator needs cross-domain access
  const { startSyncWorker } = await import('../../domains/confluence/services/sync-service.js');
  // eslint-disable-next-line boundaries/dependencies -- orchestrator needs cross-domain access
  const { startQualityWorker, triggerQualityBatch } = await import('../../domains/knowledge/services/quality-worker.js');
  // eslint-disable-next-line boundaries/dependencies -- orchestrator needs cross-domain access
  const { startSummaryWorker, triggerSummaryBatch } = await import('../../domains/knowledge/services/summary-worker.js');
  const { startTokenCleanupWorker } = await import('./token-cleanup-service.js');
  const { startRetentionWorker } = await import('./data-retention-service.js');

  const syncInterval = parseInt(process.env.SYNC_INTERVAL_MIN ?? '15', 10);
  const summaryInterval = parseInt(
    process.env.SUMMARY_CHECK_INTERVAL_MINUTES ?? '60',
    10,
  );

  startSyncWorker(syncInterval);
  startQualityWorker();
  startSummaryWorker(summaryInterval);
  startTokenCleanupWorker();
  startRetentionWorker();

  // Initial batches after 30s delay
  setTimeout(async () => {
    await triggerQualityBatch();
    await triggerSummaryBatch();
  }, 30_000);
}

async function stopLegacyWorkers(): Promise<void> {
  // eslint-disable-next-line boundaries/dependencies -- orchestrator needs cross-domain access
  const { stopSyncWorker } = await import('../../domains/confluence/services/sync-service.js');
  // eslint-disable-next-line boundaries/dependencies -- orchestrator needs cross-domain access
  const { stopQualityWorker } = await import('../../domains/knowledge/services/quality-worker.js');
  // eslint-disable-next-line boundaries/dependencies -- orchestrator needs cross-domain access
  const { stopSummaryWorker } = await import('../../domains/knowledge/services/summary-worker.js');
  const { stopTokenCleanupWorker } = await import('./token-cleanup-service.js');
  const { stopRetentionWorker } = await import('./data-retention-service.js');

  stopSyncWorker();
  stopQualityWorker();
  stopSummaryWorker();
  stopTokenCleanupWorker();
  stopRetentionWorker();
}
