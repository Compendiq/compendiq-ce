/**
 * Admin user lifecycle service (#304).
 *
 * Owns the business logic behind the Settings → Users admin page. Audit
 * emission happens at the route layer via `audit-service.ts`; this module
 * only raises errors — callers decide how to map them to HTTP codes.
 */

import bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';
import { query, getPool } from '../db/postgres.js';
import { logger } from '../utils/logger.js';
import type { AdminUser, AdminUserRole } from '@compendiq/contracts';

const BCRYPT_ROUNDS = 10;

/**
 * Errors thrown by the service. Routes map them to HTTP status codes.
 */
export class AdminUserServiceError extends Error {
  constructor(
    public readonly code:
      | 'USERNAME_TAKEN'
      | 'EMAIL_TAKEN'
      | 'NOT_FOUND'
      | 'SELF_FORBIDDEN'
      | 'LAST_ADMIN',
    message: string,
  ) {
    super(message);
    this.name = 'AdminUserServiceError';
  }
}

/** Normalise an email to lowercase before lookup/insert. Null → null. */
function normEmail(email: string | null | undefined): string | null {
  if (email === undefined || email === null) return null;
  return email.trim().toLowerCase();
}

/** Row shape as stored in `users`. */
interface UserRow {
  id: string;
  username: string;
  email: string | null;
  display_name: string | null;
  role: AdminUserRole;
  auth_provider: string;
  deactivated_at: Date | null;
  deactivated_by: string | null;
  deactivated_reason: string | null;
  created_at: Date;
}

function rowToAdminUser(row: UserRow): AdminUser {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    authProvider: row.auth_provider,
    deactivatedAt: row.deactivated_at?.toISOString() ?? null,
    deactivatedBy: row.deactivated_by,
    deactivatedReason: row.deactivated_reason,
    createdAt: row.created_at.toISOString(),
  };
}

const USER_SELECT = `
  SELECT id, username, email, display_name, role, auth_provider,
         deactivated_at, deactivated_by, deactivated_reason, created_at
    FROM users
`;

export async function listUsers(): Promise<AdminUser[]> {
  const res = await query<UserRow>(
    `${USER_SELECT} ORDER BY username`,
  );
  return res.rows.map(rowToAdminUser);
}

export async function getUser(id: string): Promise<AdminUser | null> {
  const res = await query<UserRow>(`${USER_SELECT} WHERE id = $1`, [id]);
  return res.rows[0] ? rowToAdminUser(res.rows[0]) : null;
}

export interface CreateUserOptions {
  username: string;
  email?: string | null;
  displayName?: string | null;
  role: AdminUserRole;
  /** Explicit password. Either this or `generateRandomPassword` must be true. */
  password?: string;
  /**
   * When true, a cryptographically-random password is generated and
   * returned via the `temporaryPassword` field. Caller (route) decides
   * whether to email a password-reset link or return the password.
   */
  generateRandomPassword?: boolean;
}

export interface CreateUserResult {
  user: AdminUser;
  /** Populated when `generateRandomPassword: true` — otherwise undefined. */
  temporaryPassword?: string;
}

export async function createUser(opts: CreateUserOptions): Promise<CreateUserResult> {
  const email = normEmail(opts.email);
  const displayName = opts.displayName?.trim() ?? null;

  let password = opts.password;
  let temporaryPassword: string | undefined;
  if (!password) {
    if (!opts.generateRandomPassword) {
      throw new Error('Either password or generateRandomPassword must be provided');
    }
    // Random 20-char password, URL-safe chars only so it round-trips
    // through an invitation email cleanly if we ever surface it there.
    temporaryPassword = randomUUID().replace(/-/g, '').slice(0, 20);
    password = temporaryPassword;
  }
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  try {
    const res = await query<UserRow>(
      `INSERT INTO users (username, password_hash, role, email, display_name)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, username, email, display_name, role, auth_provider,
                 deactivated_at, deactivated_by, deactivated_reason, created_at`,
      [opts.username, passwordHash, opts.role, email, displayName],
    );
    return { user: rowToAdminUser(res.rows[0]!), temporaryPassword };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/duplicate key.*users_username_key|users_pkey/i.test(msg)) {
      throw new AdminUserServiceError('USERNAME_TAKEN', 'Username already taken');
    }
    if (/duplicate key.*idx_users_email/i.test(msg)) {
      throw new AdminUserServiceError('EMAIL_TAKEN', 'Email already in use');
    }
    throw err;
  }
}

export interface UpdateUserOptions {
  email?: string | null;
  displayName?: string | null;
  role?: AdminUserRole;
}

export async function updateUser(id: string, patch: UpdateUserOptions): Promise<AdminUser> {
  const existing = await getUser(id);
  if (!existing) throw new AdminUserServiceError('NOT_FOUND', 'User not found');

  const updates: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  if (patch.email !== undefined) {
    updates.push(`email = $${i++}`);
    values.push(normEmail(patch.email));
  }
  if (patch.displayName !== undefined) {
    updates.push(`display_name = $${i++}`);
    values.push(patch.displayName === null ? null : patch.displayName.trim());
  }
  if (patch.role !== undefined) {
    // Role demotion of the last admin is refused.
    if (existing.role === 'admin' && patch.role !== 'admin') {
      await assertNotLastActiveAdmin(id);
    }
    updates.push(`role = $${i++}`);
    values.push(patch.role);
  }

  if (updates.length === 0) return existing;
  updates.push(`updated_at = NOW()`);
  values.push(id);

  try {
    const res = await query<UserRow>(
      `UPDATE users SET ${updates.join(', ')}
       WHERE id = $${i}
       RETURNING id, username, email, display_name, role, auth_provider,
                 deactivated_at, deactivated_by, deactivated_reason, created_at`,
      values,
    );
    if (res.rows.length === 0) throw new AdminUserServiceError('NOT_FOUND', 'User not found');
    return rowToAdminUser(res.rows[0]!);
  } catch (err: unknown) {
    if (err instanceof AdminUserServiceError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    if (/duplicate key.*idx_users_email/i.test(msg)) {
      throw new AdminUserServiceError('EMAIL_TAKEN', 'Email already in use');
    }
    throw err;
  }
}

export interface DeactivateOptions {
  actorUserId: string;
  reason?: string;
}

export async function deactivateUser(
  targetUserId: string,
  opts: DeactivateOptions,
): Promise<AdminUser> {
  if (targetUserId === opts.actorUserId) {
    throw new AdminUserServiceError('SELF_FORBIDDEN', 'Cannot deactivate yourself');
  }
  const existing = await getUser(targetUserId);
  if (!existing) throw new AdminUserServiceError('NOT_FOUND', 'User not found');
  if (existing.role === 'admin') {
    await assertNotLastActiveAdmin(targetUserId);
  }

  // Soft-deactivate + revoke all active sessions atomically.
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query<UserRow>(
      `UPDATE users
         SET deactivated_at = NOW(),
             deactivated_by = $2,
             deactivated_reason = $3,
             updated_at = NOW()
       WHERE id = $1
       RETURNING id, username, email, display_name, role, auth_provider,
                 deactivated_at, deactivated_by, deactivated_reason, created_at`,
      [targetUserId, opts.actorUserId, opts.reason ?? null],
    );
    if (updated.rowCount === 0) {
      throw new AdminUserServiceError('NOT_FOUND', 'User not found');
    }
    await client.query(
      `DELETE FROM refresh_tokens WHERE user_id = $1`,
      [targetUserId],
    );
    await client.query('COMMIT');
    return rowToAdminUser(updated.rows[0]!);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function reactivateUser(targetUserId: string): Promise<AdminUser> {
  const res = await query<UserRow>(
    `UPDATE users
       SET deactivated_at = NULL,
           deactivated_by = NULL,
           deactivated_reason = NULL,
           updated_at = NOW()
     WHERE id = $1
     RETURNING id, username, email, display_name, role, auth_provider,
               deactivated_at, deactivated_by, deactivated_reason, created_at`,
    [targetUserId],
  );
  if (res.rows.length === 0) {
    throw new AdminUserServiceError('NOT_FOUND', 'User not found');
  }
  return rowToAdminUser(res.rows[0]!);
}

export interface DeleteUserOptions {
  actorUserId: string;
}

export async function deleteUser(
  targetUserId: string,
  opts: DeleteUserOptions,
): Promise<void> {
  if (targetUserId === opts.actorUserId) {
    throw new AdminUserServiceError('SELF_FORBIDDEN', 'Cannot delete yourself');
  }
  const existing = await getUser(targetUserId);
  if (!existing) throw new AdminUserServiceError('NOT_FOUND', 'User not found');
  if (existing.role === 'admin') {
    await assertNotLastActiveAdmin(targetUserId);
  }

  // Relies on the existing FK policies: audit_log.user_id keeps the ID
  // (audit history is immutable); pages.created_by_user_id has ON DELETE
  // SET NULL; space_role_assignments + group_memberships cascade.
  const res = await query(`DELETE FROM users WHERE id = $1`, [targetUserId]);
  if (res.rowCount === 0) {
    throw new AdminUserServiceError('NOT_FOUND', 'User not found');
  }
  logger.info({ targetUserId, actor: opts.actorUserId }, 'admin-user-service: deleted user');
}

/**
 * Raise `LAST_ADMIN` if deactivating / deleting / demoting `targetUserId`
 * would leave the install without any active admin. The caller has already
 * verified `targetUserId` is currently an admin.
 */
async function assertNotLastActiveAdmin(targetUserId: string): Promise<void> {
  const res = await query<{ other_admins: string }>(
    `SELECT COUNT(*)::text AS other_admins
       FROM users
      WHERE role = 'admin'
        AND deactivated_at IS NULL
        AND id <> $1`,
    [targetUserId],
  );
  const count = parseInt(res.rows[0]?.other_admins ?? '0', 10);
  if (count === 0) {
    throw new AdminUserServiceError(
      'LAST_ADMIN',
      'Cannot remove the last active admin — promote another admin first',
    );
  }
}
