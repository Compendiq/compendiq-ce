import { Queue } from 'bullmq';
import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { query } from '../db/postgres.js';
import { getRedisConnectionOpts } from '../utils/redis-connection.js';
import { setRedisClient } from './redis-cache.js';
import { startQueueWorkers, stopQueueWorkers } from './queue-service.js';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';

// Stub processor for the `backup` scheduler: the real one needs S3 and a
// Postgres dump. Only inference-free bookkeeping is kept: count runs, and
// fail on demand.
const stub = vi.hoisted(() => ({ runs: 0, failing: false }));
vi.mock('./backup-worker.js', () => ({
  processBackupJob: async () => {
    stub.runs += 1;
    if (stub.failing) throw new Error('stub scheduler failure');
    return 'stub ok';
  },
  runForcedBackup: async () => 'stub forced',
}));

const available = await isDbAvailable() && await isRedisAvailable();
const names = ['sync', 'quality', 'summary', 'image-analysis', 'maintenance', 'reembed-all', 'shadow-reembed', 'backup', 'body-text-backfill'];
const queues: Queue[] = [];
const redis = createClient({ url: process.env.REDIS_URL });
const SCHEDULER_EVERY_MS = 10;
// Each poll stays well below TEST_TIMEOUT_MS; the vitest default (30 s) is too tight for ~200 runs.
const WAIT = { timeout: 60_000, interval: 50 };
const TEST_TIMEOUT_MS = 120_000;

// Real BullMQ, Redis, PostgreSQL and workers; the repeat interval of the
// backup scheduler is shortened and its processor stubbed. The scheduler
// job template (including its removal options) is passed through untouched.
describe.skipIf(!available)('scheduler job record retention (#1756)', () => {
  let backup: Queue;
  const originalUpsert = Queue.prototype.upsertJobScheduler;

  // Let the REAL scheduler (registered by startQueueWorkers with its real
  // template) run until the stub has been called more than `totalRuns` times,
  // then freeze the queue and wait on counts until nothing is in flight.
  async function runUntil(totalRuns: number): Promise<void> {
    stub.runs = 0;
    await backup.resume();
    await expect.poll(() => stub.runs, WAIT).toBeGreaterThan(totalRuns);
    await backup.pause();
    await expect.poll(async () => (await backup.getJobCounts('active')).active, WAIT).toBe(0);
  }

  beforeAll(async () => {
    await setupTestDb();
    await truncateAllTables();
    await redis.connect();
    setRedisClient(redis);
    for (const name of names) {
      const queue = new Queue(name, { connection: getRedisConnectionOpts() });
      queues.push(queue);
      await queue.obliterate({ force: true });
      // Keep every other scheduler asleep in this worker-isolated Redis DB.
      await queue.pause();
    }
    backup = queues.find((queue) => queue.name === 'backup')!;
    // Shorten only the backup repeat interval; the template is forwarded as-is.
    vi.spyOn(Queue.prototype, 'upsertJobScheduler').mockImplementation(function (this: Queue, id, repeat, template) {
      const shortened = id === 'backup-scheduler' ? { ...repeat, every: SCHEDULER_EVERY_MS } : repeat;
      return originalUpsert.call(this, id, shortened, template);
    });
    await startQueueWorkers();
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await backup.removeJobScheduler('backup-scheduler');
    await stopQueueWorkers();
    for (const queue of queues) {
      await queue.obliterate({ force: true });
      await queue.close();
    }
    await redis.quit();
    await teardownTestDb();
  });

  it('keeps at most 100 completed scheduler records while job_history has one row per run', async () => {
    stub.failing = false;
    await runUntil(105);
    const runs = stub.runs;
    expect(runs).toBeGreaterThan(100);

    expect(await backup.getCompletedCount()).toBeLessThanOrEqual(100);
    expect(await backup.getFailedCount()).toBe(0);
    const rows = await query<{ n: string }>(
      "SELECT count(*)::text AS n FROM job_history WHERE queue_name = 'backup' AND status = 'completed'",
    );
    expect(Number(rows.rows[0]!.n)).toBe(runs);
  }, TEST_TIMEOUT_MS);

  it('keeps at most 200 failed scheduler records while job_history has one row per run', async () => {
    stub.failing = true;
    await runUntil(205);
    const runs = stub.runs;
    expect(runs).toBeGreaterThan(200);
    expect(await backup.getCompletedCount()).toBeLessThanOrEqual(100);

    expect(await backup.getFailedCount()).toBeLessThanOrEqual(200);
    const rows = await query<{ n: string }>(
      "SELECT count(*)::text AS n FROM job_history WHERE queue_name = 'backup' AND status = 'failed'",
    );
    expect(Number(rows.rows[0]!.n)).toBe(runs);
  }, TEST_TIMEOUT_MS);
});
