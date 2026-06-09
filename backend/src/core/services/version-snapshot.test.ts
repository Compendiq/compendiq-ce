import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, teardownTestDb, truncateAllTables, isDbAvailable } from '../../test-db-helper.js';
import { query } from '../db/postgres.js';
import { upsertVersionMetadata, fillVersionBody } from './version-snapshot.js';

const dbAvailable = await isDbAvailable();

/**
 * Seed a minimal standalone page and return its internal `id`.
 */
async function seedPage(): Promise<number> {
  const res = await query<{ id: number }>(
    `INSERT INTO pages (space_key, title, body_html, body_text, version, source, embedding_dirty, embedding_status)
     VALUES ('TEST', 'Test page', '<p>v1</p>', 'v1', 1, 'standalone', FALSE, 'not_embedded')
     RETURNING id`,
  );
  return res.rows[0]!.id;
}

describe.skipIf(!dbAvailable)('upsertVersionMetadata + fillVersionBody (#722)', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => { await truncateAllTables(); });

  it('upsertVersionMetadata inserts then updates metadata idempotently', async () => {
    const id = await seedPage();
    await upsertVersionMetadata(id, 3, 'T', { editedAt: '2026-01-02T00:00:00Z', author: 'Ann', message: 'edit' });
    await upsertVersionMetadata(id, 3, 'T', { editedAt: '2026-01-02T00:00:00Z', author: 'Ann', message: 'edit' }); // no dup
    const r = await query(`SELECT author, message FROM page_versions WHERE page_id=$1 AND version_number=3`, [id]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ author: 'Ann', message: 'edit' });
  });

  it('fillVersionBody fills a null body only', async () => {
    const id = await seedPage();
    await upsertVersionMetadata(id, 2, 'T', { editedAt: null, author: null, message: null });
    await fillVersionBody(id, 2, '<p>hi</p>', 'hi');
    const r = await query(`SELECT body_html FROM page_versions WHERE page_id=$1 AND version_number=2`, [id]);
    expect(r.rows[0]!.body_html).toBe('<p>hi</p>');
  });
});
