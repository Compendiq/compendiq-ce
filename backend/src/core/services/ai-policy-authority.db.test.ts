import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPool, query } from '../db/postgres.js';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../test-db-helper.js';
import { applyAiPolicyOnClient, applyPageLabelsOnClient, canMutateAiPolicy, isAiPolicyRefusal, updatePageAiPolicies } from './ai-policy-service.js';

const dbAvailable = await isDbAvailable();
describe.skipIf(!dbAvailable)('policy authority: standalone scoped editor', () => {
  beforeAll(async () => { await setupTestDb(); await truncateAllTables(); });
  afterAll(async () => { await teardownTestDb(); });

  it('denies unqualified tightening by a shared viewer and hides private targets before any mutation', async () => {
    const owner = randomUUID();
    const viewer = randomUUID();
    await query(`INSERT INTO users (id, username, email, password_hash, role)
      VALUES ($1::uuid, $1::text, $1::text || '@test.invalid', 'x', 'user'),
             ($2::uuid, $2::text, $2::text || '@test.invalid', 'x', 'user')`, [owner, viewer]);
    const inserted = await query<{ id: number }>(`INSERT INTO pages
      (title, version, source, visibility, created_by_user_id, ai_policy, labels)
      VALUES ('Private policy', 1, 'standalone', 'shared', $1, 'all', ARRAY['ordinary']) RETURNING id`, [owner]);
    const id = inserted.rows[0]!.id;
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const before = await client.query('SELECT ai_policy, ai_policy_revision, labels FROM pages WHERE id = $1', [id]);
      await expect(applyAiPolicyOnClient(client, {
        userId: viewer, items: [{ pageId: id, policy: 'none', expectedRevision: 0 }],
      })).resolves.toEqual({ ok: false, reason: 'not_authorized', pageIds: [id] });
      expect((await client.query('SELECT ai_policy, ai_policy_revision, labels FROM pages WHERE id = $1', [id])).rows)
        .toEqual(before.rows);
      const denied = await applyPageLabelsOnClient(client, {
        userId: viewer, pageId: id, targetLabels: ['no-ai', 'ordinary'],
      }).catch((err: unknown) => err);
      expect(isAiPolicyRefusal(denied)).toBe(true);
      expect(denied).toMatchObject({ statusCode: 403, body: { error: 'ai_policy_denied', pageIds: [id] } });
      await client.query("UPDATE pages SET visibility = 'private' WHERE id = $1", [id]);
      await expect(applyPageLabelsOnClient(client, {
        userId: viewer, pageId: id, targetLabels: ['ordinary'],
      })).rejects.toMatchObject({ statusCode: 404, reason: 'page_not_found' });
      await expect(applyPageLabelsOnClient(client, {
        userId: viewer, pageId: id, targetLabels: ['no-ai', 'ordinary'],
      })).rejects.toMatchObject({ statusCode: 404, reason: 'page_not_found' });
      await expect(applyAiPolicyOnClient(client, {
        userId: viewer, items: [{ pageId: id, policy: 'none', expectedRevision: 0 }],
      })).resolves.toEqual({ ok: false, reason: 'not_found', pageIds: [id] });
      expect((await client.query('SELECT ai_policy, ai_policy_revision, labels FROM pages WHERE id = $1', [id])).rows)
        .toEqual(before.rows);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('refuses bigint revisions outside the exact wire range before any bulk or label mutation', async () => {
    const owner = randomUUID();
    await query(`INSERT INTO users (id, username, password_hash, role) VALUES ($1::uuid,$1::text,'x','admin')`, [owner]);
    const inserted = await query<{ id: number }>(`INSERT INTO pages
      (title, source, visibility, created_by_user_id, ai_policy, labels, ai_policy_revision)
      VALUES ('safe','standalone','shared',$1,'all',ARRAY['all-ai'],0),
             ('unsafe','standalone','shared',$1,'all',ARRAY['all-ai'],9007199254740993)
      RETURNING id`, [owner]);
    const [safe, unsafe] = inserted.rows.map((row) => row.id);
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const state = () => client.query('SELECT id, ai_policy, ai_policy_revision, labels FROM pages WHERE id=ANY($1::int[]) ORDER BY id', [[safe, unsafe]]);
      const before = (await state()).rows;
      await expect(applyAiPolicyOnClient(client, {
        userId: owner, requireAuthority: true,
        items: [{ pageId: safe!, policy: 'all', expectedRevision: 0 }, { pageId: unsafe!, policy: 'all' }],
      })).rejects.toMatchObject({ statusCode: 503, body: { error: 'ai_policy_unavailable' } });
      expect((await state()).rows).toEqual(before);
      await expect(applyPageLabelsOnClient(client, {
        userId: owner, pageId: unsafe!, targetLabels: ['all-ai', 'ordinary'],
      })).rejects.toMatchObject({ statusCode: 503, body: { error: 'ai_policy_unavailable' } });
      expect((await state()).rows).toEqual(before);
      // Even a representable current token cannot produce an unsafe successor.
      await client.query('UPDATE pages SET ai_policy_revision=9007199254740991 WHERE id=$1', [safe]);
      await expect(applyAiPolicyOnClient(client, {
        userId: owner, requireAuthority: true,
        items: [{ pageId: safe!, policy: 'all', expectedRevision: Number.MAX_SAFE_INTEGER }],
      })).rejects.toMatchObject({ statusCode: 503 });
      expect((await state()).rows[0]!.ai_policy_revision).toBe('9007199254740991');
    } finally { await client.query('ROLLBACK'); client.release(); }
  });

  it('allows exact scoped edit, respects visibility and ACEs, and commits an editor relaxation', async () => {
    const owner = randomUUID();
    const editor = randomUUID();
    await query(`INSERT INTO users (id, username, email, password_hash, role)
      VALUES ($1::uuid, $1::text, $1::text || '@test.invalid', 'x', 'user'),
             ($2::uuid, $2::text, $2::text || '@test.invalid', 'x', 'user')`, [owner, editor]);
    await query(`INSERT INTO spaces (space_key, space_name) VALUES ('POLAUTH', 'Policy authority')`);
    const role = await query<{ id: number }>(`INSERT INTO roles (name, display_name, permissions)
      VALUES ($1, 'Policy editor', ARRAY['read','pages:edit']) RETURNING id`, [randomUUID()]);
    await query(`INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
      VALUES ('POLAUTH', 'user', $1, $2)`, [editor, role.rows[0]!.id]);
    const page = await query<{ id: number }>(`INSERT INTO pages
      (title, body_html, body_storage, body_text, version, source, visibility, created_by_user_id, space_key, ai_policy, labels)
      VALUES ('Policy', '<p>x</p>', '<p>x</p>', 'x', 1, 'standalone', 'shared', $1, 'POLAUTH', 'none', ARRAY['no-ai','ordinary'])
      RETURNING id`, [owner]);
    const id = page.rows[0]!.id;
    const client = await getPool().connect();
    try {
      expect(await canMutateAiPolicy(owner, id, client)).toBe(true);
      expect(await canMutateAiPolicy(editor, id, client)).toBe(false);
      await client.query(`UPDATE roles SET permissions = ARRAY['read','edit'] WHERE id = $1`, [role.rows[0]!.id]);
      expect(await canMutateAiPolicy(editor, id, client)).toBe(true);
      await client.query(`UPDATE pages SET visibility = 'private' WHERE id = $1`, [id]);
      expect(await canMutateAiPolicy(editor, id, client)).toBe(false);
      await client.query(`UPDATE pages SET visibility = 'shared', inherit_perms = FALSE WHERE id = $1`, [id]);
      await client.query(`INSERT INTO access_control_entries (resource_type, resource_id, principal_type, principal_id, permission)
        VALUES ('page', $1, 'user', $2, 'read')`, [id, editor]);
      expect(await canMutateAiPolicy(editor, id, client)).toBe(false);
      await client.query(`INSERT INTO access_control_entries (resource_type, resource_id, principal_type, principal_id, permission)
        VALUES ('page', $1, 'user', $2, 'edit')`, [id, editor]);
      expect(await canMutateAiPolicy(editor, id, client)).toBe(true);
      await expect(updatePageAiPolicies(editor, 'all', [{ pageId: id, expectedRevision: 0 }]))
        .resolves.toMatchObject({ ok: true, rows: [{ pageId: id, policy: 'all', revision: 1 }] });
      const saved = await client.query('SELECT ai_policy, labels FROM pages WHERE id = $1', [id]);
      expect(saved.rows[0]).toEqual({ ai_policy: 'all', labels: ['ordinary', 'all-ai'] });
      await client.query(`UPDATE pages SET deleted_at = NOW() WHERE id = $1`, [id]);
      expect(await canMutateAiPolicy(owner, id, client)).toBe(false);
    } finally { client.release(); }
  });
});
