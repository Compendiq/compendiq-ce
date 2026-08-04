import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../test-db-helper.js';
import { query } from '../db/postgres.js';
import {
  putLocalAttachment,
  getLocalAttachment,
  listLocalAttachments,
  removeLocalAttachmentFilesForRelocate,
  writeLocalAttachmentFileForRelocate,
  MAX_LOCAL_ATTACHMENT_BYTES,
} from './local-attachment-service.js';

const dbAvailable = await isDbAvailable();

// Override ATTACHMENTS_DIR to a temp dir so repeated test runs don't
// inherit cruft from previous invocations.
let tempBase = '';
const originalAttachmentsDir = process.env.ATTACHMENTS_DIR;

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
       VALUES ('alice', 'hash', 'user')
       RETURNING id`,
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
});
