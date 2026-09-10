import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
} from '../../../../test-db-helper.js';
import { query } from '../../postgres.js';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('Migration 106 — deletion reconciliation cursor (#1439)', () => {
  beforeAll(async () => setupTestDb());
  afterAll(async () => teardownTestDb());

  it('adds a zero-based per-space reconciliation cursor', async () => {
    const { rows } = await query<{
      data_type: string;
      column_default: string;
      is_nullable: string;
    }>(
      `SELECT data_type, column_default, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'spaces'
          AND column_name = 'deletion_reconcile_cursor'`,
    );

    expect(rows).toEqual([{
      data_type: 'integer',
      column_default: '0',
      is_nullable: 'NO',
    }]);
  });
});
