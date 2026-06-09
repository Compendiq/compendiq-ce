import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb } from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import { unsyncSpace } from './sync-service.js';

describe('unsyncSpace', () => {
  beforeEach(async () => {
    await setupTestDb();
    await truncateAllTables();
  });
  afterAll(async () => {
    await teardownTestDb();
  });

  it('deletes the space, its pages (cascading versions/embeddings), and role assignments', async () => {
    await query(
      `INSERT INTO spaces (space_key, space_name, source) VALUES ('ENG','Engineering','confluence')`,
    );
    const p = await query<{ id: number }>(
      `INSERT INTO pages (confluence_id, space_key, title, body_text, body_storage, body_html, source)
       VALUES ('c-1','ENG','Page','text','','','confluence') RETURNING id`,
    );
    const pageId = p.rows[0]!.id;
    await query(
      `INSERT INTO page_versions (page_id, version_number, title) VALUES ($1, 1, 'Page')`,
      [pageId],
    );
    await query(
      `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
       SELECT 'ENG','user', gen_random_uuid()::text, id FROM roles WHERE name='editor' LIMIT 1`,
    );

    const result = await unsyncSpace('ENG');

    expect(result.pagesDeleted).toBe(1);
    expect((await query(`SELECT 1 FROM spaces WHERE space_key='ENG'`)).rows).toHaveLength(0);
    expect((await query(`SELECT 1 FROM pages WHERE space_key='ENG'`)).rows).toHaveLength(0);
    expect((await query(`SELECT 1 FROM page_versions WHERE page_id=$1`, [pageId])).rows).toHaveLength(0);
    expect((await query(`SELECT 1 FROM space_role_assignments WHERE space_key='ENG'`)).rows).toHaveLength(0);
  });

  it('returns pagesDeleted=0 when the space has no pages', async () => {
    await query(
      `INSERT INTO spaces (space_key, space_name, source) VALUES ('EMPTY','Empty','confluence')`,
    );

    const result = await unsyncSpace('EMPTY');

    expect(result.pagesDeleted).toBe(0);
    expect((await query(`SELECT 1 FROM spaces WHERE space_key='EMPTY'`)).rows).toHaveLength(0);
  });

  it('returns pagesDeleted=0 and makes no change for a non-existent space', async () => {
    const result = await unsyncSpace('NOPE');
    expect(result.pagesDeleted).toBe(0);
  });
});
