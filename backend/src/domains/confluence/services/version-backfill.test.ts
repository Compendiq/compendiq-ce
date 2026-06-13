import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, teardownTestDb, truncateAllTables, isDbAvailable } from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import { upsertVersionMetadata } from '../../../core/services/version-snapshot.js';
import { backfillVersionHistory, getHistoricalBody } from './version-backfill.js';

const dbAvailable = await isDbAvailable();

/**
 * Seed a minimal Confluence-sourced page and return its internal `id`.
 */
async function seedConfluencePage(confluenceId: string): Promise<number> {
  const res = await query<{ id: number }>(
    `INSERT INTO pages (confluence_id, space_key, title, body_html, body_text, version, source, embedding_dirty, embedding_status)
     VALUES ($1, 'TEST', 'Test page', '<p>v1</p>', 'v1', 1, 'confluence', FALSE, 'not_embedded')
     RETURNING id`,
    [confluenceId],
  );
  return res.rows[0]!.id;
}

describe.skipIf(!dbAvailable)('version-backfill (#722)', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => { await truncateAllTables(); });

  it('backfillVersionHistory upserts one metadata row per Confluence version (idempotent)', async () => {
    const pageId = await seedConfluencePage('c-1');
    const client = {
      getPageVersions: vi.fn().mockResolvedValue([
        { number: 2, when: '2026-01-02T00:00:00Z', author: 'A', message: 'm', minorEdit: false },
        { number: 1, when: '2026-01-01T00:00:00Z', author: 'A', message: null, minorEdit: false },
      ]),
    };
    await backfillVersionHistory(pageId, 'c-1', client as never);
    await backfillVersionHistory(pageId, 'c-1', client as never); // idempotent
    const r = await query(
      `SELECT version_number, author, edited_at FROM page_versions WHERE page_id=$1 ORDER BY version_number`,
      [pageId],
    );
    expect(r.rows.map((x) => x.version_number)).toEqual([1, 2]);
  });

  it('getHistoricalBody fetches, converts via confluenceToHtml, and fills the body', async () => {
    const pageId = await seedConfluencePage('c-2');
    await upsertVersionMetadata(pageId, 1, 'T', { editedAt: null, author: null, message: null });
    const client = {
      getHistoricalPageBody: vi.fn().mockResolvedValue('<p>old</p>'),
    };
    const body = await getHistoricalBody(pageId, 'c-2', 1, client as never);
    expect(body.bodyHtml).toContain('old');
    const r = await query(
      `SELECT body_html FROM page_versions WHERE page_id=$1 AND version_number=1`,
      [pageId],
    );
    expect(r.rows[0]!.body_html).toContain('old');
  });
});
