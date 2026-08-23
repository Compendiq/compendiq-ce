/**
 * #1349 — the standalone hard-delete/purge attachment leak.
 *
 * A standalone page's bytes live in TWO places keyed by its numeric PK:
 * `<ATTACHMENTS_DIR>/<pk>/` (pasted images, shared keyspace with Confluence
 * ids) and `<ATTACHMENTS_DIR>/local/<pk>/` (the local store). Hard delete and
 * the trash purge removed the rows and left both directories behind —
 * `local_attachments`' CASCADE removes rows, not files.
 *
 * The Confluence-style tree's keyspace is SHARED: a Confluence DC page id sits
 * inside `pages.id`'s numeric range, so `<pk>/` may be a live Confluence
 * page's cache. The cleanup must remove it only when no page claims
 * `confluence_id = String(pk)`.
 *
 * Real Postgres + a temp ATTACHMENTS_DIR (local-attachment-service.test.ts
 * pattern).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../test-db-helper.js';
import { query } from '../db/postgres.js';
import { cleanupStandalonePageAttachmentDirs } from './standalone-attachment-cleanup.js';
import { purgeExpiredStandalonePages } from './data-retention-service.js';
import {
  ATTACHMENT_ROOT_RESERVED_DIRNAMES,
  attachmentsRootNow,
  removeCachedAttachmentDirectory,
  removeCachedAttachmentFile,
} from './attachment-store.js';
import { removeLocalAttachmentDirectory } from './local-attachment-service.js';

const dbAvailable = await isDbAvailable();

let tempBase = '';
const originalAttachmentsDir = process.env.ATTACHMENTS_DIR;

async function writeFileAt(...segments: string[]): Promise<string> {
  const filePath = path.join(tempBase, ...segments);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, Buffer.from('png-bytes'));
  return filePath;
}

/**
 * Age a directory past the Confluence-tree grace window (5 min, see
 * `CACHE_DIR_GRACE_MS`). Every test whose subject is the REMOVAL calls this:
 * a directory written milliseconds ago is inside the first-sync race window
 * by construction and is deliberately left to the sweep.
 */
async function ageDir(...segments: string[]): Promise<void> {
  const when = new Date(Date.now() - 60 * 60 * 1000);
  await fs.utimes(path.join(tempBase, ...segments), when, when);
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function seedUser(): Promise<string> {
  const u = await query<{ id: string }>(
    `INSERT INTO users (username, password_hash, role) VALUES ('sweeper', 'hash', 'user') RETURNING id`,
  );
  return u.rows[0]!.id;
}

async function seedStandalonePage(userId: string, opts?: { deletedDaysAgo?: number }): Promise<number> {
  const p = await query<{ id: number }>(
    `INSERT INTO pages (space_key, title, body_html, body_text, version, source, visibility,
                        created_by_user_id, embedding_dirty, embedding_status, deleted_at)
     VALUES ('LOCAL', 'Standalone', '<p>s</p>', 's', 1, 'standalone', 'private', $1, FALSE, 'not_embedded',
             CASE WHEN $2::int IS NULL THEN NULL ELSE NOW() - ($2::int * INTERVAL '1 day') END)
     RETURNING id`,
    [userId, opts?.deletedDaysAgo ?? null],
  );
  return p.rows[0]!.id;
}

async function seedConfluencePage(userId: string, confluenceId: string): Promise<number> {
  const p = await query<{ id: number }>(
    `INSERT INTO pages (space_key, confluence_id, title, body_html, body_text, version, source, visibility,
                        created_by_user_id, embedding_dirty, embedding_status)
     VALUES ('DEV', $2, 'Confluence twin', '<p>c</p>', 'c', 1, 'confluence', 'shared', $1, FALSE, 'not_embedded')
     RETURNING id`,
    [userId, confluenceId],
  );
  return p.rows[0]!.id;
}

describe.skipIf(!dbAvailable)('#1349 standalone attachment cleanup', () => {
  beforeAll(async () => {
    await setupTestDb();
    tempBase = await fs.mkdtemp(path.join(os.tmpdir(), 'compendiq-standalone-cleanup-'));
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
    // Fresh tree per test so one test's leftovers cannot mask another's leak.
    await fs.rm(tempBase, { recursive: true, force: true });
    await fs.mkdir(tempBase, { recursive: true });
  });

  describe('core removal helpers (attachment-store / local-attachment-service)', () => {
    it('attachmentsRootNow resolves the live env value at call time', () => {
      expect(attachmentsRootNow()).toBe(path.resolve(tempBase));
    });

    it('removeCachedAttachmentDirectory removes a whole key directory and refuses traversal', async () => {
      await writeFileAt('123', 'a.png');
      await removeCachedAttachmentDirectory('123');
      expect(await exists(path.join(tempBase, '123'))).toBe(false);
      await expect(removeCachedAttachmentDirectory('../etc')).rejects.toThrow();
    });

    // #1349 review: the reserved-name refusal is documented as the backstop
    // against the page-icon data loss ("so a future walker that forgets cannot
    // repeat it") — both names pass the Confluence tree's key pattern, so
    // without this the only thing guarding two whole stores was prose.
    it('removeCachedAttachmentDirectory refuses the reserved store names', async () => {
      await writeFileAt('local', '77', 'diagram.png');
      await writeFileAt('page-icons', 'brand', 'mark.png');

      for (const reserved of ATTACHMENT_ROOT_RESERVED_DIRNAMES) {
        await expect(removeCachedAttachmentDirectory(reserved)).rejects.toThrow(/reserved/i);
      }

      // …and the refusal really is what kept the bytes: both stores intact.
      expect(await exists(path.join(tempBase, 'local', '77', 'diagram.png'))).toBe(true);
      expect(await exists(path.join(tempBase, 'page-icons', 'brand', 'mark.png'))).toBe(true);
    });

    it('removeCachedAttachmentFile removes exactly one file and refuses traversal', async () => {
      await writeFileAt('123', 'a.png');
      await writeFileAt('123', 'b.png');
      await removeCachedAttachmentFile('123', 'a.png');
      expect(await exists(path.join(tempBase, '123', 'a.png'))).toBe(false);
      expect(await exists(path.join(tempBase, '123', 'b.png'))).toBe(true);
      await expect(removeCachedAttachmentFile('123', '../b.png')).rejects.toThrow();
    });

    it('removeLocalAttachmentDirectory removes local/<pk>/ and refuses a non-integer id', async () => {
      await writeFileAt('local', '77', 'diagram.png');
      await removeLocalAttachmentDirectory(77);
      expect(await exists(path.join(tempBase, 'local', '77'))).toBe(false);
      await expect(removeLocalAttachmentDirectory(Number.NaN)).rejects.toThrow();
    });
  });

  describe('cleanupStandalonePageAttachmentDirs', () => {
    it('removes both stores for a hard-deleted standalone page', async () => {
      const userId = await seedUser();
      const pageId = await seedStandalonePage(userId);
      await writeFileAt(String(pageId), 'pasted.png');
      await writeFileAt('local', String(pageId), 'diagram.png');
      await ageDir(String(pageId));
      await query('DELETE FROM pages WHERE id = $1', [pageId]);

      await cleanupStandalonePageAttachmentDirs(pageId);

      expect(await exists(path.join(tempBase, String(pageId)))).toBe(false);
      expect(await exists(path.join(tempBase, 'local', String(pageId)))).toBe(false);
    });

    // #1349 review: the ownership EXISTS asks who claims the key RIGHT NOW,
    // and a first sync downloads `<confluence_id>/` BEFORE the `pages` INSERT
    // — so inside that window the answer is "nobody" and a colliding
    // standalone hard delete would evict a Confluence page's fresh cache. The
    // local store has no such ambiguity and is removed either way.
    it('leaves a JUST-WRITTEN Confluence-tree directory to the sweep (first-sync race)', async () => {
      const userId = await seedUser();
      const pageId = await seedStandalonePage(userId);
      const young = await writeFileAt(String(pageId), 'just-downloaded.png');
      await writeFileAt('local', String(pageId), 'diagram.png');
      await query('DELETE FROM pages WHERE id = $1', [pageId]);

      await cleanupStandalonePageAttachmentDirs(pageId);

      expect(await exists(young)).toBe(true);
      expect(await exists(path.join(tempBase, 'local', String(pageId)))).toBe(false);
    });

    it('leaves the Confluence cache alone when a live Confluence page owns the same key', async () => {
      const userId = await seedUser();
      const pageId = await seedStandalonePage(userId);
      // A real Confluence page whose confluence_id collides with the standalone PK.
      await seedConfluencePage(userId, String(pageId));
      const confluenceCacheFile = await writeFileAt(String(pageId), 'confluence-owned.png');
      await writeFileAt('local', String(pageId), 'diagram.png');
      // Age it PAST the grace window, or the 5-minute mtime check spares the
      // directory on its own and the ownership EXISTS — the invariant this
      // test names — is never reached (#1349 review r1). The un-aged case is
      // its own test above.
      await ageDir(String(pageId));
      await query(`DELETE FROM pages WHERE id = $1`, [pageId]);

      await cleanupStandalonePageAttachmentDirs(pageId);

      // The shared-keyspace directory survives; the local store is unambiguous.
      expect(await exists(confluenceCacheFile)).toBe(true);
      expect(await exists(path.join(tempBase, 'local', String(pageId)))).toBe(false);
    });

    it('never throws — a filesystem problem is logged, not fatal', async () => {
      // No page rows, no directories at all: both removals are ENOENT no-ops.
      await expect(cleanupStandalonePageAttachmentDirs(999_999)).resolves.toBeUndefined();
    });
  });

  describe('purgeExpiredStandalonePages (#1349 leak half)', () => {
    it('removes the attachment directories of purged pages', async () => {
      const userId = await seedUser();
      const expired = await seedStandalonePage(userId, { deletedDaysAgo: 31 });
      const fresh = await seedStandalonePage(userId, { deletedDaysAgo: 1 });
      await writeFileAt(String(expired), 'pasted.png');
      await writeFileAt('local', String(expired), 'diagram.png');
      await writeFileAt(String(fresh), 'keep.png');
      await ageDir(String(expired));

      const purged = await purgeExpiredStandalonePages();

      expect(purged).toBe(1);
      expect(await exists(path.join(tempBase, String(expired)))).toBe(false);
      expect(await exists(path.join(tempBase, 'local', String(expired)))).toBe(false);
      // The page still inside its trash window keeps its files.
      expect(await exists(path.join(tempBase, String(fresh), 'keep.png'))).toBe(true);
    });

    it('leaves a colliding Confluence cache directory in place', async () => {
      const userId = await seedUser();
      const expired = await seedStandalonePage(userId, { deletedDaysAgo: 31 });
      await seedConfluencePage(userId, String(expired));
      const confluenceCacheFile = await writeFileAt(String(expired), 'confluence-owned.png');
      await writeFileAt('local', String(expired), 'diagram.png');
      // Same as above: aged, so only the ownership check can spare it.
      await ageDir(String(expired));

      const purged = await purgeExpiredStandalonePages();

      expect(purged).toBe(1);
      expect(await exists(confluenceCacheFile)).toBe(true);
      expect(await exists(path.join(tempBase, 'local', String(expired)))).toBe(false);
    });
  });
});
