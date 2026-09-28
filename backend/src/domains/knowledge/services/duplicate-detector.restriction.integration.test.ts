/**
 * Duplicate detection reads page titles and neighbours for a caller; a
 * restricted page must be neither a candidate nor a usable source for a
 * caller without a page ACE (real PostgreSQL + pgvector).
 */
import pgvector from 'pgvector';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query } from '../../../core/db/postgres.js';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../../test-db-helper.js';
import {
  seedRestrictionFixture,
  type RestrictionFixture,
} from '../../../routes/knowledge/page-restriction.test-helpers.js';
import { findDuplicates, scanAllDuplicates } from './duplicate-detector.js';

const dbAvailable = await isDbAvailable();
const vector = pgvector.toSql(Array.from({ length: 1024 }, (_, i) => Math.cos(i + 1) * 0.01));

describe.skipIf(!dbAvailable)('duplicate detector — page restrictions', () => {
  let fx: RestrictionFixture;

  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => {
    await truncateAllTables();
    await teardownTestDb();
  });
  beforeEach(async () => {
    await truncateAllTables();
    fx = await seedRestrictionFixture();
    for (const pageId of [fx.pages.openRoot, fx.pages.hushedLeaf, fx.pages.visibleChild]) {
      await query(
        `INSERT INTO page_embeddings (page_id, chunk_index, chunk_text, embedding, metadata)
         VALUES ($1, 0, 'same text', $2, '{}'::jsonb)`,
        [pageId, vector],
      );
    }
  });

  const titles = (rows: Array<{ title: string }>) => rows.map((row) => row.title).sort();

  it('never offers a restricted page to R as a candidate or a source', async () => {
    expect(titles(await findDuplicates(fx.readerId, 'c-open-root'))).toEqual(['Visible Child']);
    expect(await findDuplicates(fx.readerId, 'c-hushed-leaf')).toEqual([]);
    const pairs = await scanAllDuplicates(fx.readerId);
    expect(JSON.stringify(pairs)).not.toContain('Hushed Leaf');

    expect(titles(await findDuplicates(fx.groupReaderId, 'c-open-root'))).toEqual(['Hushed Leaf', 'Visible Child']);
    expect(titles(await findDuplicates(fx.groupReaderId, 'c-hushed-leaf'))).toEqual(['Open Root', 'Visible Child']);
    expect(titles(await findDuplicates(fx.adminId, 'c-open-root'))).toEqual(['Hushed Leaf', 'Visible Child']);
    expect(JSON.stringify(await scanAllDuplicates(fx.adminId))).toContain('Hushed Leaf');
  });
});
