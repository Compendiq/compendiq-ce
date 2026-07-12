import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../../test-db-helper.js';
import { query } from '../../postgres.js';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('Migration 082 — pages ((id::text)) expression index (#927)', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => { await truncateAllTables(); });

  // The /pages/tree and /spaces homepage joins match the parent row via
  //   parent_page.confluence_id = child.parent_id
  //   OR CAST(parent_page.id AS TEXT) = child.parent_id
  // The second (CAST) arm is unindexable without an expression index, forcing
  // a full inner-table scan per outer row. This index makes that arm indexable.
  it('creates the pages_id_text_idx expression index on (id::text)', async () => {
    const idx = await query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'pages' AND indexname = 'pages_id_text_idx'`,
    );
    expect(idx.rows).toHaveLength(1);
    expect(idx.rows[0]!.indexdef).toContain('(id)::text');
  });
});
