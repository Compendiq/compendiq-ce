import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb } from '../../../test-db-helper.js';
import { query, getPool } from '../../../core/db/postgres.js';
import { unsyncSpace } from './sync-service.js';

/**
 * Seed one row in every space-scoped table for two spaces: `target` (the one we
 * unsync) and `other` (must be left completely untouched — no over-deletion).
 * Returns the inserted target page id so cascade children can be asserted.
 */
/** Re-seed the system roles that migration 039 created (truncateAllTables wipes them). */
async function ensureRoles(): Promise<void> {
  await query(
    `INSERT INTO roles (name, display_name, is_system) VALUES
       ('editor','Editor',TRUE), ('viewer','Viewer',TRUE)
     ON CONFLICT (name) DO NOTHING`,
  );
}

async function seedSpace(spaceKey: string): Promise<{ pageId: number; templateId: number; krId: number }> {
  await ensureRoles();
  await query(
    `INSERT INTO spaces (space_key, space_name, source) VALUES ($1, $1, 'confluence')`,
    [spaceKey],
  );
  const p = await query<{ id: number }>(
    `INSERT INTO pages (confluence_id, space_key, title, body_text, body_storage, body_html, source)
     VALUES ($1, $2, 'Page', 'text', '', '', 'confluence') RETURNING id`,
    [`c-${spaceKey}`, spaceKey],
  );
  const pageId = p.rows[0]!.id;
  // Cascade children of pages (page_id FK ON DELETE CASCADE — migration 030).
  await query(
    `INSERT INTO page_versions (page_id, version_number, title) VALUES ($1, 1, 'Page')`,
    [pageId],
  );
  await query(
    `INSERT INTO page_embeddings (page_id, chunk_index, chunk_text, embedding)
     VALUES ($1, 0, 'text', $2)`,
    [pageId, `[${Array(1024).fill(0).join(',')}]`],
  );
  // RBAC role assignment (also encodes the sync-selection — `user_space_selections`
  // was migrated into this table and dropped in migration 040).
  await query(
    `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
     SELECT $1, 'user', gen_random_uuid()::text, id FROM roles WHERE name='editor' LIMIT 1`,
    [spaceKey],
  );
  // OIDC group → space RBAC mapping (space_key nullable).
  await query(
    `INSERT INTO oidc_group_role_mappings (oidc_group, role_id, space_key)
     SELECT $1, id, $2 FROM roles WHERE name='viewer' LIMIT 1`,
    [`grp-${spaceKey}`, spaceKey],
  );
  // Author for the user-authored artifacts below.
  const u = await query<{ id: string }>(
    `INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'user') RETURNING id`,
    [`user-${spaceKey}`],
  );
  const userId = u.rows[0]!.id;
  // User-authored artifacts referencing the space by plain space_key (nullable).
  const t = await query<{ id: number }>(
    `INSERT INTO templates (title, body_json, body_html, created_by, space_key)
     VALUES ('T', '{}', '<p></p>', $1, $2) RETURNING id`,
    [userId, spaceKey],
  );
  const kr = await query<{ id: number }>(
    `INSERT INTO knowledge_requests (title, requested_by, space_key)
     VALUES ('KR', $1, $2) RETURNING id`,
    [userId, spaceKey],
  );
  return { pageId, templateId: t.rows[0]!.id, krId: kr.rows[0]!.id };
}

describe('unsyncSpace', () => {
  beforeEach(async () => {
    await setupTestDb();
    await truncateAllTables();
  });
  afterAll(async () => {
    await teardownTestDb();
  });

  it('deletes the space, its pages (cascading versions/embeddings), and role assignments', async () => {
    await ensureRoles();
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

  it('removes all space-scoped rows for the target and leaves a second space untouched', async () => {
    const target = await seedSpace('ENG');
    const other = await seedSpace('OPS');

    const result = await unsyncSpace('ENG');
    expect(result.pagesDeleted).toBe(1);

    // ── Target space: every space-scoped row is gone ──────────────────────
    expect((await query(`SELECT 1 FROM spaces WHERE space_key='ENG'`)).rows).toHaveLength(0);
    expect((await query(`SELECT 1 FROM pages WHERE space_key='ENG'`)).rows).toHaveLength(0);
    // Cascade children of the deleted page.
    expect((await query(`SELECT 1 FROM page_versions WHERE page_id=$1`, [target.pageId])).rows).toHaveLength(0);
    expect((await query(`SELECT 1 FROM page_embeddings WHERE page_id=$1`, [target.pageId])).rows).toHaveLength(0);
    expect((await query(`SELECT 1 FROM space_role_assignments WHERE space_key='ENG'`)).rows).toHaveLength(0);
    expect((await query(`SELECT 1 FROM oidc_group_role_mappings WHERE space_key='ENG'`)).rows).toHaveLength(0);

    // ── User-authored artifacts: DETACHED (retained, space_key NULLed) ────
    const tgtTemplate = await query<{ space_key: string | null }>(
      `SELECT space_key FROM templates WHERE id=$1`, [target.templateId]);
    expect(tgtTemplate.rows).toHaveLength(1);
    expect(tgtTemplate.rows[0]!.space_key).toBeNull();
    const tgtKr = await query<{ space_key: string | null }>(
      `SELECT space_key FROM knowledge_requests WHERE id=$1`, [target.krId]);
    expect(tgtKr.rows).toHaveLength(1);
    expect(tgtKr.rows[0]!.space_key).toBeNull();

    // No row anywhere still points at the removed space_key.
    expect((await query(`SELECT 1 FROM templates WHERE space_key='ENG'`)).rows).toHaveLength(0);
    expect((await query(`SELECT 1 FROM knowledge_requests WHERE space_key='ENG'`)).rows).toHaveLength(0);

    // ── Other space: completely untouched (no over-deletion) ──────────────
    expect((await query(`SELECT 1 FROM spaces WHERE space_key='OPS'`)).rows).toHaveLength(1);
    expect((await query(`SELECT 1 FROM pages WHERE space_key='OPS'`)).rows).toHaveLength(1);
    expect((await query(`SELECT 1 FROM page_versions WHERE page_id=$1`, [other.pageId])).rows).toHaveLength(1);
    expect((await query(`SELECT 1 FROM page_embeddings WHERE page_id=$1`, [other.pageId])).rows).toHaveLength(1);
    expect((await query(`SELECT 1 FROM space_role_assignments WHERE space_key='OPS'`)).rows).toHaveLength(1);
    expect((await query(`SELECT 1 FROM oidc_group_role_mappings WHERE space_key='OPS'`)).rows).toHaveLength(1);
    const otherTemplate = await query<{ space_key: string | null }>(
      `SELECT space_key FROM templates WHERE id=$1`, [other.templateId]);
    expect(otherTemplate.rows[0]!.space_key).toBe('OPS');
    const otherKr = await query<{ space_key: string | null }>(
      `SELECT space_key FROM knowledge_requests WHERE id=$1`, [other.krId]);
    expect(otherKr.rows[0]!.space_key).toBe('OPS');
  });

  it('rolls back every row delete atomically when a statement fails mid-transaction', async () => {
    const target = await seedSpace('ENG');
    const other = await seedSpace('OPS');

    // Inject a failure on the final DB statement (DELETE FROM spaces) by
    // wrapping the pooled client returned by connect(). Everything deleted
    // before it must be rolled back.
    const pool = getPool();
    const realConnect = pool.connect.bind(pool);
    // Forward all args to the real connect: pg-pool's internal `pool.query`
    // path may call `connect(callback)`, and dropping that callback would
    // hang every pooled query. We only ever take the explicit promise form
    // (the one `unsyncSpace` uses) and wrap that client's `query`.
    /* eslint-disable @typescript-eslint/no-explicit-any -- pg client/connect overloads */
    const connectSpy = vi.spyOn(pool, 'connect').mockImplementation((...args: any[]) => {
      if (args.length > 0) {
        // Callback / config form — pass straight through unwrapped.
        return (realConnect as any)(...args);
      }
      return (realConnect as any)().then((client: any) => {
        const realQuery = client.query.bind(client);
        client.query = (text: any, ...rest: any[]) => {
          if (typeof text === 'string' && /DELETE FROM spaces/i.test(text)) {
            return Promise.reject(new Error('injected failure'));
          }
          return realQuery(text, ...rest);
        };
        return client;
      });
    });
    /* eslint-enable @typescript-eslint/no-explicit-any */

    try {
      await expect(unsyncSpace('ENG')).rejects.toThrow('injected failure');
    } finally {
      connectSpy.mockRestore();
    }

    // Nothing for the target space was committed — full rollback.
    expect((await query(`SELECT 1 FROM spaces WHERE space_key='ENG'`)).rows).toHaveLength(1);
    expect((await query(`SELECT 1 FROM pages WHERE space_key='ENG'`)).rows).toHaveLength(1);
    expect((await query(`SELECT 1 FROM page_versions WHERE page_id=$1`, [target.pageId])).rows).toHaveLength(1);
    expect((await query(`SELECT 1 FROM space_role_assignments WHERE space_key='ENG'`)).rows).toHaveLength(1);
    expect((await query(`SELECT 1 FROM oidc_group_role_mappings WHERE space_key='ENG'`)).rows).toHaveLength(1);
    expect((await query<{ space_key: string | null }>(
      `SELECT space_key FROM templates WHERE id=$1`, [target.templateId])).rows[0]!.space_key).toBe('ENG');
    expect((await query<{ space_key: string | null }>(
      `SELECT space_key FROM knowledge_requests WHERE id=$1`, [target.krId])).rows[0]!.space_key).toBe('ENG');

    // The other space is likewise untouched.
    expect((await query(`SELECT 1 FROM spaces WHERE space_key='OPS'`)).rows).toHaveLength(1);
    void other;
  });
});
