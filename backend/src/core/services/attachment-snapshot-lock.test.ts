import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  waitForDatabaseCondition,
} from '../../test-db-helper.js';
import { ATTACHMENT_SNAPSHOT_LOCK_ID } from '../db/advisory-locks.js';
import { getPool, query } from '../db/postgres.js';
import { withLocalAttachmentMutationLock } from './attachment-snapshot-lock.js';
import { deletePageIconImage } from './page-icon-store.js';

const dbAvailable = await isDbAvailable();

async function waitForSharedWaiter(blockerPid: number): Promise<boolean> {
  return waitForDatabaseCondition(async () => {
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
    return result.rows[0]?.waiting === true;
  });
}

describe.skipIf(!dbAvailable)('local attachment mutation snapshot lock', () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

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

  it('reuses a caller-owned shared-lock client without acquiring a nested session', async () => {
    const client = await getPool().connect();
    await client.query('SELECT pg_advisory_lock_shared($1)', [ATTACHMENT_SNAPSHOT_LOCK_ID]);
    try {
      const received = await withLocalAttachmentMutationLock(
        async (lockedClient) => lockedClient,
        client,
      );

      expect(received).toBe(client);
    } finally {
      await client.query('SELECT pg_advisory_unlock_shared($1)', [ATTACHMENT_SNAPSHOT_LOCK_ID]);
      client.release();
    }
  });

  it('holds direct page-icon deletion behind the backup snapshot barrier', async () => {
    const tempBase = await fs.mkdtemp(path.join(os.tmpdir(), 'compendiq-page-icon-lock-'));
    const originalAttachmentsDir = process.env.ATTACHMENTS_DIR;
    process.env.ATTACHMENTS_DIR = tempBase;
    const suffix = randomUUID();
    const user = await query<{ id: string }>(
      `INSERT INTO users (username, email, password_hash, role)
       VALUES ($1, $2, 'x', 'user') RETURNING id`,
      [`icon-lock-${suffix}`, `icon-lock-${suffix}@test.invalid`],
    );
    const page = await query<{ id: number }>(
      `INSERT INTO pages
         (title, body_html, body_text, version, source, created_by_user_id, visibility)
       VALUES ('Icon lock', '<p>x</p>', 'x', 1, 'standalone', $1, 'private')
       RETURNING id`,
      [user.rows[0]!.id],
    );
    const pageId = page.rows[0]!.id;
    const iconDir = path.join(tempBase, 'page-icons', String(pageId));
    await fs.mkdir(iconDir, { recursive: true });
    const sha256 = 'a'.repeat(64);
    await fs.writeFile(path.join(iconDir, `${sha256}.png`), 'old');
    const unrelatedPath = path.join(iconDir, 'unrelated-retained-byte.bin');
    await fs.writeFile(unrelatedPath, 'retain');

    const holder = await getPool().connect();
    await holder.query('SET statement_timeout = 0');
    await holder.query('SELECT pg_advisory_lock($1)', [ATTACHMENT_SNAPSHOT_LOCK_ID]);
    const blockerPid = await holder
      .query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      .then((result) => result.rows[0]!.pid);
    let holderUnlocked = false;
    const deletion = withLocalAttachmentMutationLock((client) =>
      deletePageIconImage(pageId, sha256, client));

    try {
      const sharedLockWaited = await waitForSharedWaiter(blockerPid);
      const iconStillExists = await fs.stat(iconDir).then(
        () => true,
        () => false,
      );
      await holder.query('SELECT pg_advisory_unlock($1)', [ATTACHMENT_SNAPSHOT_LOCK_ID]);
      holderUnlocked = true;
      await deletion;

      expect(sharedLockWaited).toBe(true);
      expect(iconStillExists).toBe(true);
      await expect(fs.stat(path.join(iconDir, `${sha256}.png`))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(fs.readFile(unrelatedPath, 'utf8')).resolves.toBe('retain');
    } finally {
      if (!holderUnlocked) {
        await holder
          .query('SELECT pg_advisory_unlock($1)', [ATTACHMENT_SNAPSHOT_LOCK_ID])
          .catch(() => undefined);
      }
      await deletion.catch(() => undefined);
      await holder.query('RESET statement_timeout').catch(() => undefined);
      holder.release();
      await fs.rm(tempBase, { recursive: true, force: true });
      await query('DELETE FROM pages WHERE id = $1', [pageId]).catch(() => undefined);
      await query('DELETE FROM users WHERE id = $1', [user.rows[0]!.id]).catch(() => undefined);
      if (originalAttachmentsDir === undefined) {
        delete process.env.ATTACHMENTS_DIR;
      } else {
        process.env.ATTACHMENTS_DIR = originalAttachmentsDir;
      }
    }
  });
});
