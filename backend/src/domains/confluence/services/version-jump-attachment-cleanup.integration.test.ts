/**
 * #1773 — the version-jump cache cleanup called directly, against real
 * PostgreSQL, Redis and a temp ATTACHMENTS_DIR, for what a whole sync cannot
 * isolate:
 *
 *  - Rule 4, the tail every run ends with. In a sync, `syncPage` clears the
 *    same Redis failure counters right after the cleanup and its upsert raises
 *    the same image re-read flag, so only a direct call shows that the cleanup
 *    does both itself, as `cleanPageAttachments` does.
 *  - The history read: a `page_versions` row that names a diagram only by its
 *    wrapper, as HTML converted from Markdown before 2026-10-28 does.
 *
 * The end-to-end behaviour is covered by
 * `sync-service-version-jump-cache.integration.test.ts`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createClient, type RedisClientType } from 'redis';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../../test-db-helper.js';
import { isRedisAvailable } from '../../../test-redis-helper.js';
import { query } from '../../../core/db/postgres.js';
import { attachmentCacheDir } from '../../../core/services/attachment-store.js';
import { setRedisClient } from '../../../core/services/redis-cache.js';
import { saveVersionSnapshotByPageId } from '../../../core/services/version-snapshot.js';
import { pruneVersionJumpAttachmentCache } from './version-jump-attachment-cleanup.js';

// Set the fixture root before the production import graph is evaluated.
const { attachmentsRoot, originalAttachmentsRoot } = await vi.hoisted(async () => {
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const attachmentsRoot = join(tmpdir(), `version-jump-cleanup-${globalThis.crypto.randomUUID()}`);
  const originalAttachmentsRoot = process.env.ATTACHMENTS_DIR;
  process.env.ATTACHMENTS_DIR = attachmentsRoot;
  return { attachmentsRoot, originalAttachmentsRoot };
});

const [dbAvailable, redisAvailable] = await Promise.all([isDbAvailable(), isRedisAvailable()]);
const SPACE_KEY = 'DEV';
let redis: RedisClientType;

function image(filename: string): string {
  return `<ac:image><ri:attachment ri:filename="${filename}" /></ac:image>`;
}

/** A synced Confluence page whose image analysis is up to date. */
async function seedPage(confluenceId: string, draftBodyHtml: string | null = null): Promise<number> {
  const result = await query<{ id: number }>(
    `INSERT INTO pages
       (source, confluence_id, space_key, title, body_storage, body_html, body_text,
        version, visibility, inherit_perms, draft_body_html, image_analysis_dirty, last_synced)
     VALUES ('confluence', $1, $2, $3, '<p>v1</p>', '<p>v1</p>', 'v1', 1, 'shared', TRUE, $4, FALSE, NOW())
     RETURNING id`,
    [confluenceId, SPACE_KEY, `Page ${confluenceId}`, draftBodyHtml],
  );
  return result.rows[0]!.id;
}

async function seedCache(confluenceId: string, names: string[]): Promise<void> {
  const dir = attachmentCacheDir(confluenceId);
  await mkdir(dir, { recursive: true });
  for (const name of names) await writeFile(join(dir, name), `${name} bytes`);
}

/** Two failure counters for the page, as a failed download leaves them. */
async function seedFailureCounters(confluenceId: string): Promise<string[]> {
  const keys = ['evidence.png', 'broken.png'].map((name) => `attach:fail:${confluenceId}:${encodeURIComponent(name)}`);
  for (const key of keys) await redis.set(key, '3');
  return keys;
}

async function imageAnalysisDirty(pageId: number): Promise<boolean> {
  const result = await query<{ image_analysis_dirty: boolean }>(
    'SELECT image_analysis_dirty FROM pages WHERE id = $1',
    [pageId],
  );
  return result.rows[0]!.image_analysis_dirty;
}

describe.skipIf(!dbAvailable || !redisAvailable)(
  '#1773 pruneVersionJumpAttachmentCache — real PostgreSQL, Redis and cache directory',
  () => {
    beforeAll(async () => {
      await setupTestDb();
      redis = createClient({
        url: process.env.REDIS_URL,
        socket: { reconnectStrategy: false, connectTimeout: 1_000 },
      });
      await redis.connect();
      setRedisClient(redis);
    }, 30_000);

    beforeEach(async () => {
      await truncateAllTables();
      await redis.flushDb();
      await rm(attachmentsRoot, { recursive: true, force: true });
      await mkdir(attachmentsRoot, { recursive: true });
      await query(`INSERT INTO spaces (space_key, space_name) VALUES ($1, 'Development')`, [SPACE_KEY]);
    });

    afterAll(async () => {
      setRedisClient(null);
      if (redis?.isOpen) await redis.quit();
      await teardownTestDb();
      await rm(attachmentsRoot, { recursive: true, force: true });
      if (originalAttachmentsRoot === undefined) delete process.env.ATTACHMENTS_DIR;
      else process.env.ATTACHMENTS_DIR = originalAttachmentsRoot;
    });

    it("Rule 4: clears the page's failure counters and re-queues its image analysis, as cleanPageAttachments does", async () => {
      const pageId = await seedPage('vj-tail', '<p>draft</p><img src="/api/attachments/vj-tail/pasted.png">');
      await seedCache('vj-tail', ['evidence.png', 'pasted.png']);
      const counters = await seedFailureCounters('vj-tail');

      await pruneVersionJumpAttachmentCache({
        pageId,
        attachmentKey: 'vj-tail',
        incomingStorage: `<p>v2</p>${image('evidence.png')}`,
        spaceKey: SPACE_KEY,
      });

      expect(await readdir(attachmentCacheDir('vj-tail'))).toEqual(['pasted.png']);
      expect(await redis.exists(counters)).toBe(0);
      expect(await imageAnalysisDirty(pageId)).toBe(true);
    });

    it('Rule 4: runs the same tail when the page has no cache directory', async () => {
      const pageId = await seedPage('vj-empty');
      const counters = await seedFailureCounters('vj-empty');

      await pruneVersionJumpAttachmentCache({
        pageId,
        attachmentKey: 'vj-empty',
        incomingStorage: `<p>v2</p>${image('evidence.png')}`,
        spaceKey: SPACE_KEY,
      });

      await expect(readdir(attachmentCacheDir('vj-empty'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await redis.exists(counters)).toBe(0);
      expect(await imageAnalysisDirty(pageId)).toBe(true);
    });

    it('keeps the three files of a diagram that a history row names only by its pre-2026-10-28 Markdown wrapper', async () => {
      const pageId = await seedPage('vj-bare');
      await saveVersionSnapshotByPageId(
        pageId, 1, 'Page vj-bare',
        '<p>before</p><div class="confluence-drawio" data-diagram-name="bare"></div>',
        'before bare',
      );
      await seedCache('vj-bare', ['bare.png', 'bare.drawio', 'bare.drawio.png', 'gone.png']);

      await pruneVersionJumpAttachmentCache({
        pageId,
        attachmentKey: 'vj-bare',
        incomingStorage: '<p>v2</p>',
        spaceKey: SPACE_KEY,
      });

      expect((await readdir(attachmentCacheDir('vj-bare'))).sort()).toEqual([
        'bare.drawio', 'bare.drawio.png', 'bare.png',
      ]);
    });
  },
);
