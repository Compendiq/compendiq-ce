import { setImmediate } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
} from '../../../test-db-helper.js';
import { NOTION_IMPORT_LOCK_KEY } from '../../../core/db/advisory-locks.js';
import { getPool, query } from '../../../core/db/postgres.js';
import {
  notionImportLockId,
  withNotionImportLock,
  withNotionImportLocks,
} from './notion-import-lock.js';

const dbAvailable = await isDbAvailable();

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  const result = Promise.withResolvers<void>();
  return { promise: result.promise, resolve: () => result.resolve() };
}

describe('notion import lock IDs', () => {
  it('maps dashed, undashed, and differently-cased forms of one Notion page ID to the same key', () => {
    const dashed = 'A1B2C3D4-E5F6-47A8-90BC-DEF123456789';
    const undashed = 'a1b2c3d4e5f647a890bcdef123456789';

    expect(notionImportLockId(dashed)).toBe(notionImportLockId(undashed));
  });
});

describe.skipIf(!dbAvailable)('withNotionImportLock', () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  it('allows different page IDs to proceed independently', async () => {
    const releaseFirst = deferred();
    const firstEntered = deferred();
    const secondEntered = deferred();

    const first = withNotionImportLock('11111111-1111-4111-8111-111111111111', async () => {
      firstEntered.resolve();
      await releaseFirst.promise;
    });
    await firstEntered.promise;

    const second = withNotionImportLock('22222222-2222-4222-8222-222222222222', async () => {
      secondEntered.resolve();
    });

    await secondEntered.promise;
    releaseFirst.resolve();
    await Promise.all([first, second]);
  });

  it('serializes operations for normalized forms of the same page ID', async () => {
    const releaseFirst = deferred();
    const firstEntered = deferred();
    let secondEntered = false;

    const first = withNotionImportLock('A1B2C3D4-E5F6-47A8-90BC-DEF123456789', async () => {
      firstEntered.resolve();
      await releaseFirst.promise;
    });
    await firstEntered.promise;

    const second = withNotionImportLock('a1b2c3d4e5f647a890bcdef123456789', async () => {
      secondEntered = true;
    });
    await setImmediate();

    expect(secondEntered).toBe(false);
    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(secondEntered).toBe(true);
  });

  it('holds a normalized, deduplicated batch on one PostgreSQL session', async () => {
    const dashed = 'A1B2C3D4-E5F6-47A8-90BC-DEF123456789';
    const undashed = 'a1b2c3d4e5f647a890bcdef123456789';
    const other = '22222222-2222-4222-8222-222222222222';
    const lockIds = [notionImportLockId(dashed), notionImportLockId(other)].map((id) => id >>> 0);

    await withNotionImportLocks([dashed, undashed, other, other], async () => {
      const held = await query<{ pid: number; lock_id: string }>(
        `SELECT pid, objid::bigint::text AS lock_id
           FROM pg_locks
          WHERE locktype = 'advisory'
            AND classid::bigint = $1
            AND objid::bigint = ANY($2::bigint[])
            AND granted = TRUE`,
        [NOTION_IMPORT_LOCK_KEY, lockIds],
      );

      expect(held.rows).toHaveLength(2);
      expect(new Set(held.rows.map((row) => row.pid)).size).toBe(1);
      expect(new Set(held.rows.map((row) => Number(row.lock_id)))).toEqual(new Set(lockIds));
    });

    const leftover = await query(
      `SELECT 1
         FROM pg_locks
        WHERE locktype = 'advisory'
          AND classid::bigint = $1
          AND objid::bigint = ANY($2::bigint[])
          AND granted = TRUE`,
      [NOTION_IMPORT_LOCK_KEY, lockIds],
    );
    expect(leftover.rows).toHaveLength(0);
  });

  it('does not deadlock overlapping batches supplied in reverse order', async () => {
    const firstId = '11111111-1111-4111-8111-111111111111';
    const secondId = '22222222-2222-4222-8222-222222222222';
    const orderedLockIds = [notionImportLockId(firstId), notionImportLockId(secondId)]
      .sort((left, right) => left - right);
    const [lowLockId, highLockId] = orderedLockIds;
    const lowHolder = await getPool().connect();
    const highHolder = await getPool().connect();
    const entries: string[] = [];
    let lowHeld = false;
    let highHeld = false;
    let forward: Promise<void> | undefined;
    let reverse: Promise<void> | undefined;

    try {
      await lowHolder.query('SELECT pg_advisory_lock($1, $2)', [
        NOTION_IMPORT_LOCK_KEY,
        lowLockId,
      ]);
      lowHeld = true;
      await highHolder.query('SELECT pg_advisory_lock($1, $2)', [
        NOTION_IMPORT_LOCK_KEY,
        highLockId,
      ]);
      highHeld = true;

      forward = withNotionImportLocks([firstId, secondId], async () => {
        entries.push('forward');
      });
      reverse = withNotionImportLocks([secondId, firstId], async () => {
        entries.push('reverse');
      });

      let lowWaiters = 0;
      for (let attempt = 0; attempt < 100 && lowWaiters !== 2; attempt += 1) {
        const waiting = await query<{ count: string }>(
          `SELECT count(*)::text AS count
             FROM pg_locks
            WHERE locktype = 'advisory'
              AND classid::bigint = $1
              AND objid::bigint = $2
              AND granted = FALSE`,
          [NOTION_IMPORT_LOCK_KEY, lowLockId! >>> 0],
        );
        lowWaiters = Number(waiting.rows[0]!.count);
        if (lowWaiters !== 2) await setImmediate();
      }
      expect(lowWaiters).toBe(2);

      await lowHolder.query('SELECT pg_advisory_unlock($1, $2)', [
        NOTION_IMPORT_LOCK_KEY,
        lowLockId,
      ]);
      lowHeld = false;

      let highWaiters = 0;
      for (let attempt = 0; attempt < 100 && highWaiters !== 1; attempt += 1) {
        const waiting = await query<{ count: string }>(
          `SELECT count(*)::text AS count
             FROM pg_locks
            WHERE locktype = 'advisory'
              AND classid::bigint = $1
              AND objid::bigint = $2
              AND granted = FALSE`,
          [NOTION_IMPORT_LOCK_KEY, highLockId! >>> 0],
        );
        highWaiters = Number(waiting.rows[0]!.count);
        if (highWaiters !== 1) await setImmediate();
      }
      expect(highWaiters).toBe(1);

      await highHolder.query('SELECT pg_advisory_unlock($1, $2)', [
        NOTION_IMPORT_LOCK_KEY,
        highLockId,
      ]);
      highHeld = false;

      await Promise.all([forward, reverse]);
      expect(entries.sort()).toEqual(['forward', 'reverse']);
    } finally {
      if (lowHeld) {
        await lowHolder.query('SELECT pg_advisory_unlock($1, $2)', [
          NOTION_IMPORT_LOCK_KEY,
          lowLockId,
        ]);
      }
      if (highHeld) {
        await highHolder.query('SELECT pg_advisory_unlock($1, $2)', [
          NOTION_IMPORT_LOCK_KEY,
          highLockId,
        ]);
      }
      lowHolder.release();
      highHolder.release();
      await Promise.allSettled([forward, reverse].filter((run): run is Promise<void> => Boolean(run)));
    }
  });
});
