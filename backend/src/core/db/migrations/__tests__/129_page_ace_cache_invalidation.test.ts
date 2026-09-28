import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getPool, query } from '../../postgres.js';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../../../../test-db-helper.js';

const dbAvailable = await isDbAvailable();

/**
 * Every ACE writer — CE routes, Confluence sync and sweep, page relocation,
 * and the Enterprise bulk permission route — changes which pages the list
 * predicate returns, so each principal change queues the page for the page
 * publication worker without depending on the writer's own cache calls.
 */
describe.skipIf(!dbAvailable)('migration 129 — page ACE writes queue page cache invalidation', () => {
  let pageA: number;
  let pageB: number;
  let userId: string;

  async function queued(): Promise<number[]> {
    const res = await query<{ page_id: number }>(
      'SELECT page_id FROM page_cache_invalidation_queue ORDER BY page_id',
    );
    return res.rows.map((row) => row.page_id);
  }

  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => {
    await truncateAllTables();
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    const user = await query<{ id: string }>(
      `INSERT INTO users (username, email, password_hash, role) VALUES ($1, $1 || '@test', 'x', 'user') RETURNING id`,
      [`ace-queue-${randomUUID()}`],
    );
    userId = user.rows[0]!.id;
    const pages = await query<{ id: number }>(
      `INSERT INTO pages (confluence_id, source, space_key, title, body_html)
       VALUES ('c-ace-a', 'confluence', 'DOCS', 'A', ''), ('c-ace-b', 'confluence', 'DOCS', 'B', '')
       RETURNING id`,
    );
    [pageA, pageB] = pages.rows.map((row) => row.id).sort((a, b) => a - b) as [number, number];
    await query('DELETE FROM page_cache_invalidation_queue');
  });

  it('queues inserts, principal changes, moves (both pages) and deletes', async () => {
    const ace = await query<{ id: number }>(
      `INSERT INTO access_control_entries (resource_type, resource_id, principal_type, principal_id, permission)
       VALUES ('page', $1, 'user', $2, 'read') RETURNING id`,
      [pageA, userId],
    );
    const aceId = ace.rows[0]!.id;
    expect(await queued()).toEqual([pageA]);

    await query('DELETE FROM page_cache_invalidation_queue');
    await query(`UPDATE access_control_entries SET principal_type = 'group', principal_id = '7' WHERE id = $1`, [aceId]);
    expect(await queued()).toEqual([pageA]);

    await query('DELETE FROM page_cache_invalidation_queue');
    await query('UPDATE access_control_entries SET resource_id = $2 WHERE id = $1', [aceId, pageB]);
    expect(await queued()).toEqual([pageA, pageB]);

    await query('DELETE FROM page_cache_invalidation_queue');
    await query('DELETE FROM access_control_entries WHERE id = $1', [aceId]);
    expect(await queued()).toEqual([pageB]);
  });

  it('queues the pages a group ACE covers when that group gains or loses a member', async () => {
    const group = await query<{ id: number }>(
      `INSERT INTO groups (name) VALUES ($1) RETURNING id`,
      [`ace-queue-group-${randomUUID()}`],
    );
    const groupId = group.rows[0]!.id;
    await query(
      `INSERT INTO access_control_entries (resource_type, resource_id, principal_type, principal_id, permission)
       VALUES ('page', $1, 'group', $2, 'read')`,
      [pageB, String(groupId)],
    );
    await query('DELETE FROM page_cache_invalidation_queue');

    await query('INSERT INTO group_memberships (group_id, user_id) VALUES ($1, $2)', [groupId, userId]);
    expect(await queued()).toEqual([pageB]);

    await query('DELETE FROM page_cache_invalidation_queue');
    await query('DELETE FROM group_memberships WHERE group_id = $1', [groupId]);
    expect(await queued()).toEqual([pageB]);

    const unrelated = await query<{ id: number }>(
      `INSERT INTO groups (name) VALUES ($1) RETURNING id`,
      [`ace-queue-unrelated-${randomUUID()}`],
    );
    await query('DELETE FROM page_cache_invalidation_queue');
    await query('INSERT INTO group_memberships (group_id, user_id) VALUES ($1, $2)', [unrelated.rows[0]!.id, userId]);
    expect(await queued()).toEqual([]);
  });

  it('ignores bookkeeping refreshes and space ACEs, and rolls back with the writer', async () => {
    const ace = await query<{ id: number }>(
      `INSERT INTO access_control_entries (resource_type, resource_id, principal_type, principal_id, permission)
       VALUES ('page', $1, 'user', $2, 'read') RETURNING id`,
      [pageA, userId],
    );
    await query('DELETE FROM page_cache_invalidation_queue');

    await query(
      `UPDATE access_control_entries SET synced_at = NOW(), source = 'confluence', permission = 'edit' WHERE id = $1`,
      [ace.rows[0]!.id],
    );
    await query(
      `INSERT INTO access_control_entries (resource_type, resource_id, principal_type, principal_id, permission)
       VALUES ('space', $1, 'user', $2, 'read')`,
      [pageB, userId],
    );
    expect(await queued()).toEqual([]);

    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO access_control_entries (resource_type, resource_id, principal_type, principal_id, permission)
         VALUES ('page', $1, 'group', '9', 'read')`,
        [pageB],
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect(await queued()).toEqual([]);
  });
});
