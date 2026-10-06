import type { PoolClient } from 'pg';
import { query } from '../db/postgres.js';

/**
 * Whether the Confluence integration is switched on for a user (#1623).
 *
 * Off means standalone mode: every feature keeps working, nothing syncs to or
 * from Confluence. `user_settings.confluence_enabled` is `NOT NULL DEFAULT
 * TRUE`, so the only unknown is a user with no settings row at all — nothing
 * has been switched off there, so the integration counts as on.
 *
 * This is the single source of truth for the toggle on the backend: callers
 * that keep working locally must distinguish "integration off" from "not
 * configured" here rather than inferring it from a null client.
 * Supply the current transaction client to avoid a second pool lease.
 * Admission callers explicitly request a settings-row lock through commit;
 * metadata callers also use transaction clients, including read-only ones.
 * A missing row remains enabled and cannot be an eligible explicit-off state.
 */
export async function isConfluenceEnabled(
  userId: string,
  dbClient?: PoolClient,
  lockSettings = false,
): Promise<boolean> {
  if (lockSettings && !dbClient) {
    throw new Error('Locking Confluence settings requires a transaction client');
  }
  const statement = `SELECT confluence_enabled
                       FROM user_settings
                      WHERE user_id = $1${lockSettings ? ' FOR SHARE' : ''}`;
  const result = dbClient
    ? await dbClient.query<{ confluence_enabled: boolean }>(statement, [userId])
    : await query<{ confluence_enabled: boolean }>(statement, [userId]);
  return result.rows[0]?.confluence_enabled !== false;
}
