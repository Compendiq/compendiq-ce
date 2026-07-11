/**
 * Real-Postgres test for migration 081's invalidation trigger (#887).
 *
 * The persisted `expected_image_files` / `expected_drawio_files` columns must be
 * reset to NULL whenever a page's `body_storage` changes, so getSyncOverview's
 * lazy backfill recomputes them. Anything else (e.g. a title-only edit, or the
 * overview's own persist UPDATE that writes the array columns) must leave the
 * cached sets untouched. This exercises the trigger against the actual `pages`
 * table via `test-db-helper.ts`; it `describe.skipIf(!dbAvailable)` so
 * contributors without a running test Postgres can still run the rest of the
 * suite.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  setupTestDb,
  truncateAllTables,
  teardownTestDb,
  isDbAvailable,
} from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';

const dbAvailable = await isDbAvailable();

async function insertPage(confluenceId: string, bodyStorage: string): Promise<void> {
  await query(
    `INSERT INTO pages (confluence_id, source, space_key, title, body_text,
                        body_storage, body_html, inherit_perms)
     VALUES ($1, 'confluence', 'OPS', $2, 'text', $3, '', TRUE)`,
    [confluenceId, `Page ${confluenceId}`, bodyStorage],
  );
}

async function getExpected(confluenceId: string): Promise<{
  image: string[] | null;
  drawio: string[] | null;
}> {
  const res = await query<{ expected_image_files: string[] | null; expected_drawio_files: string[] | null }>(
    'SELECT expected_image_files, expected_drawio_files FROM pages WHERE confluence_id = $1',
    [confluenceId],
  );
  return {
    image: res.rows[0]?.expected_image_files ?? null,
    drawio: res.rows[0]?.expected_drawio_files ?? null,
  };
}

describe.skipIf(!dbAvailable)('pages expected-asset invalidation trigger (#887)', () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  it('resets both expected-asset columns to NULL when body_storage changes', async () => {
    await insertPage('page-1', '<p>original</p>');
    await query(
      `UPDATE pages SET expected_image_files = '{x.png}', expected_drawio_files = '{y.png}' WHERE confluence_id = $1`,
      ['page-1'],
    );

    // Precondition: the cache is populated.
    const before = await getExpected('page-1');
    expect(before.image).toEqual(['x.png']);
    expect(before.drawio).toEqual(['y.png']);

    // Change body_storage -> trigger must invalidate the cache.
    await query('UPDATE pages SET body_storage = $2 WHERE confluence_id = $1', ['page-1', '<p>edited</p>']);

    const after = await getExpected('page-1');
    expect(after.image).toBeNull();
    expect(after.drawio).toBeNull();
  });

  it('leaves the cached sets untouched when body_storage is unchanged', async () => {
    await insertPage('page-2', '<p>stable</p>');
    await query(
      `UPDATE pages SET expected_image_files = '{a.png}', expected_drawio_files = '{}' WHERE confluence_id = $1`,
      ['page-2'],
    );

    // A title-only edit does not touch body_storage -> cache survives.
    await query('UPDATE pages SET title = $2 WHERE confluence_id = $1', ['page-2', 'Renamed']);

    const after = await getExpected('page-2');
    expect(after.image).toEqual(['a.png']);
    expect(after.drawio).toEqual([]);
  });
});
