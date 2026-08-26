import { afterAll, beforeAll } from 'vitest';
import { closePool } from './core/db/postgres.js';
import { setupTestDb } from './test-db-helper.js';
import {
  applyWorkerIsolation,
  ensureWorkerDatabase,
  workerIdFromEnv,
} from './test-worker-isolation.js';

// Set test environment variables
process.env.JWT_SECRET = 'test-jwt-secret-that-is-at-least-32-characters-long';
process.env.PAT_ENCRYPTION_KEY = 'test-pat-encryption-key-at-least-32-chars';
process.env.OLLAMA_BASE_URL = 'http://localhost:11434';

// Production collab/health timings are wall-clock. Override them under
// Vitest so files that wait on grace/TTL/probes don't sleep 10–45s each.
process.env.COLLAB_ACTIVE_TTL_SEC ??= '4';
process.env.COLLAB_PING_INTERVAL_MS ??= '100';
process.env.COLLAB_EMPTY_ROOM_GRACE_MS ??= '200';
process.env.COLLAB_COMMIT_DUMP_TIMEOUT_MS ??= '200';
process.env.LLM_HEALTH_TIMEOUT_MS ??= '50';

process.env.POSTGRES_URL =
  process.env.POSTGRES_TEST_URL ??
  'postgresql://kb_user:changeme-postgres@localhost:5433/kb_creator_test';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://:changeme-redis@localhost:6379';

applyWorkerIsolation();

const workerId = workerIdFromEnv();

async function bootWorkerDb(): Promise<void> {
  if (workerId <= 0) return;
  try {
    await ensureWorkerDatabase(process.env.POSTGRES_URL!);
    // Files that never call setupTestDb still query Postgres (collab
    // persistence, etc.). Sequential mode hid that because an earlier
    // file had already migrated the shared database. Re-running this
    // before every file also restores probe-time image-index DDL, which
    // truncateAllTables cannot undo.
    await setupTestDb();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // No Postgres in this environment — DB suites skip via isDbAvailable.
    if (!/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(msg)) {
      throw err;
    }
  }
}

await bootWorkerDb();

beforeAll(async () => {
  await bootWorkerDb();
});

afterAll(async () => {
  await closePool();
});
