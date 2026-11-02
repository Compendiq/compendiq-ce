import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPool, query } from '../db/postgres.js';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../test-db-helper.js';
import { createUser, deactivateUser, deleteUser, updateUser } from './admin-user-service.js';

const available = await isDbAvailable();
describe.skipIf(!available)('admin membership lock order', () => {
  beforeAll(async () => { await setupTestDb(); });
  beforeEach(async () => { await truncateAllTables(); });
  afterAll(async () => { await teardownTestDb(); });

  it.each(['deactivate', 'delete', 'demote'] as const)('%s waits for membership before locking its target', async (kind) => {
    const actor = (await createUser({ username: 'actor', role: 'admin', password: 'password1234' })).user;
    const target = (await createUser({ username: 'target', role: 'admin', password: 'password1234' })).user;
    const guard = await getPool().connect();
    let pending: Promise<unknown> | undefined;
    try {
      await guard.query('BEGIN');
      await guard.query('SELECT pg_advisory_xact_lock($1)', [20_304_001]);
      pending = kind === 'deactivate' ? deactivateUser(target.id, { actorUserId: actor.id })
        : kind === 'delete' ? deleteUser(target.id, { actorUserId: actor.id })
          : updateUser(target.id, { role: 'user' });
      await vi.waitFor(async () => {
        const waiting = await query(`SELECT 1 FROM pg_locks
          WHERE locktype = 'advisory' AND objid = 20304001 AND NOT granted`);
        expect(waiting.rowCount).toBeGreaterThan(0);
      });
      // The blocked contender must own no target row lock. Before the fix
      // this NOWAIT failed, exposing the FK/guard deadlock deterministically.
      await guard.query('SELECT id FROM users WHERE id = $1 FOR UPDATE NOWAIT', [target.id]);
      await guard.query('COMMIT');
      await pending;
    } finally {
      await guard.query('ROLLBACK');
      guard.release();
      await pending;
    }
  });
});
