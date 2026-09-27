import type { PoolClient } from 'pg';
import { getPool } from '../db/postgres.js';
import {
  getEffectiveRegistrationPolicy,
  realAdminExists,
} from './registration-policy-service.js';

export interface CreatedLocalUser {
  id: string;
  username: string;
  role: 'admin' | 'user';
  email: string | null;
  display_name: string | null;
}

export interface RegistrationUserInput {
  username: string;
  passwordHash: string;
  email: string | null;
  displayName: string | null;
}

export type RegistrationUserResult =
  | { kind: 'created'; user: CreatedLocalUser }
  | { kind: 'registration_disabled' };

/**
 * Serialize every writer that can end the no-real-admin bootstrap window.
 *
 * SHARE ROW EXCLUSIVE conflicts with the ROW EXCLUSIVE lock taken by INSERT,
 * UPDATE, and DELETE. Both public bootstrap routes therefore make their policy
 * decision and user/settings writes in one transaction, and unrelated user
 * mutations cannot cross that decision. Password hashing happens before this
 * short critical section.
 */
async function withSerializedUserBootstrap<T>(
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  let transactionStarted = false;

  try {
    await client.query('BEGIN');
    transactionStarted = true;
    await client.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
    const result = await work(client);
    await client.query('COMMIT');
    transactionStarted = false;
    return result;
  } catch (err) {
    if (transactionStarted) {
      await client.query('ROLLBACK').catch(() => undefined);
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Create a self-registered account under the definitive registration policy.
 * The policy is re-evaluated while holding the shared bootstrap lock because a
 * setup request can create the first admin after the route's cheap preflight.
 */
export async function createRegistrationUser(
  input: RegistrationUserInput,
): Promise<RegistrationUserResult> {
  return withSerializedUserBootstrap(async (client) => {
    const policy = await getEffectiveRegistrationPolicy(client);
    if (!policy.allowRegistration) {
      return { kind: 'registration_disabled' };
    }

    const role = policy.bootstrap ? 'admin' : 'user';
    const result = await client.query<CreatedLocalUser>(
      `INSERT INTO users (username, password_hash, role, email, display_name)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, username, role, email, display_name`,
      [input.username, input.passwordHash, role, input.email, input.displayName],
    );
    const user = result.rows[0]!;

    await client.query('INSERT INTO user_settings (user_id) VALUES ($1)', [user.id]);
    return { kind: 'created', user };
  });
}

/**
 * Create the setup wizard's initial administrator under the same lock and the
 * same real-admin definition used by registration. A null result means another
 * request already completed bootstrap.
 */
export async function createSetupAdministrator(
  username: string,
  passwordHash: string,
): Promise<CreatedLocalUser | null> {
  return withSerializedUserBootstrap(async (client) => {
    if (await realAdminExists(client)) {
      return null;
    }

    const result = await client.query<CreatedLocalUser>(
      `INSERT INTO users (username, password_hash, role)
       VALUES ($1, $2, 'admin')
       RETURNING id, username, role, email, display_name`,
      [username, passwordHash],
    );
    const user = result.rows[0]!;

    await client.query('INSERT INTO user_settings (user_id) VALUES ($1)', [user.id]);
    return user;
  });
}
