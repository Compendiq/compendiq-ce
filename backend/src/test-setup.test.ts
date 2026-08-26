import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MAX_TEST_WORKERS, workerIdFromEnv } from './test-worker-isolation.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('test-setup short-circuits production wall-clock timings', () => {
  const setup = readFileSync(join(here, 'test-setup.ts'), 'utf8');

  it('sets collab grace/TTL/ping and the LLM health probe under Vitest', () => {
    expect(setup).toMatch(/COLLAB_ACTIVE_TTL_SEC \?\?= '4'/);
    expect(setup).toMatch(/COLLAB_PING_INTERVAL_MS \?\?= '100'/);
    expect(setup).toMatch(/COLLAB_EMPTY_ROOM_GRACE_MS \?\?= '200'/);
    expect(setup).toMatch(/COLLAB_COMMIT_DUMP_TIMEOUT_MS \?\?= '200'/);
    expect(setup).toMatch(/LLM_HEALTH_TIMEOUT_MS \?\?= '50'/);
  });

  it('applies per-worker Postgres/Redis isolation before any suite loads', () => {
    expect(setup).toMatch(/applyWorkerIsolation\(\)/);
    expect(setup).toMatch(/ensureWorkerDatabase/);
  });

  it('this worker has a pool slot so it is not sharing kb_creator_test', () => {
    expect(workerIdFromEnv()).toBeGreaterThan(0);
    expect(process.env.POSTGRES_URL).toMatch(/kb_creator_test_w\d+/);
  });
});

describe('truncateAllTables retries deadlocks', () => {
  it('retries 40P01 / 55P03 rather than failing the next test', () => {
    const src = readFileSync(join(here, 'test-db-helper.ts'), 'utf8');
    expect(src).toMatch(/DEADLOCK = '40P01'/);
    expect(src).toMatch(/LOCK_NOT_AVAILABLE = '55P03'/);
    expect(src).toMatch(/attempt < 5/);
  });
});

describe('vitest.config file parallelism', () => {
  const cfg = readFileSync(join(here, '..', 'vitest.config.ts'), 'utf8');

  it('runs files in parallel, capped at MAX_TEST_WORKERS', () => {
    expect(cfg).toMatch(/fileParallelism:\s*true/);
    expect(cfg).toMatch(/maxWorkers:\s*MAX_TEST_WORKERS/);
    expect(MAX_TEST_WORKERS).toBe(8);
  });
});

describe('production timings are Vitest-overridable', () => {
  it('collab constants go through vitestIntOr so test-setup can shorten them', () => {
    const src = readFileSync(join(here, 'core/services/collab-room-service.ts'), 'utf8');
    expect(src).toMatch(/COLLAB_ACTIVE_TTL_SEC = vitestIntOr\('COLLAB_ACTIVE_TTL_SEC', 45\)/);
    expect(src).toMatch(/COLLAB_PING_INTERVAL_MS = vitestIntOr\('COLLAB_PING_INTERVAL_MS', 15_000\)/);
    expect(src).toMatch(/COLLAB_EMPTY_ROOM_GRACE_MS = vitestIntOr\('COLLAB_EMPTY_ROOM_GRACE_MS', 10_000\)/);
    expect(src).toMatch(/COLLAB_COMMIT_DUMP_TIMEOUT_MS = vitestIntOr\('COLLAB_COMMIT_DUMP_TIMEOUT_MS', 2_000\)/);
  });

  it('LLM health probes use vitestIntOr rather than a literal 5000', () => {
    const health = readFileSync(join(here, 'routes/foundation/health.ts'), 'utf8');
    const setup = readFileSync(join(here, 'routes/foundation/setup.ts'), 'utf8');
    expect(health).toMatch(/LLM_HEALTH_TIMEOUT_MS = vitestIntOr\('LLM_HEALTH_TIMEOUT_MS', 5_000\)/);
    expect(health).not.toMatch(/5000/);
    expect(setup).toMatch(/LLM_HEALTH_TIMEOUT_MS/);
    expect(setup).not.toMatch(/5000/);
  });
});
