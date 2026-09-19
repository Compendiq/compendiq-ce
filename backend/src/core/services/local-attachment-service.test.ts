import { createHash, randomUUID } from 'node:crypto';
import { setImmediate as nextEventLoopTurn } from 'node:timers/promises';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../test-db-helper.js';
import { getPool, query } from '../db/postgres.js';
import { ATTACHMENT_SNAPSHOT_LOCK_ID } from '../db/advisory-locks.js';
import {
  canStoreLocalFilename,
  putLocalAttachment,
  putLocalAttachments,
  getLocalAttachment,
  listLocalAttachments,
  removeLocalAttachmentDirectory,
  removeLocalAttachmentFileForSweep,
  removeLocalAttachmentFilesForRelocate,
  writeLocalAttachmentFileForRelocate,
  MAX_LOCAL_ATTACHMENT_BYTES,
} from './local-attachment-service.js';
import { exportPostgresSnapshot } from './backup-service.js';
import {
  advancePageWriteIntent,
  fencePageWriterRuntime,
  reconcilePageWriteIntent,
  reservePageWriteIntent,
  runPageWriteIntentEffect,
} from './page-write-admission.js';
import { PAGE_ICON_STORE_DIRNAME } from './page-icon-store.js';

const dbAvailable = await isDbAvailable();
const EXPECTED_ATTACHMENT_SNAPSHOT_LOCK_ID = 1_420_001;

// Override ATTACHMENTS_DIR to a temp dir so repeated test runs don't
// inherit cruft from previous invocations.
let tempBase = '';
const originalAttachmentsDir = process.env.ATTACHMENTS_DIR;

describe('local attachment filename portability', () => {
  it('rejects backslashes instead of storing a database filename with another restore path', () => {
    expect(canStoreLocalFilename(String.raw`diagram\final.png`)).toBe(false);
  });
});

describe.skipIf(!dbAvailable)('local-attachment-service (#302 Gap 4)', () => {
  beforeAll(async () => {
    await setupTestDb();
    tempBase = await fs.mkdtemp(path.join(os.tmpdir(), 'compendiq-local-attachments-'));
    process.env.ATTACHMENTS_DIR = tempBase;
  });
  afterAll(async () => {
    await teardownTestDb();
    await fs.rm(tempBase, { recursive: true, force: true });
    if (originalAttachmentsDir) {
      process.env.ATTACHMENTS_DIR = originalAttachmentsDir;
    } else {
      delete process.env.ATTACHMENTS_DIR;
    }
  });
  beforeEach(async () => {
    await truncateAllTables();
  });

  async function seedUserAndPage(opts?: { visibility?: 'private' | 'shared' }): Promise<{ userId: string; pageId: number }> {
    const u = await query<{ id: string }>(
      `INSERT INTO users (username, password_hash, role)
       VALUES ($1, 'hash', 'user')
       RETURNING id`,
      [`attachment-owner-${randomUUID()}`],
    );
    const userId = u.rows[0]!.id;
    const p = await query<{ id: number }>(
      `INSERT INTO pages (space_key, title, body_html, body_text, version, source, visibility,
                          created_by_user_id, embedding_dirty, embedding_status)
       VALUES ('LOCAL', 'Test', '<p>hello</p>', 'hello', 1, 'standalone', $1, $2, FALSE, 'not_embedded')
       RETURNING id`,
      [opts?.visibility ?? 'private', userId],
    );
    return { userId, pageId: p.rows[0]!.id };
  }

  async function waitForSharedLockWaiter(blockerPid: number): Promise<boolean> {
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
        [EXPECTED_ATTACHMENT_SNAPSHOT_LOCK_ID, blockerPid],
      );
      if (result.rows[0]?.waiting) return true;
      await nextEventLoopTurn();
    }
    return false;
  }

  it('migration creates local_attachments with the expected shape', async () => {
    const cols = await query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'local_attachments'
        ORDER BY column_name`,
    );
    expect(cols.rows.map((r) => r.column_name)).toEqual(
      expect.arrayContaining([
        'content_type', 'created_at', 'created_by', 'filename', 'id',
        'page_id', 'sha256', 'size_bytes', 'updated_at',
      ]),
    );
  });

  it('putLocalAttachment writes the file + row and returns a record', async () => {
    const { userId, pageId } = await seedUserAndPage();
    const rec = await putLocalAttachment({
      pageId,
      filename: 'diagram.png',
      contentType: 'image/png',
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xde, 0xad, 0xbe, 0xef]),
      userId,
    });

    expect(rec.filename).toBe('diagram.png');
    expect(rec.contentType).toBe('image/png');
    expect(rec.sizeBytes).toBe(8);
    expect(rec.sha256).toHaveLength(64);
    expect(rec.createdBy).toBe(userId);

    const row = await query<{ size_bytes: string }>(
      `SELECT size_bytes FROM local_attachments WHERE page_id = $1`,
      [pageId],
    );
    expect(row.rows).toHaveLength(1);
    const revision = await query<{ content_revision: string }>(
      'SELECT content_revision::text FROM pages WHERE id = $1',
      [pageId],
    );
    expect(revision.rows[0]?.content_revision).toBe('1');
  });

  it('rejects an invalid sibling before publishing either attachment', async () => {
    const { userId, pageId } = await seedUserAndPage();
    const stem = 'a'.repeat(251);
    const filename = `${stem}.png`;
    await expect(putLocalAttachments({
      pageId,
      userId,
      attachments: [
        { filename, contentType: 'image/png', data: Buffer.from('png') },
        { filename: `${stem}.drawio`, contentType: 'application/xml', data: Buffer.from('<mxfile/>') },
      ],
    })).rejects.toMatchObject({ code: 'INVALID_FILENAME' });
    expect(await listLocalAttachments(pageId, userId)).toEqual([]);
    await expect(fs.access(path.join(tempBase, 'local', String(pageId), filename)))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('upsert on (page_id, filename) replaces the content and bumps updated_at', async () => {
    const { userId, pageId } = await seedUserAndPage();
    const first = await putLocalAttachment({
      pageId,
      filename: 'diagram.png',
      contentType: 'image/png',
      data: Buffer.from([0x89, 0x50]),
      userId,
    });
    await new Promise((r) => setTimeout(r, 5));
    const second = await putLocalAttachment({
      pageId,
      filename: 'diagram.png',
      contentType: 'image/png',
      data: Buffer.from([0x01, 0x02, 0x03]),
      userId,
    });

    expect(second.sizeBytes).toBe(3);
    expect(second.sha256).not.toBe(first.sha256);
    expect(second.id).toBe(first.id); // same row, upserted
  });

  it('getLocalAttachment returns bytes + record for the owner', async () => {
    const { userId, pageId } = await seedUserAndPage();
    const data = Buffer.from('hello world');
    await putLocalAttachment({
      pageId, filename: 'note.txt', contentType: 'text/plain', data, userId,
    });
    const got = await getLocalAttachment(pageId, 'note.txt', userId);
    expect(got.data.toString()).toBe('hello world');
    expect(got.record.contentType).toBe('text/plain');
  });

  it('listLocalAttachments returns all filenames sorted', async () => {
    const { userId, pageId } = await seedUserAndPage();
    for (const f of ['zebra.png', 'apple.png', 'mango.png']) {
      await putLocalAttachment({
        pageId, filename: f, contentType: 'image/png', data: Buffer.from([0x89]), userId,
      });
    }
    const list = await listLocalAttachments(pageId, userId);
    expect(list.map((r) => r.filename)).toEqual(['apple.png', 'mango.png', 'zebra.png']);
  });

  it('rejects access from non-owner on a private page', async () => {
    const { pageId } = await seedUserAndPage({ visibility: 'private' });
    const stranger = await query<{ id: string }>(
      `INSERT INTO users (username, password_hash, role) VALUES ('stranger', 'h', 'user') RETURNING id`,
    );
    await expect(
      putLocalAttachment({
        pageId, filename: 'x.png', contentType: 'image/png',
        data: Buffer.from([0x89]), userId: stranger.rows[0]!.id,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('allows non-owner access on a shared page', async () => {
    const { pageId } = await seedUserAndPage({ visibility: 'shared' });
    const other = await query<{ id: string }>(
      `INSERT INTO users (username, password_hash, role) VALUES ('other', 'h', 'user') RETURNING id`,
    );
    const rec = await putLocalAttachment({
      pageId, filename: 'y.png', contentType: 'image/png',
      data: Buffer.from([0x89]), userId: other.rows[0]!.id,
    });
    expect(rec.createdBy).toBe(other.rows[0]!.id);
  });

  it('rejects writes to a Confluence-backed page (forces the Confluence route)', async () => {
    const u = await query<{ id: string }>(
      `INSERT INTO users (username, password_hash, role) VALUES ('bob', 'h', 'user') RETURNING id`,
    );
    const p = await query<{ id: number }>(
      `INSERT INTO pages (confluence_id, space_key, title, body_html, body_text, version,
                          source, embedding_dirty, embedding_status)
       VALUES ('conf-1', 'ENG', 'Confluence page', '', '', 1, 'confluence', FALSE, 'not_embedded')
       RETURNING id`,
    );
    await expect(
      putLocalAttachment({
        pageId: p.rows[0]!.id, filename: 'z.png', contentType: 'image/png',
        data: Buffer.from([0x89]), userId: u.rows[0]!.id,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects trashed pages with PAGE_NOT_FOUND', async () => {
    const { userId, pageId } = await seedUserAndPage();
    await query(`UPDATE pages SET deleted_at = NOW() WHERE id = $1`, [pageId]);
    await expect(
      putLocalAttachment({
        pageId, filename: 'x.png', contentType: 'image/png',
        data: Buffer.from([0x89]), userId,
      }),
    ).rejects.toMatchObject({ code: 'PAGE_NOT_FOUND' });
  });

  it('rejects oversized payloads with TOO_LARGE', async () => {
    const { userId, pageId } = await seedUserAndPage();
    const tooBig = Buffer.alloc(MAX_LOCAL_ATTACHMENT_BYTES + 1);
    await expect(
      putLocalAttachment({
        pageId, filename: 'big.bin', contentType: 'application/octet-stream', data: tooBig, userId,
      }),
    ).rejects.toMatchObject({ code: 'TOO_LARGE' });
  });

  it('rejects hidden / path-traversal filenames', async () => {
    const { userId, pageId } = await seedUserAndPage();
    await expect(
      putLocalAttachment({
        pageId, filename: '.secret', contentType: 'text/plain',
        data: Buffer.from('x'), userId,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_FILENAME' });
  });

  it('returns NOT_FOUND when the DB row exists but the file is missing', async () => {
    const { userId, pageId } = await seedUserAndPage();
    await putLocalAttachment({
      pageId, filename: 'ephemeral.png', contentType: 'image/png',
      data: Buffer.from([0x89]), userId,
    });
    // Manually remove the file to simulate storage drift.
    const filePath = path.join(tempBase, 'local', String(pageId), 'ephemeral.png');
    await fs.unlink(filePath);
    await expect(
      getLocalAttachment(pageId, 'ephemeral.png', userId),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('ON DELETE CASCADE wipes attachments when the page is deleted', async () => {
    const { userId, pageId } = await seedUserAndPage();
    await putLocalAttachment({
      pageId, filename: 'tied.png', contentType: 'image/png',
      data: Buffer.from([0x89]), userId,
    });
    await query(`DELETE FROM pages WHERE id = $1`, [pageId]);
    const res = await query(`SELECT COUNT(*) FROM local_attachments WHERE page_id = $1`, [pageId]);
    expect(Number((res.rows[0] as { count: string }).count)).toBe(0);
  });

  // #1169 review — the staging cleanup a rolled-back relocate depends on.
  //
  // A Confluence→local move writes these bytes BEFORE the transaction that
  // inserts their `local_attachments` rows, so a rollback would otherwise leave
  // files nothing references, one set per failed attempt.
  describe('removeLocalAttachmentFilesForRelocate', () => {
    async function staged(pageId: number): Promise<string[]> {
      try {
        return (await fs.readdir(path.join(tempBase, 'local', String(pageId)))).sort();
      } catch {
        return [];
      }
    }

    it('removes exactly the filenames it is given, and nothing else', async () => {
      const { pageId } = await seedUserAndPage();
      for (const name of ['a.png', 'b.png', 'keep.png']) {
        await writeLocalAttachmentFileForRelocate(pageId, name, Buffer.from([0x89]));
      }

      await removeLocalAttachmentFilesForRelocate(pageId, ['a.png', 'b.png']);

      // `keep.png` stands in for a file some other writer owns: removing the
      // whole directory would be simpler and would take it with them.
      expect(await staged(pageId)).toEqual(['keep.png']);
    });

    it('is silent about a file that is already gone', async () => {
      const { pageId } = await seedUserAndPage();
      await writeLocalAttachmentFileForRelocate(pageId, 'once.png', Buffer.from([0x89]));

      // Called twice: the relocate paths can both fire on one failure, and the
      // caller is already unwinding — a throw here would lose the real error.
      await removeLocalAttachmentFilesForRelocate(pageId, ['once.png']);
      await expect(
        removeLocalAttachmentFilesForRelocate(pageId, ['once.png', 'never-existed.png']),
      ).resolves.toBeUndefined();
      expect(await staged(pageId)).toEqual([]);
    });

    it('refuses to act on a filename the store could not have written', async () => {
      const { pageId } = await seedUserAndPage();
      await writeLocalAttachmentFileForRelocate(pageId, 'real.png', Buffer.from([0x89]));

      // A traversal attempt resolves to `real.png` under `basename`, which is
      // exactly the kind of accident this must not turn into a deletion.
      await removeLocalAttachmentFilesForRelocate(pageId, ['.hidden', '']);

      expect(await staged(pageId)).toEqual(['real.png']);
    });
  });
  describe('attachment snapshot barrier', () => {
    it('holds a same-name overwrite until archived bytes have been read, then commits matching metadata', async () => {
      const { userId, pageId } = await seedUserAndPage();
      const filename = 'snapshot-race.txt';
      const oldData = Buffer.from('archived-before-overwrite');
      const newData = Buffer.from('committed-after-backup');
      await putLocalAttachment({
        pageId,
        filename,
        contentType: 'text/plain',
        data: oldData,
        userId,
      });

      const snapshot = await exportPostgresSnapshot();
      const blockerPid = await snapshot.client
        .query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
        .then((result) => result.rows[0]!.pid);
      let overwriteSettled = false;
      const overwrite = putLocalAttachment({
        pageId,
        filename,
        contentType: 'text/plain',
        data: newData,
        userId,
      }).then((record) => {
        overwriteSettled = true;
        return record;
      });

      const sharedLockWaited = await waitForSharedLockWaiter(blockerPid);
      const settledBeforeArchiveRead = overwriteSettled;
      const archivedBytes = await fs.readFile(path.join(tempBase, 'local', String(pageId), filename));
      await snapshot.close();
      const record = await overwrite;
      const storedBytes = await fs.readFile(path.join(tempBase, 'local', String(pageId), filename));
      const row = await query<{ sha256: string }>(
        'SELECT sha256 FROM local_attachments WHERE page_id = $1 AND filename = $2',
        [pageId, filename],
      );

      expect(settledBeforeArchiveRead).toBe(false);
      expect(archivedBytes).toEqual(oldData);
      expect(storedBytes).toEqual(newData);
      expect(record.sha256).toBe(createHash('sha256').update(newData).digest('hex'));
      expect(row.rows[0]?.sha256).toBe(record.sha256);
      expect(sharedLockWaited).toBe(true);
    });

    it('runs file-adjacent SQL on the shared-lock-owning client', async () => {
      expect(ATTACHMENT_SNAPSHOT_LOCK_ID).toBe(EXPECTED_ATTACHMENT_SNAPSHOT_LOCK_ID);
      const { userId, pageId } = await seedUserAndPage();
      await query(`
        CREATE OR REPLACE FUNCTION test_require_attachment_snapshot_shared_lock()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1
              FROM pg_locks
             WHERE locktype = 'advisory'
               AND pid = pg_backend_pid()
               AND mode = 'ShareLock'
               AND granted
               AND classid = 0
               AND objid = ${EXPECTED_ATTACHMENT_SNAPSHOT_LOCK_ID}
          ) THEN
            RAISE EXCEPTION 'local_attachments SQL did not use the shared-lock client';
          END IF;
          RETURN NEW;
        END
        $$
      `);
      await query(`
        CREATE TRIGGER test_attachment_snapshot_shared_lock
        BEFORE INSERT OR UPDATE ON local_attachments
        FOR EACH ROW EXECUTE FUNCTION test_require_attachment_snapshot_shared_lock()
      `);
      await query(`
        CREATE TRIGGER test_page_snapshot_shared_lock
        BEFORE UPDATE OF image_analysis_dirty ON pages
        FOR EACH ROW EXECUTE FUNCTION test_require_attachment_snapshot_shared_lock()
      `);

      try {
        await expect(
          putLocalAttachment({
            pageId,
            filename: 'same-client.txt',
            contentType: 'text/plain',
            data: Buffer.from('same client'),
            userId,
          }),
        ).resolves.toMatchObject({ pageId, filename: 'same-client.txt' });
        const page = await query<{ image_analysis_dirty: boolean }>(
          'SELECT image_analysis_dirty FROM pages WHERE id = $1',
          [pageId],
        );
        expect(page.rows[0]?.image_analysis_dirty).toBe(true);
      } finally {
        await query('DROP TRIGGER IF EXISTS test_page_snapshot_shared_lock ON pages');
        await query('DROP TRIGGER IF EXISTS test_attachment_snapshot_shared_lock ON local_attachments');
        await query('DROP FUNCTION IF EXISTS test_require_attachment_snapshot_shared_lock()');
      }
    });

    it.each([
      {
        name: 'relocate write',
        arrange: async (pageId: number) => {
          await fs.mkdir(path.join(tempBase, 'local', String(pageId)), { recursive: true });
        },
        mutate: (pageId: number) =>
          writeLocalAttachmentFileForRelocate(pageId, 'relocate-write.txt', Buffer.from('new')),
        changed: async (pageId: number) =>
          fs.readFile(path.join(tempBase, 'local', String(pageId), 'relocate-write.txt'), 'utf8')
            .then(() => true)
            .catch(() => false),
      },
      {
        name: 'relocate remove',
        arrange: async (pageId: number) => {
          const dir = path.join(tempBase, 'local', String(pageId));
          await fs.mkdir(dir, { recursive: true });
          await fs.writeFile(path.join(dir, 'relocate-remove.txt'), 'old');
        },
        mutate: (pageId: number) =>
          removeLocalAttachmentFilesForRelocate(pageId, ['relocate-remove.txt']),
        changed: async (pageId: number) =>
          fs.readFile(path.join(tempBase, 'local', String(pageId), 'relocate-remove.txt'))
            .then(() => false)
            .catch(() => true),
      },
      {
        name: 'sweep removal',
        arrange: async (pageId: number) => {
          const dir = path.join(tempBase, 'local', String(pageId));
          await fs.mkdir(dir, { recursive: true });
          await fs.writeFile(path.join(dir, 'sweep-remove.txt'), 'old');
        },
        mutate: (pageId: number) =>
          removeLocalAttachmentFileForSweep(pageId, 'sweep-remove.txt'),
        changed: async (pageId: number) =>
          fs.readFile(path.join(tempBase, 'local', String(pageId), 'sweep-remove.txt'))
            .then(() => false)
            .catch(() => true),
      },
      {
        name: 'directory removal',
        arrange: async (pageId: number) => {
          const dir = path.join(tempBase, 'local', String(pageId));
          await fs.mkdir(dir, { recursive: true });
          await fs.writeFile(path.join(dir, 'directory-remove.txt'), 'old');
        },
        mutate: (pageId: number) => removeLocalAttachmentDirectory(pageId),
        changed: async (pageId: number) =>
          fs.stat(path.join(tempBase, 'local', String(pageId)))
            .then(() => false)
            .catch(() => true),
      },
    ])('holds $name behind the backup exclusive lock', async ({ arrange, mutate, changed }) => {
      const { pageId } = await seedUserAndPage();
      await arrange(pageId);
      const snapshot = await exportPostgresSnapshot();
      const blockerPid = await snapshot.client
        .query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
        .then((result) => result.rows[0]!.pid);
      let settled = false;
      const mutation = Promise.resolve(mutate(pageId)).then((result) => {
        settled = true;
        return result;
      });

      const sharedLockWaited = await waitForSharedLockWaiter(blockerPid);
      const settledWhileSnapshotOpen = settled;
      const changedWhileSnapshotOpen = await changed(pageId);
      await snapshot.close();
      await mutation;

      expect(settledWhileSnapshotOpen).toBe(false);
      expect(changedWhileSnapshotOpen).toBe(false);
      expect(await changed(pageId)).toBe(true);
      expect(sharedLockWaited).toBe(true);
    });
    it('keeps relocate cleanup best-effort when acquiring the snapshot lock fails', async () => {
      const connect = vi
        .spyOn(getPool(), 'connect')
        .mockRejectedValueOnce(new Error('snapshot lock connection failed'));

      try {
        await expect(
          removeLocalAttachmentFilesForRelocate(42, ['staged.png']),
        ).resolves.toBeUndefined();
      } finally {
        connect.mockRestore();
      }
    });
  });

  it('repairs staged and partial local effects while mismatched bytes remain pending', async () => {
    const appliedPage = await seedUserAndPage();
    const mismatchPage = await seedUserAndPage();
    const stagedPage = await seedUserAndPage();
    const partialPage = await seedUserAndPage();
    const deniedRepairPage = await seedUserAndPage();

    async function leaveAdvancedIntent(
      pageId: number,
      userId: string,
      filename: string,
      intended: Buffer,
      observed: Buffer,
    ) {
      const sha256 = createHash('sha256').update(intended).digest('hex');
      const intent = await reservePageWriteIntent({
        pageIds: [pageId],
        kind: 'attachment.local.put',
        actorId: userId,
        effect: {
          effectClass: 'local',
          pageId,
          files: [{
            filename,
            contentType: 'text/plain',
            stageIndex: 0,
            size: intended.length,
            sha256,
          }],
        },
      });
      await runPageWriteIntentEffect(intent, { kind: 'local' }, async () => {
        const dir = path.join(tempBase, 'local', String(pageId));
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, filename), observed);
      });
      await advancePageWriteIntent(intent, async (client) => {
        await client.query(
          `INSERT INTO local_attachments
             (page_id, filename, content_type, size_bytes, sha256, created_by)
           VALUES ($1, $2, 'text/plain', $3, $4, $5)`,
          [pageId, filename, intended.length, sha256, userId],
        );
        await client.query(
          'UPDATE pages SET content_revision = content_revision + 1 WHERE id = $1',
          [pageId],
        );
      });
      return intent;
    }
    async function leaveAdvancedIconIntent(
      pageId: number,
      userId: string,
      intended: Buffer,
      observed: Buffer,
    ) {
      const sha256 = createHash('sha256').update(intended).digest('hex');
      const intent = await reservePageWriteIntent({
        pageIds: [pageId],
        kind: 'icon.image.put',
        actorId: userId,
        effect: {
          effectClass: 'local',
          pageId,
          sha256,
          size: intended.length,
          format: 'png',
          expectsMetadata: true,
        },
      });
      await runPageWriteIntentEffect(intent, { kind: 'local' }, async () => {
        const dir = path.join(tempBase, PAGE_ICON_STORE_DIRNAME, String(pageId));
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, `${sha256}.png`), observed);
      });
      await advancePageWriteIntent(intent, async (client) => {
        await client.query(
          `UPDATE pages
              SET icon_kind = 'image', icon_value = $2,
                  content_revision = content_revision + 1
            WHERE id = $1`,
          [pageId, sha256],
        );
      });
      return intent;
    }

    const appliedIconPage = await seedUserAndPage();
    const mismatchIconPage = await seedUserAndPage();
    const stagedIconPage = await seedUserAndPage();
    const partialIconPage = await seedUserAndPage();
    const stagedAttachmentBytes = Buffer.from('staged attachment');
    const stagedAttachmentSha = createHash('sha256').update(stagedAttachmentBytes).digest('hex');
    const stagedAttachment = await reservePageWriteIntent({
      pageIds: [stagedPage.pageId],
      kind: 'attachment.local.put',
      actorId: stagedPage.userId,
      effect: {
        effectClass: 'local',
        pageId: stagedPage.pageId,
        files: [
          {
            filename: 'already-cleaned.txt',
            contentType: 'text/plain',
            stageIndex: 0,
            size: stagedAttachmentBytes.length,
            sha256: stagedAttachmentSha,
          },
          {
            filename: 'staged.txt',
            contentType: 'text/plain',
            stageIndex: 1,
            size: stagedAttachmentBytes.length,
            sha256: stagedAttachmentSha,
          },
        ],
      },
    });
    await runPageWriteIntentEffect(stagedAttachment, { kind: 'local' }, async () => {
      const dir = path.join(tempBase, 'local', String(stagedPage.pageId));
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, `.page-write-${stagedAttachment.id}-1.stage`),
        stagedAttachmentBytes,
      );
    });
    const stagedIconBytes = Buffer.from('staged icon');
    const stagedIconSha = createHash('sha256').update(stagedIconBytes).digest('hex');
    const stagedIcon = await reservePageWriteIntent({
      pageIds: [stagedIconPage.pageId],
      kind: 'icon.image.put',
      actorId: stagedIconPage.userId,
      effect: {
        effectClass: 'local',
        pageId: stagedIconPage.pageId,
        sha256: stagedIconSha,
        size: stagedIconBytes.length,
        format: 'png',
        expectsMetadata: true,
      },
    });
    await runPageWriteIntentEffect(stagedIcon, { kind: 'local' }, async () => {
      const dir = path.join(
        tempBase,
        PAGE_ICON_STORE_DIRNAME,
        '.staging',
        String(stagedIconPage.pageId),
      );
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, `${stagedIcon.id}.png.stage`), stagedIconBytes);
    });
    const partialFirst = Buffer.from('partial first');
    const partialSecond = Buffer.from('partial second');
    const partialAttachment = await reservePageWriteIntent({
      pageIds: [partialPage.pageId],
      kind: 'attachment.local.put',
      actorId: partialPage.userId,
      effect: {
        effectClass: 'local',
        pageId: partialPage.pageId,
        files: [
          {
            filename: 'first.txt',
            contentType: 'text/plain',
            stageIndex: 0,
            size: partialFirst.length,
            sha256: createHash('sha256').update(partialFirst).digest('hex'),
          },
          {
            filename: 'second.txt',
            contentType: 'text/plain',
            stageIndex: 1,
            size: partialSecond.length,
            sha256: createHash('sha256').update(partialSecond).digest('hex'),
          },
        ],
      },
    });
    await runPageWriteIntentEffect(partialAttachment, { kind: 'local' }, async () => {
      const dir = path.join(tempBase, 'local', String(partialPage.pageId));
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'first.txt'), partialFirst);
      await fs.writeFile(
        path.join(dir, `.page-write-${partialAttachment.id}-1.stage`),
        partialSecond,
      );
    });
    const partialIconBytes = Buffer.from('partial icon activation');
    const partialIconSha = createHash('sha256').update(partialIconBytes).digest('hex');
    const partialIcon = await reservePageWriteIntent({
      pageIds: [partialIconPage.pageId],
      kind: 'icon.image.put',
      actorId: partialIconPage.userId,
      effect: {
        effectClass: 'local',
        pageId: partialIconPage.pageId,
        sha256: partialIconSha,
        size: partialIconBytes.length,
        format: 'png',
        expectsMetadata: true,
      },
    });
    await runPageWriteIntentEffect(partialIcon, { kind: 'local' }, async () => {
      const dir = path.join(
        tempBase,
        PAGE_ICON_STORE_DIRNAME,
        '.staging',
        String(partialIconPage.pageId),
      );
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, `${partialIcon.id}.png.stage`), partialIconBytes);
      await fs.writeFile(path.join(dir, `${partialIcon.id}.activating`), 'activating');
    });
    const deniedBytes = Buffer.from('denied after activation');
    const deniedRepair = await reservePageWriteIntent({
      pageIds: [deniedRepairPage.pageId],
      kind: 'attachment.local.put',
      actorId: deniedRepairPage.userId,
      effect: {
        effectClass: 'local',
        pageId: deniedRepairPage.pageId,
        files: [{
          filename: 'denied.txt',
          contentType: 'text/plain',
          stageIndex: 0,
          size: deniedBytes.length,
          sha256: createHash('sha256').update(deniedBytes).digest('hex'),
        }],
      },
    });
    await runPageWriteIntentEffect(deniedRepair, { kind: 'local' }, async () => {
      const dir = path.join(tempBase, 'local', String(deniedRepairPage.pageId));
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'denied.txt'), deniedBytes);
    });
    await query('UPDATE users SET deactivated_at = NOW() WHERE id = $1', [
      deniedRepairPage.userId,
    ]);
    const appliedIcon = await leaveAdvancedIconIntent(
      appliedIconPage.pageId,
      appliedIconPage.userId,
      Buffer.from('exact icon bytes'),
      Buffer.from('exact icon bytes'),
    );
    const mismatchIcon = await leaveAdvancedIconIntent(
      mismatchIconPage.pageId,
      mismatchIconPage.userId,
      Buffer.from('intended icon'),
      Buffer.from('corrupt icon'),
    );

    const applied = await leaveAdvancedIntent(
      appliedPage.pageId,
      appliedPage.userId,
      'applied.txt',
      Buffer.from('exact recovered bytes'),
      Buffer.from('exact recovered bytes'),
    );
    const mismatch = await leaveAdvancedIntent(
      mismatchPage.pageId,
      mismatchPage.userId,
      'mismatch.txt',
      Buffer.from('intended bytes'),
      Buffer.from('different bytes'),
    );
    const oldRuntimeId = randomUUID();
    const acknowledgmentId = randomUUID();
    await query(
      `INSERT INTO page_writer_runtimes
         (runtime_id, deployment_identity, quiesced_at, quiescence_ack)
       VALUES ($1, $2::jsonb, NOW(), $3)`,
      [
        oldRuntimeId,
        JSON.stringify({ host: 'retired-file-writer', pid: 42, startedAt: new Date().toISOString() }),
        acknowledgmentId,
      ],
    );
    const recoveryIds = [
      applied.id,
      mismatch.id,
      appliedIcon.id,
      mismatchIcon.id,
      stagedAttachment.id,
      stagedIcon.id,
      partialAttachment.id,
      partialIcon.id,
      deniedRepair.id,
    ];
    await query(
      'UPDATE page_write_intents SET runtime_id = $1 WHERE id = ANY($2::uuid[])',
      [oldRuntimeId, recoveryIds],
    );
    await fencePageWriterRuntime({
      runtimeId: oldRuntimeId,
      mode: 'owner_ack',
      acknowledgmentId,
      actorId: appliedPage.userId,
      reason: 'Test retired writer epoch acknowledged quiescence before local recovery',
    });

    await expect(reconcilePageWriteIntent(applied.id, {
      actorId: appliedPage.userId,
      reason: 'Exact attachment bytes and metadata match the durable descriptor',
    })).resolves.toMatchObject({ status: 'reconciled_applied' });
    await expect(reconcilePageWriteIntent(mismatch.id, {
      actorId: mismatchPage.userId,
      reason: 'Mismatched attachment bytes must remain unresolved for operator action',
    })).rejects.toThrow('incomplete or does not match');
    await expect(reconcilePageWriteIntent(appliedIcon.id, {
      actorId: appliedIconPage.userId,
      reason: 'Exact icon bytes and metadata match the durable descriptor',
    })).resolves.toMatchObject({ status: 'reconciled_applied' });
    await expect(reconcilePageWriteIntent(mismatchIcon.id, {
      actorId: mismatchIconPage.userId,
      reason: 'Mismatched icon bytes must remain unresolved for operator action',
    })).rejects.toThrow('incomplete or does not match');
    await expect(reconcilePageWriteIntent(stagedAttachment.id, {
      actorId: stagedPage.userId,
      reason: 'Intent-owned attachment staging is safely removed before settlement',
    })).resolves.toMatchObject({ status: 'reconciled_not_applied' });
    await expect(reconcilePageWriteIntent(stagedIcon.id, {
      actorId: stagedIconPage.userId,
      reason: 'Intent-owned icon staging is safely removed before settlement',
    })).resolves.toMatchObject({ status: 'reconciled_not_applied' });
    await expect(reconcilePageWriteIntent(partialAttachment.id, {
      actorId: partialPage.userId,
      reason: 'Partial attachment activation deterministically finishes exact remaining stages',
    })).resolves.toMatchObject({ status: 'reconciled_applied' });
    await expect(reconcilePageWriteIntent(partialIcon.id, {
      actorId: partialIconPage.userId,
      reason: 'Started icon activation deterministically finishes its exact stage',
    })).resolves.toMatchObject({ status: 'reconciled_applied' });
    await expect(
      fs.readFile(path.join(tempBase, 'local', String(partialPage.pageId), 'second.txt')),
    ).resolves.toEqual(partialSecond);
    await expect(
      fs.readFile(
        path.join(
          tempBase,
          PAGE_ICON_STORE_DIRNAME,
          String(partialIconPage.pageId),
          `${partialIconSha}.png`,
        ),
      ),
    ).resolves.toEqual(partialIconBytes);
    await expect(reconcilePageWriteIntent(deniedRepair.id, {
      actorId: appliedPage.userId,
      reason: 'Deactivated original actor cannot authorize completing a live attachment repair',
    })).rejects.toThrow('no longer active');
    const pending = await query<{ id: string; status: string }>(
      'SELECT id, status FROM page_write_intents WHERE id = ANY($1::uuid[]) ORDER BY id',
      [[mismatch.id, mismatchIcon.id, deniedRepair.id]],
    );
    expect(pending.rows).toHaveLength(3);
  });

  it('preserves unrelated icon bytes when repair authority is denied after the old icon vanished', async () => {
    const owner = await seedUserAndPage();
    const recoveryActor = await seedUserAndPage();
    const previousBytes = Buffer.from('previous uploaded icon');
    const previousSha = createHash('sha256').update(previousBytes).digest('hex');
    const iconDir = path.join(tempBase, PAGE_ICON_STORE_DIRNAME, String(owner.pageId));
    const unrelated = path.join(iconDir, 'unrelated-retained-byte.bin');
    await fs.mkdir(iconDir, { recursive: true });
    await fs.writeFile(path.join(iconDir, `${previousSha}.png`), previousBytes);
    await fs.writeFile(unrelated, 'must survive');
    await query(
      `UPDATE pages
          SET icon_kind = 'image', icon_value = $2, icon_color = NULL, icon_filled = FALSE
        WHERE id = $1`,
      [owner.pageId, previousSha],
    );
    const intent = await reservePageWriteIntent({
      pageIds: [owner.pageId],
      kind: 'icon.metadata.patch',
      actorId: owner.userId,
      effect: {
        effectClass: 'local',
        pageId: owner.pageId,
        iconKind: 'emoji',
        iconValue: 'x',
        iconColor: null,
        iconFilled: false,
        removesUploadedImage: true,
        previousSha256: previousSha,
      },
    });
    await runPageWriteIntentEffect(intent, { kind: 'local' }, () =>
      fs.rm(path.join(iconDir, `${previousSha}.png`)));
    await query('UPDATE users SET deactivated_at = NOW() WHERE id = $1', [owner.userId]);

    const oldRuntimeId = randomUUID();
    const acknowledgmentId = randomUUID();
    await query(
      `INSERT INTO page_writer_runtimes
         (runtime_id, deployment_identity, quiesced_at, quiescence_ack)
       VALUES ($1, $2::jsonb, NOW(), $3)`,
      [
        oldRuntimeId,
        JSON.stringify({
          host: 'retired-icon-metadata-writer',
          pid: 43,
          startedAt: new Date().toISOString(),
        }),
        acknowledgmentId,
      ],
    );
    await query('UPDATE page_write_intents SET runtime_id = $1 WHERE id = $2', [
      oldRuntimeId,
      intent.id,
    ]);
    await fencePageWriterRuntime({
      runtimeId: oldRuntimeId,
      mode: 'owner_ack',
      acknowledgmentId,
      actorId: recoveryActor.userId,
      reason: 'Test retired icon metadata writer before authority-denied recovery',
    });

    await expect(reconcilePageWriteIntent(intent.id, {
      actorId: recoveryActor.userId,
      reason: 'Recovery must preserve unknown icon bytes when the original actor is inactive',
    })).rejects.toThrow('no longer authorized');
    await expect(fs.readFile(unrelated, 'utf8')).resolves.toBe('must survive');
    const page = await query<{ icon_kind: string; icon_value: string }>(
      'SELECT icon_kind, icon_value FROM pages WHERE id = $1',
      [owner.pageId],
    );
    expect(page.rows[0]).toMatchObject({ icon_kind: 'image', icon_value: previousSha });
    const pending = await query<{ status: string }>(
      'SELECT status FROM page_write_intents WHERE id = $1',
      [intent.id],
    );
    expect(pending.rows[0]?.status).toBe('pending');
  });
});
