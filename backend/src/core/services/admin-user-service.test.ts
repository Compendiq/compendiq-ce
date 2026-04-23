import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../test-db-helper.js';
import { query } from '../db/postgres.js';
import {
  createUser,
  updateUser,
  deactivateUser,
  reactivateUser,
  deleteUser,
  listUsers,
  getUser,
  AdminUserServiceError,
} from './admin-user-service.js';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('admin-user-service (#304)', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => { await truncateAllTables(); });

  async function seedAdmin(username = 'root'): Promise<string> {
    const { user } = await createUser({
      username,
      email: `${username}@example.com`,
      displayName: username.toUpperCase(),
      role: 'admin',
      password: 'password-for-tests-1234',
    });
    return user.id;
  }

  it('createUser with explicit password', async () => {
    const { user, temporaryPassword } = await createUser({
      username: 'alice',
      email: 'Alice@Example.COM', // mixed case → normalised
      displayName: 'Alice',
      role: 'user',
      password: 'supersecret-1234',
    });

    expect(user.username).toBe('alice');
    expect(user.email).toBe('alice@example.com'); // lowercased
    expect(user.role).toBe('user');
    expect(user.deactivatedAt).toBeNull();
    expect(temporaryPassword).toBeUndefined();
  });

  it('createUser with generateRandomPassword returns the temp password', async () => {
    const { temporaryPassword } = await createUser({
      username: 'bob',
      email: 'bob@example.com',
      role: 'user',
      generateRandomPassword: true,
    });
    expect(temporaryPassword).toBeDefined();
    expect(temporaryPassword!.length).toBeGreaterThanOrEqual(16);
  });

  it('duplicate username rejected with USERNAME_TAKEN', async () => {
    await createUser({ username: 'carol', role: 'user', password: 'x1234567-9' });
    await expect(
      createUser({ username: 'carol', role: 'user', password: 'other-1234567' }),
    ).rejects.toMatchObject({ code: 'USERNAME_TAKEN' });
  });

  it('duplicate email rejected with EMAIL_TAKEN', async () => {
    await createUser({ username: 'dan1', email: 'dup@example.com', role: 'user', password: 'x12345678' });
    await expect(
      createUser({ username: 'dan2', email: 'DUP@example.com', role: 'user', password: 'x12345678' }),
    ).rejects.toMatchObject({ code: 'EMAIL_TAKEN' });
  });

  it('updateUser patches partial fields (email lowercased, role, displayName)', async () => {
    const { user } = await createUser({ username: 'eve', role: 'user', password: 'x12345678' });

    const patched = await updateUser(user.id, {
      email: 'Eve@Mail.Com',
      displayName: 'Evelyn',
      role: 'admin',
    });
    expect(patched.email).toBe('eve@mail.com');
    expect(patched.displayName).toBe('Evelyn');
    expect(patched.role).toBe('admin');
  });

  it('updateUser role-demotion of the last active admin is refused', async () => {
    const adminId = await seedAdmin('solo');
    await expect(
      updateUser(adminId, { role: 'user' }),
    ).rejects.toMatchObject({ code: 'LAST_ADMIN' });
  });

  it('updateUser role-demotion is allowed when another admin exists', async () => {
    const first = await seedAdmin('alpha');
    await seedAdmin('bravo'); // another admin
    const patched = await updateUser(first, { role: 'user' });
    expect(patched.role).toBe('user');
  });

  it('deactivateUser self-deactivate refused', async () => {
    const adminId = await seedAdmin();
    await expect(
      deactivateUser(adminId, { actorUserId: adminId }),
    ).rejects.toMatchObject({ code: 'SELF_FORBIDDEN' });
  });

  it('deactivateUser last-admin refused', async () => {
    const actorId = await seedAdmin('actor');
    const targetId = await seedAdmin('target');

    // Manually deactivate `actor` first so `target` becomes the last active admin
    await query(`UPDATE users SET deactivated_at = NOW() WHERE id = $1`, [actorId]);

    await expect(
      deactivateUser(targetId, { actorUserId: actorId }),
    ).rejects.toMatchObject({ code: 'LAST_ADMIN' });
  });

  it('deactivateUser sets markers + revokes refresh tokens', async () => {
    const adminId = await seedAdmin('admin1');
    const { user: target } = await createUser({
      username: 'target',
      role: 'user',
      password: 'x12345678',
    });
    // Seed a refresh token for `target`
    await query(
      `INSERT INTO refresh_tokens (jti, user_id, family, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '7 days')`,
      ['test-jti', target.id, 'test-family'],
    );

    const deactivated = await deactivateUser(target.id, {
      actorUserId: adminId,
      reason: 'off-boarding',
    });
    expect(deactivated.deactivatedAt).not.toBeNull();
    expect(deactivated.deactivatedBy).toBe(adminId);
    expect(deactivated.deactivatedReason).toBe('off-boarding');

    const tokens = await query(`SELECT 1 FROM refresh_tokens WHERE user_id = $1`, [target.id]);
    expect(tokens.rows.length).toBe(0);
  });

  it('reactivateUser clears markers', async () => {
    const adminId = await seedAdmin('admin2');
    const { user: target } = await createUser({
      username: 'victim',
      role: 'user',
      password: 'x12345678',
    });
    await deactivateUser(target.id, { actorUserId: adminId });
    const reacted = await reactivateUser(target.id);
    expect(reacted.deactivatedAt).toBeNull();
    expect(reacted.deactivatedBy).toBeNull();
    expect(reacted.deactivatedReason).toBeNull();
  });

  it('deleteUser removes the row', async () => {
    const adminId = await seedAdmin('admin3');
    const { user: target } = await createUser({
      username: 'dispensable',
      role: 'user',
      password: 'x12345678',
    });
    await deleteUser(target.id, { actorUserId: adminId });
    expect(await getUser(target.id)).toBeNull();
  });

  it('deleteUser succeeds when target has audit_log rows (FK SET NULL, row preserved)', async () => {
    // Regression test for PR #311 Finding #1: audit_log.user_id FK defaulted to
    // NO ACTION, blocking DELETE of any user who ever logged in. Migration 062
    // must change the FK to ON DELETE SET NULL so the history row survives with
    // a NULL pointer.
    const adminId = await seedAdmin('audit-admin');
    const { user: target } = await createUser({
      username: 'audit-target',
      role: 'user',
      password: 'x12345678',
    });

    // Seed an audit_log row pointing at the target (simulates LOGIN event).
    await query(
      `INSERT INTO audit_log (user_id, action, resource_type, resource_id, metadata)
       VALUES ($1, 'LOGIN', 'user', $2, '{}'::jsonb)`,
      [target.id, target.id],
    );

    await deleteUser(target.id, { actorUserId: adminId });

    expect(await getUser(target.id)).toBeNull();

    // Audit row preserved, user_id nulled out.
    const res = await query<{ user_id: string | null; action: string }>(
      `SELECT user_id, action FROM audit_log WHERE resource_id = $1`,
      [target.id],
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.user_id).toBeNull();
    expect(res.rows[0]!.action).toBe('LOGIN');
  });

  it('deleteUser succeeds when target has error_log rows (FK SET NULL)', async () => {
    const adminId = await seedAdmin('err-admin');
    const { user: target } = await createUser({
      username: 'err-target',
      role: 'user',
      password: 'x12345678',
    });
    await query(
      `INSERT INTO error_log (error_type, message, user_id) VALUES ('test', 'boom', $1)`,
      [target.id],
    );

    await deleteUser(target.id, { actorUserId: adminId });

    const res = await query<{ user_id: string | null }>(
      `SELECT user_id FROM error_log WHERE message = 'boom'`,
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.user_id).toBeNull();
  });

  it('deleteUser succeeds when target has resolved comments (FK SET NULL on resolved_by)', async () => {
    const adminId = await seedAdmin('cmt-admin');
    const { user: target } = await createUser({
      username: 'cmt-target',
      role: 'user',
      password: 'x12345678',
    });
    // Seed a page owned by admin and a comment resolved by target.
    const page = await query<{ id: number }>(
      `INSERT INTO pages (confluence_id, space_key, title, body_storage, body_html, body_text, version, labels)
       VALUES ('cmt-page-1', 'TST', 'Test', '', '', '', 1, '{}')
       RETURNING id`,
    );
    const pageId = page.rows[0]!.id;
    await query(
      `INSERT INTO comments (page_id, user_id, body, body_html, is_resolved, resolved_by, resolved_at)
       VALUES ($1, $2, 'hi', '<p>hi</p>', TRUE, $2, NOW())`,
      [pageId, target.id],
    );

    // The target comment author_id has ON DELETE CASCADE, so that comment will
    // be removed. What we care about here is that another comment resolved by
    // target (but authored by admin) has its resolved_by nulled out rather
    // than blocking the delete.
    await query(
      `INSERT INTO comments (page_id, user_id, body, body_html, is_resolved, resolved_by, resolved_at)
       VALUES ($1, $2, 'by admin', '<p>x</p>', TRUE, $3, NOW())`,
      [pageId, adminId, target.id],
    );

    await deleteUser(target.id, { actorUserId: adminId });

    const res = await query<{ resolved_by: string | null; body: string }>(
      `SELECT resolved_by, body FROM comments WHERE body = 'by admin'`,
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.resolved_by).toBeNull();
  });

  it('deleteUser reassigns templates.created_by to the system user (NOT NULL FK)', async () => {
    const adminId = await seedAdmin('tmpl-admin');
    const { user: target } = await createUser({
      username: 'tmpl-target',
      role: 'user',
      password: 'x12345678',
    });
    // Seed a template authored by the target.
    await query(
      `INSERT INTO templates (title, description, body_json, body_html, is_global, created_by)
       VALUES ('User Template', 'd', '{}', '', FALSE, $1)`,
      [target.id],
    );

    await deleteUser(target.id, { actorUserId: adminId });

    const SYSTEM_USER = '00000000-0000-0000-0000-000000000000';
    const res = await query<{ created_by: string; title: string }>(
      `SELECT created_by, title FROM templates WHERE title = 'User Template'`,
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.created_by).toBe(SYSTEM_USER);
  });

  it('deleteUser self-delete refused', async () => {
    const adminId = await seedAdmin();
    await expect(
      deleteUser(adminId, { actorUserId: adminId }),
    ).rejects.toMatchObject({ code: 'SELF_FORBIDDEN' });
  });

  it('deleteUser last-admin refused', async () => {
    const actorId = await seedAdmin('actor2');
    const targetId = await seedAdmin('target2');
    // Demote actor to 'user' via direct SQL so that target is the last admin.
    await query(`UPDATE users SET role = 'user' WHERE id = $1`, [actorId]);
    await expect(
      deleteUser(targetId, { actorUserId: actorId }),
    ).rejects.toMatchObject({ code: 'LAST_ADMIN' });
  });

  it('listUsers returns all users sorted by username', async () => {
    await createUser({ username: 'zulu', role: 'user', password: 'x12345678' });
    await createUser({ username: 'alpha', role: 'user', password: 'x12345678' });
    const users = await listUsers();
    expect(users.map((u) => u.username)).toEqual(['alpha', 'zulu']);
  });

  it('service error type is the custom class', async () => {
    await expect(
      deactivateUser('00000000-0000-4000-8000-000000000000', {
        actorUserId: '00000000-0000-4000-8000-000000000001',
      }),
    ).rejects.toBeInstanceOf(AdminUserServiceError);
  });

  // PR #311 Finding #2 — TOCTOU on last-admin deactivate/delete/demote.
  // The check must run inside the same transaction as the mutation, with a
  // FOR UPDATE lock on the other admin rows, so two concurrent "deactivate
  // the other admin" operations can't both pass the precheck.
  it('concurrent deactivate of two admins leaves at least one active (no TOCTOU)', async () => {
    // Two admins only. Both try to deactivate the other simultaneously.
    // Without serialization one would expect both to succeed and leave zero
    // active admins. With the fix, exactly one succeeds and the other fails
    // with LAST_ADMIN.
    const aId = await seedAdmin('race-a');
    const bId = await seedAdmin('race-b');

    const p1 = deactivateUser(bId, { actorUserId: aId }).then(
      () => 'ok' as const,
      (err: unknown) => err,
    );
    const p2 = deactivateUser(aId, { actorUserId: bId }).then(
      () => 'ok' as const,
      (err: unknown) => err,
    );
    const [r1, r2] = await Promise.all([p1, p2]);

    const results = [r1, r2];
    const okCount = results.filter((r) => r === 'ok').length;
    const lastAdmin = results.filter(
      (r) => r instanceof AdminUserServiceError && r.code === 'LAST_ADMIN',
    ).length;
    expect(okCount).toBe(1);
    expect(lastAdmin).toBe(1);

    // Post-condition: exactly one admin remains active.
    const after = await query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM users
        WHERE role = 'admin' AND deactivated_at IS NULL
          AND id <> '00000000-0000-0000-0000-000000000000'`,
    );
    expect(parseInt(after.rows[0]!.c, 10)).toBe(1);
  });

  it('concurrent delete of two admins leaves at least one active (no TOCTOU)', async () => {
    const aId = await seedAdmin('race-del-a');
    const bId = await seedAdmin('race-del-b');

    const p1 = deleteUser(bId, { actorUserId: aId }).then(
      () => 'ok' as const,
      (err: unknown) => err,
    );
    const p2 = deleteUser(aId, { actorUserId: bId }).then(
      () => 'ok' as const,
      (err: unknown) => err,
    );
    const results = await Promise.all([p1, p2]);

    const okCount = results.filter((r) => r === 'ok').length;
    const lastAdmin = results.filter(
      (r) => r instanceof AdminUserServiceError && r.code === 'LAST_ADMIN',
    ).length;
    expect(okCount).toBe(1);
    expect(lastAdmin).toBe(1);

    const after = await query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM users
        WHERE role = 'admin' AND deactivated_at IS NULL
          AND id <> '00000000-0000-0000-0000-000000000000'`,
    );
    expect(parseInt(after.rows[0]!.c, 10)).toBe(1);
  });

  it('concurrent role-demote of two admins leaves at least one active (no TOCTOU)', async () => {
    const aId = await seedAdmin('race-dem-a');
    const bId = await seedAdmin('race-dem-b');

    const p1 = updateUser(aId, { role: 'user' }).then(
      () => 'ok' as const,
      (err: unknown) => err,
    );
    const p2 = updateUser(bId, { role: 'user' }).then(
      () => 'ok' as const,
      (err: unknown) => err,
    );
    const results = await Promise.all([p1, p2]);

    const okCount = results.filter((r) => r === 'ok').length;
    const lastAdmin = results.filter(
      (r) => r instanceof AdminUserServiceError && r.code === 'LAST_ADMIN',
    ).length;
    expect(okCount).toBe(1);
    expect(lastAdmin).toBe(1);

    const after = await query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM users
        WHERE role = 'admin' AND deactivated_at IS NULL
          AND id <> '00000000-0000-0000-0000-000000000000'`,
    );
    expect(parseInt(after.rows[0]!.c, 10)).toBe(1);
  });
});
