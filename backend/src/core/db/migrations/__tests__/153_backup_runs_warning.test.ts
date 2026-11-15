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
  '153_backup_runs_warning.sql',
);

describe.skipIf(!dbAvailable)('Migration 153 — backup run prune warning (#1710)', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => { await truncateAllTables(); });

  it('adds a nullable text warning column idempotently and leaves existing rows NULL', async () => {
    const sql = fs.readFileSync(migrationPath, 'utf8');
    await query(sql);
    await query(sql);

    await query(
      `INSERT INTO backup_runs (destination, status) VALUES ('s3', 'success')`,
    );
    await query(
      `INSERT INTO backup_runs (destination, status, warning) VALUES ('s3', 'success', 'DeleteObjects failed (403)')`,
    );

    const column = await query<{ data_type: string; is_nullable: string; column_default: string | null }>(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'backup_runs' AND column_name = 'warning'`,
    );
    expect(column.rows).toEqual([{ data_type: 'text', is_nullable: 'YES', column_default: null }]);

    const rows = await query<{ warning: string | null }>(
      `SELECT warning FROM backup_runs ORDER BY warning NULLS FIRST`,
    );
    expect(rows.rows.map((row) => row.warning)).toEqual([null, 'DeleteObjects failed (403)']);
  });
});
