/**
 * Admin user lifecycle service (#304).
 *
 * Owns the business logic behind the Settings → Users admin page. Audit
 * emission happens at the route layer via `audit-service.ts`; this module
 * only raises errors — callers decide how to map them to HTTP codes.
 */

import bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { query, getPool } from '../db/postgres.js';
import { logger } from '../utils/logger.js';
import type { AdminUser, AdminUserRole } from '@compendiq/contracts';

const BCRYPT_ROUNDS = 10;

/**
 * System sentinel user that owns built-in templates (migration 032). When a
 * real user is hard-deleted we reassign their `templates.created_by` rows
 * to this UUID rather than blocking the delete on the NOT NULL FK.
 */
const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

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
  // The existence check + optional last-admin guard + mutation all run in
  // the same transaction so concurrent role-demotes can't both pass a
  // stale precheck (PR #311 Finding #2).
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock the row being updated first (smaller fan-out than the admin set).
    const existingRes = await client.query<UserRow>(
      `${USER_SELECT} WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (existingRes.rows.length === 0) {
      throw new AdminUserServiceError('NOT_FOUND', 'User not found');
    }
    const existing = rowToAdminUser(existingRes.rows[0]!);

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
      if (existing.role === 'admin' && patch.role !== 'admin') {
        await assertNotLastActiveAdminTx(client, id);
      }
      updates.push(`role = $${i++}`);
      values.push(patch.role);
    }

    if (updates.length === 0) {
      await client.query('COMMIT');
      return existing;
    }
    updates.push(`updated_at = NOW()`);
    values.push(id);

    const res = await client.query<UserRow>(
      `UPDATE users SET ${updates.join(', ')}
       WHERE id = $${i}
       RETURNING id, username, email, display_name, role, auth_provider,
                 deactivated_at, deactivated_by, deactivated_reason, created_at`,
      values,
    );
    if (res.rows.length === 0) {
      throw new AdminUserServiceError('NOT_FOUND', 'User not found');
    }
    await client.query('COMMIT');
    return rowToAdminUser(res.rows[0]!);
  } catch (err: unknown) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof AdminUserServiceError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    if (/duplicate key.*idx_users_email/i.test(msg)) {
      throw new AdminUserServiceError('EMAIL_TAKEN', 'Email already in use');
    }
    throw err;
  } finally {
    client.release();
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

  // Existence check, last-admin guard, soft-deactivate, and session-revoke
  // all run in the same transaction with a FOR UPDATE lock on the target +
  // the other admin rows (PR #311 Finding #2). Without the lock, two
  // concurrent "deactivate the other admin" calls could both pass the
  // precheck and leave the install with zero active admins.
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existingRes = await client.query<UserRow>(
      `${USER_SELECT} WHERE id = $1 FOR UPDATE`,
      [targetUserId],
    );
    if (existingRes.rows.length === 0) {
      throw new AdminUserServiceError('NOT_FOUND', 'User not found');
    }
    const existing = rowToAdminUser(existingRes.rows[0]!);
    if (existing.role === 'admin') {
      await assertNotLastActiveAdminTx(client, targetUserId);
    }
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

  // Existence check, last-admin guard, templates-reassignment and DELETE
  // all run in the same transaction with a FOR UPDATE lock on the target
  // (PR #311 Finding #2 — TOCTOU). The FK fix in migration 062 handles
  // audit_log / error_log / comments.resolved_by via ON DELETE SET NULL;
  // refresh_tokens and other back-references cascade. templates.created_by
  // is NOT NULL so we reassign those rows to the system-sentinel user
  // before the DELETE (PR #311 Finding #1).
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existingRes = await client.query<UserRow>(
      `${USER_SELECT} WHERE id = $1 FOR UPDATE`,
      [targetUserId],
    );
    if (existingRes.rows.length === 0) {
      throw new AdminUserServiceError('NOT_FOUND', 'User not found');
    }
    const existing = rowToAdminUser(existingRes.rows[0]!);
    if (existing.role === 'admin') {
      await assertNotLastActiveAdminTx(client, targetUserId);
    }

    // Reassign any templates authored by the target to the system sentinel
    // user (templates.created_by is NOT NULL and cannot use ON DELETE SET
    // NULL — see migration 032). The sentinel row is seeded by that
    // migration; re-assert it here so the reassignment is resilient to
    // test TRUNCATE, restored backups, etc.
    await client.query(
      `INSERT INTO users (id, username, password_hash, role)
         VALUES ($1, '__system__', 'nologin', 'admin')
         ON CONFLICT (id) DO NOTHING`,
      [SYSTEM_USER_ID],
    );
    await client.query(
      `UPDATE templates SET created_by = $2 WHERE created_by = $1`,
      [targetUserId, SYSTEM_USER_ID],
    );

    const res = await client.query(
      `DELETE FROM users WHERE id = $1`,
      [targetUserId],
    );
    if (res.rowCount === 0) {
      throw new AdminUserServiceError('NOT_FOUND', 'User not found');
    }
    await client.query('COMMIT');
    logger.info(
      { targetUserId, actor: opts.actorUserId },
      'admin-user-service: deleted user',
    );
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Well-known advisory-lock key shared by every call-site that mutates admin
 * membership (deactivate / delete / role-demote). Concurrent transactions
 * acquire this lock serially, so the subsequent "other admins exist"
 * SELECT is always compared against committed state.
 *
 * Value is arbitrary but must be stable and unique — we use a high bit-set
 * integer that does not clash with other advisory locks in the codebase.
 */
const ADMIN_GUARD_ADVISORY_LOCK = 20_304_001;

/**
 * Raise `LAST_ADMIN` if deactivating / deleting / demoting `targetUserId`
 * would leave the install without any active admin. Runs inside the
 * caller's transaction and takes a transaction-scoped advisory lock so
 * two concurrent "remove the other admin" operations serialise instead of
 * both passing a stale precheck — a pure row-level FOR UPDATE doesn't work
 * here because each caller's exclusion set (`id <> target`) is disjoint
 * (PR #311 Finding #2).
 *
 * The caller has already verified `targetUserId` is currently an admin and
 * holds a row-level lock on the target.
 */
async function assertNotLastActiveAdminTx(
  client: PoolClient,
  targetUserId: string,
): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock($1)', [
    ADMIN_GUARD_ADVISORY_LOCK,
  ]);
  // The system sentinel user (migration 032) has role='admin' so it owns
  // built-in templates, but it must not satisfy the "other active admin"
  // check — it cannot log in (`password_hash = 'nologin'`), so treating
  // it as a real admin would let the last real admin be deleted.
  const res = await client.query<{ id: string }>(
    `SELECT id
       FROM users
      WHERE role = 'admin'
        AND deactivated_at IS NULL
        AND id <> $1
        AND id <> $2`,
    [targetUserId, SYSTEM_USER_ID],
  );
  if (res.rows.length === 0) {
    throw new AdminUserServiceError(
      'LAST_ADMIN',
      'Cannot remove the last active admin — promote another admin first',
    );
  }
}
