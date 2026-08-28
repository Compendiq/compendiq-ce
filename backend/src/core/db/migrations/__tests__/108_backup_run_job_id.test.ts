import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../../../test-db-helper.js';
import { query } from '../../postgres.js';

const dbAvailable = await isDbAvailable();
const migrationPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '108_backup_run_job_id.sql',
);

describe.skipIf(!dbAvailable)('Migration 108 — backup run job correlation (#1420)', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => { await truncateAllTables(); });

  it('persists nullable queue job IDs and creates the lookup index idempotently', async () => {
    const sql = fs.readFileSync(migrationPath, 'utf8');
    await query(sql);
    await query(sql);

    await query(
      `INSERT INTO backup_runs (destination, status, triggered_by, job_id)
       VALUES ('s3', 'running', NULL, NULL),
              ('s3', 'running', 'admin-1', 'backup-job-42')`,
    );

    const runs = await query<{ job_id: string | null }>(
      `SELECT job_id FROM backup_runs ORDER BY job_id NULLS FIRST`,
    );
    expect(runs.rows.map((row) => row.job_id)).toEqual([null, 'backup-job-42']);

    const index = await query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_indexes
          WHERE tablename = 'backup_runs'
            AND indexname = 'backup_runs_job_id_idx'
       ) AS exists`,
    );
    expect(index.rows[0]!.exists).toBe(true);
  });
});
