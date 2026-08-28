import { setImmediate as nextEventLoopTurn } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { isDbAvailable } from '../../test-db-helper.js';
import { ATTACHMENT_SNAPSHOT_LOCK_ID } from '../db/advisory-locks.js';
import { getPool, query } from '../db/postgres.js';
import { withLocalAttachmentMutationLock } from './attachment-snapshot-lock.js';

const dbAvailable = await isDbAvailable();

async function waitForSharedWaiter(blockerPid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM pg_locks
          WHERE locktype = 'advisory'
            AND mode = 'ShareLock'
            AND NOT granted
            AND classid = 0
            AND objid = $1
            AND $2 = ANY(pg_blocking_pids(pid))
       ) AS waiting`,
      [ATTACHMENT_SNAPSHOT_LOCK_ID, blockerPid],
    );
    if (result.rows[0]?.waiting) return true;
    await nextEventLoopTurn();
  }
  return false;
}

describe.skipIf(!dbAvailable)('local attachment mutation snapshot lock', () => {
  it('waits behind an exclusive holder and passes the shared-lock-owning client', async () => {
    const holder = await getPool().connect();
    await holder.query('SET statement_timeout = 0');
    await holder.query('SELECT pg_advisory_lock($1)', [ATTACHMENT_SNAPSHOT_LOCK_ID]);
    const blockerPid = await holder
      .query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      .then((result) => result.rows[0]!.pid);
    let holderUnlocked = false;
    let operationEntered = false;

    const mutation = withLocalAttachmentMutationLock(async (client) => {
      operationEntered = true;
      const result = await client.query<{ owns_shared_lock: boolean }>(
        `SELECT EXISTS (
           SELECT 1
             FROM pg_locks
            WHERE locktype = 'advisory'
              AND pid = pg_backend_pid()
              AND mode = 'ShareLock'
              AND granted
              AND classid = 0
              AND objid = $1
         ) AS owns_shared_lock`,
        [ATTACHMENT_SNAPSHOT_LOCK_ID],
      );
      return result.rows[0]?.owns_shared_lock ?? false;
    });

    try {
      const sharedLockWaited = await waitForSharedWaiter(blockerPid);
      const enteredWhileExclusive = operationEntered;
      await holder.query('SELECT pg_advisory_unlock($1)', [ATTACHMENT_SNAPSHOT_LOCK_ID]);
      holderUnlocked = true;
      const operationOwnedSharedLock = await mutation;

      expect(sharedLockWaited).toBe(true);
      expect(enteredWhileExclusive).toBe(false);
      expect(operationOwnedSharedLock).toBe(true);
    } finally {
      if (!holderUnlocked) {
        await holder
          .query('SELECT pg_advisory_unlock($1)', [ATTACHMENT_SNAPSHOT_LOCK_ID])
          .catch(() => undefined);
      }
      await holder.query('RESET statement_timeout').catch(() => undefined);
      holder.release();
    }
  });
});
