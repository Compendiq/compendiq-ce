import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../../test-db-helper.js';
import { query } from '../../postgres.js';

const dbAvailable = await isDbAvailable();

// The corrective migration SQL under test. We execute it explicitly after
// seeding so the assertions run against known data (migrations otherwise run
// once on an empty DB during setup, before any rows exist).
const migrationSql = readFileSync(
  fileURLToPath(new URL('../082_fix_page_paths_confluence_join.sql', import.meta.url)),
  'utf8',
);

describe.skipIf(!dbAvailable)('Migration 082 — fix page path backfill Confluence join (#897)', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => { await truncateAllTables(); });

  async function seedPage(opts: {
    confluenceId: string | null;
    parentId: string | null;
    title: string;
  }): Promise<number> {
    const res = await query<{ id: number }>(
      `INSERT INTO pages (
         space_key, title, body_html, body_text, version, source,
         confluence_id, parent_id, embedding_dirty, embedding_status,
         path, depth
       ) VALUES ('TEST', $1, '<p>x</p>', 'x', 1, 'confluence',
                 $2, $3, FALSE, 'not_embedded', NULL, 0)
       RETURNING id`,
      [opts.title, opts.confluenceId, opts.parentId],
    );
    return res.rows[0]!.id;
  }

  async function getPath(id: number): Promise<{ path: string | null; depth: number }> {
    const res = await query<{ path: string | null; depth: number }>(
      `SELECT path, depth FROM pages WHERE id = $1`,
      [id],
    );
    return { path: res.rows[0]!.path, depth: res.rows[0]!.depth };
  }

  it('backfills path/depth for a Confluence-synced hierarchy keyed on confluence_id', async () => {
    // Synced pages store the *parent's Confluence id* in parent_id, not the
    // internal SERIAL id. The buggy migration 041 joined parent_id = id::text,
    // so these children never matched and kept path=NULL / depth=0.
    const rootId = await seedPage({ confluenceId: '100', parentId: null, title: 'Root' });
    const childId = await seedPage({ confluenceId: '200', parentId: '100', title: 'Child' });
    const grandchildId = await seedPage({ confluenceId: '300', parentId: '200', title: 'Grandchild' });

    await query(migrationSql);

    expect(await getPath(rootId)).toEqual({ path: `/${rootId}`, depth: 0 });
    expect(await getPath(childId)).toEqual({ path: `/${rootId}/${childId}`, depth: 1 });
    expect(await getPath(grandchildId)).toEqual({
      path: `/${rootId}/${childId}/${grandchildId}`,
      depth: 2,
    });
  });

  it('backfills local (standalone) pages keyed on internal id::text', async () => {
    // Local pages have confluence_id = NULL and store the parent's internal id
    // as text in parent_id. COALESCE(confluence_id, id::text) must handle both.
    const rootId = await seedPage({ confluenceId: null, parentId: null, title: 'Local root' });
    const childId = await seedPage({
      confluenceId: null,
      parentId: String(rootId),
      title: 'Local child',
    });

    await query(migrationSql);

    expect(await getPath(rootId)).toEqual({ path: `/${rootId}`, depth: 0 });
    expect(await getPath(childId)).toEqual({ path: `/${rootId}/${childId}`, depth: 1 });
  });

  it('parents a synced page by confluence_id, not by a colliding internal id', async () => {
    // Collision case that exposed the bug in 041: page U has internal id 200 but
    // an unrelated confluence_id ('77'). Synced page B stores parent_id = '200',
    // meaning the *Confluence id* of its true parent — never U's internal id.
    // The buggy `parent_id = id::text` join wrongly nests B under U; the correct
    // `COALESCE(confluence_id, id::text)` join nests B under trueParent (cf '200').
    await query(
      `INSERT INTO pages (id, space_key, title, body_html, body_text, version, source,
         confluence_id, parent_id, embedding_dirty, embedding_status, path, depth)
       VALUES (200, 'TEST', 'Unrelated U', '<p>x</p>', 'x', 1, 'confluence',
               '77', NULL, FALSE, 'not_embedded', NULL, 0)`,
    );
    const trueParent = await seedPage({ confluenceId: '200', parentId: null, title: 'True parent' });
    const pageB = await seedPage({ confluenceId: '900', parentId: '200', title: 'Synced B' });

    await query(migrationSql);

    // B is parented under its confluence_id match (trueParent), never under U(id=200).
    expect(await getPath(pageB)).toEqual({ path: `/${trueParent}/${pageB}`, depth: 1 });
  });
});
