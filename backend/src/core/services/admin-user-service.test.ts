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
});
