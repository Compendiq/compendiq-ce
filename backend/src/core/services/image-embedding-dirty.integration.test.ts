import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  markPageImagesDirty,
  markPageImagesDirtyByAttachmentKey,
} from './image-embedding-dirty.js';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../test-db-helper.js';
import { query } from '../db/postgres.js';

/**
 * #1115 P2 — the dirty flag, at every place an image can change under a page.
 *
 * The flag IS the queue: a write that does not raise it leaves the index
 * describing bytes that are gone, and nothing ever notices, because a stale
 * row and a correct one are the same shape. So each writer is exercised
 * against real Postgres, and the two helpers against the exclusions they have
 * to honour.
 *
 * `embedding_dirty` is asserted UNMOVED in every case. Migration 093 gave the
 * two flags separate columns exactly so an attachment write cannot enqueue a
 * text re-embed of the page, and one shared `SET … = TRUE` is how that gets
 * quietly undone.
 *
 * It reaches across two domains — which is fine here and only here: the
 * boundary rule is about production imports (`boundaries/ignore` exempts
 * `*.test.ts`), and the invariant under test is precisely that writers in
 * three different layers all end up at this one `core` module.
 */

const dbAvailable = await isDbAvailable();

let attachmentsDir: string;
let previousAttachmentsDir: string | undefined;
let writeAttachmentCache: typeof import('../../domains/confluence/services/attachment-handler.js')['writeAttachmentCache'];
let cleanPageAttachments: typeof import('../../domains/confluence/services/attachment-handler.js')['cleanPageAttachments'];
let syncImageAttachments: typeof import('../../domains/confluence/services/attachment-handler.js')['syncImageAttachments'];
let syncDrawioAttachments: typeof import('../../domains/confluence/services/attachment-handler.js')['syncDrawioAttachments'];
let fetchAndCachePageImage: typeof import('../../domains/confluence/services/attachment-handler.js')['fetchAndCachePageImage'];
let putLocalAttachment: typeof import('./local-attachment-service.js')['putLocalAttachment'];
let syncPage: typeof import('../../domains/confluence/services/sync-service.js')['__internal']['syncPage'];

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG = Buffer.concat([PNG_SIG, Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.alloc(8)]);

const OWNER = '00000000-0000-4000-8000-0000000000aa';

async function seed(opts: {
  title: string;
  source?: 'confluence' | 'standalone';
  confluenceId?: string | null;
  pageType?: string;
  deleted?: boolean;
  visibility?: string;
}): Promise<number> {
  const r = await query<{ id: number }>(
    `INSERT INTO pages (title, space_key, body_html, page_type, source, confluence_id, deleted_at,
                        visibility, image_embedding_dirty, embedding_dirty)
     VALUES ($1, 'DEV', '<p>x</p>', $2, $3, $4, $5, $6, FALSE, FALSE) RETURNING id`,
    [
      opts.title,
      opts.pageType ?? 'page',
      opts.source ?? 'standalone',
      opts.confluenceId ?? null,
      opts.deleted ? new Date() : null,
      opts.visibility ?? 'shared',
    ],
  );
  return r.rows[0]!.id;
}

async function flags(pageId: number): Promise<{ image: boolean; text: boolean }> {
  const r = await query<{ image_embedding_dirty: boolean; embedding_dirty: boolean }>(
    `SELECT image_embedding_dirty, embedding_dirty FROM pages WHERE id = $1`,
    [pageId],
  );
  return { image: r.rows[0]!.image_embedding_dirty, text: r.rows[0]!.embedding_dirty };
}

async function flagsByConfluenceId(confluenceId: string): Promise<{ image: boolean; text: boolean }> {
  const r = await query<{ image_embedding_dirty: boolean; embedding_dirty: boolean }>(
    `SELECT image_embedding_dirty, embedding_dirty FROM pages WHERE confluence_id = $1`,
    [confluenceId],
  );
  return { image: r.rows[0]!.image_embedding_dirty, text: r.rows[0]!.embedding_dirty };
}

describe.skipIf(!dbAvailable)('image_embedding_dirty writers (#1115 P2)', () => {
  beforeAll(async () => {
    await setupTestDb();
    previousAttachmentsDir = process.env.ATTACHMENTS_DIR;
    attachmentsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cq-image-dirty-'));
    process.env.ATTACHMENTS_DIR = attachmentsDir;
    // Imported AFTER the env is pointed at the temp root: `attachment-handler`
    // resolves its on-disk base at module load (the `sync-service.unsync`
    // test's pattern).
    ({
      writeAttachmentCache,
      cleanPageAttachments,
      syncImageAttachments,
      syncDrawioAttachments,
      fetchAndCachePageImage,
    } = await import('../../domains/confluence/services/attachment-handler.js'));
    ({ putLocalAttachment } = await import('./local-attachment-service.js'));
    ({ __internal: { syncPage } } = await import(
      '../../domains/confluence/services/sync-service.js'
    ));
  });

  afterAll(async () => {
    if (previousAttachmentsDir === undefined) delete process.env.ATTACHMENTS_DIR;
    else process.env.ATTACHMENTS_DIR = previousAttachmentsDir;
    await fs.rm(attachmentsDir, { recursive: true, force: true });
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
  });

  describe('markPageImagesDirty (by page id)', () => {
    it('raises the image flag and leaves the text flag alone', async () => {
      const pageId = await seed({ title: 'A' });
      await markPageImagesDirty(pageId);
      expect(await flags(pageId)).toEqual({ image: true, text: false });
    });

    it('does not raise it on a folder or a soft-deleted page', async () => {
      // Both are excluded by the worker's own WHERE, so a flag set here is a
      // backlog entry no scan can ever clear.
      const folder = await seed({ title: 'F', pageType: 'folder' });
      const deleted = await seed({ title: 'D', deleted: true });
      await markPageImagesDirty(folder);
      await markPageImagesDirty(deleted);
      expect((await flags(folder)).image).toBe(false);
      expect((await flags(deleted)).image).toBe(false);
    });
  });

  describe('markPageImagesDirtyByAttachmentKey (by directory key)', () => {
    it("matches a Confluence page by its confluence_id — the tree's key", async () => {
      const pageId = await seed({ title: 'C', source: 'confluence', confluenceId: '778899' });
      await markPageImagesDirtyByAttachmentKey('778899');
      expect(await flags(pageId)).toEqual({ image: true, text: false });
    });

    it('matches a standalone page by its numeric id, which is where pasted images land', async () => {
      const pageId = await seed({ title: 'S' });
      await markPageImagesDirtyByAttachmentKey(String(pageId));
      expect((await flags(pageId)).image).toBe(true);
    });

    it('tolerates a non-numeric key without throwing', async () => {
      // The key is compared as TEXT, never `$1::int`: the key can legitimately
      // be non-numeric, and an int cast turns a bookkeeping update into an
      // aborted sync.
      const pageId = await seed({ title: 'X', source: 'confluence', confluenceId: 'page-1' });
      await expect(markPageImagesDirtyByAttachmentKey('page-1')).resolves.toBeUndefined();
      expect((await flags(pageId)).image).toBe(true);
    });

    it('matches nothing for an unknown key, and does not throw on an empty one', async () => {
      const pageId = await seed({ title: 'Y' });
      await markPageImagesDirtyByAttachmentKey('nope');
      await markPageImagesDirtyByAttachmentKey('');
      expect((await flags(pageId)).image).toBe(false);
    });

    it('survives a Confluence id wider than INTEGER without throwing', async () => {
      // A real Confluence id routinely overflows `pages.id`'s INTEGER, and
      // `$1::int` would raise 22003 — aborting the sync that was merely trying
      // to raise a flag. The parse happens in JS for exactly this.
      const pageId = await seed({ title: 'Wide', source: 'confluence', confluenceId: '98765432109876' });
      await expect(
        markPageImagesDirtyByAttachmentKey('98765432109876'),
      ).resolves.toBeUndefined();
      expect((await flags(pageId)).image).toBe(true);

      // …and one that matches no page at all still cannot throw.
      await expect(markPageImagesDirtyByAttachmentKey('12345678901234')).resolves.toBeUndefined();
    });

    it('does not read a zero-padded key as a page id', async () => {
      // `'007'` can only come from a Confluence id; reading it as page 7 would
      // mark an unrelated page.
      const pageId = await seed({ title: 'Z' });
      await markPageImagesDirtyByAttachmentKey(`00${pageId}`);
      expect((await flags(pageId)).image).toBe(false);
    });

    /**
     * Review r2 — the fallback is decided by EXISTENCE, not by the first
     * statement's rowCount.
     *
     * The Confluence lookup filters out soft-deleted and folder pages, so it
     * reports `0` for a page that exists and is merely excluded. Falling
     * through on that number then reads the key as a page id — and Confluence
     * DC ids sit squarely inside `pages.id`'s range — so an unrelated
     * standalone page is marked for a write aimed at a different row entirely.
     */
    it('does not mark an innocent page when the Confluence page exists but is excluded', async () => {
      const innocent = await seed({ title: 'Innocent standalone' });
      // Same string: one page's numeric id is the other's confluence_id.
      await seed({
        title: 'Deleted confluence',
        source: 'confluence',
        confluenceId: String(innocent),
        deleted: true,
      });

      await markPageImagesDirtyByAttachmentKey(String(innocent));

      expect((await flags(innocent)).image).toBe(false);
    });

    it('does not mark an innocent page when the Confluence page is a folder', async () => {
      const innocent = await seed({ title: 'Innocent standalone 2' });
      await seed({
        title: 'Confluence folder',
        source: 'confluence',
        confluenceId: String(innocent),
        pageType: 'folder',
      });

      await markPageImagesDirtyByAttachmentKey(String(innocent));

      expect((await flags(innocent)).image).toBe(false);
    });

    it('does not match a CONFLUENCE page by its numeric primary key', async () => {
      // The Confluence tree keys those pages by `confluence_id`; their numeric
      // id names a directory nothing writes to.
      const pageId = await seed({ title: 'C2', source: 'confluence', confluenceId: 'cid-1' });
      await markPageImagesDirtyByAttachmentKey(String(pageId));
      expect((await flags(pageId)).image).toBe(false);
    });
  });

  describe('the attachment writers', () => {
    it('writeAttachmentCache raises the flag for the page the key belongs to', async () => {
      // The paste route and the external-image import both land here.
      const pageId = await seed({ title: 'Paste' });
      await writeAttachmentCache('u1', String(pageId), 'pasted.png', PNG);
      expect(await flags(pageId)).toEqual({ image: true, text: false });
    });

    it('putLocalAttachment raises the flag (the draw.io save on a local page)', async () => {
      // `local_attachments.created_by` has a real FK, so the writer needs a
      // real user row behind it.
      await query(
        `INSERT INTO users (id, username, email, role, password_hash)
         VALUES ($1::uuid, 'owner', 'owner@test', 'user', 'x')
         ON CONFLICT (id) DO NOTHING`,
        [OWNER],
      );
      const pageId = await seed({ title: 'Drawio' });
      await putLocalAttachment({
        pageId,
        filename: 'diagram.png',
        contentType: 'image/png',
        data: PNG,
        userId: OWNER,
      });
      expect(await flags(pageId)).toEqual({ image: true, text: false });
    });

    /**
     * The two SYNC writers — the "attachment changed under an unchanged page
     * version" hole P0 recorded, and the only half of it the flag can close.
     *
     * Both raises were deletable with every suite green: the sync fixtures
     * hand these functions an empty attachment list, so `downloaded` is always
     * 0 and the branch is never entered. Driven directly here with a client
     * that really returns bytes, and with the negative half the code's own
     * comment argues for — a second, cached call must NOT re-dirty, or every
     * diagram-bearing page re-scans on every `SYNC_INTERVAL_MIN`.
     */
    describe('the two sync attachment writers', () => {
      function clientReturning(bytes: Buffer) {
        return {
          downloadAttachment: async () => bytes,
          getPageAttachments: async () => ({ results: [] as never[] }),
        } as never;
      }
      function attachment(title: string) {
        return [{ title, _links: { download: `/download/${title}` }, extensions: {} }] as never;
      }

      it('syncImageAttachments raises the flag on a real download, not on a cached skip', async () => {
        const pageId = await seed({ title: 'Img', source: 'confluence', confluenceId: '5150' });
        const body = `<ac:image><ri:attachment ri:filename="pic.png" /></ac:image>`;

        await syncImageAttachments(
          clientReturning(PNG), 'u1', '5150', body, attachment('pic.png'), 'DEV',
        );
        expect(await flags(pageId)).toEqual({ image: true, text: false });

        // The file is on disk now, so the second pass downloads nothing.
        await query(`UPDATE pages SET image_embedding_dirty = FALSE WHERE id = $1`, [pageId]);
        await syncImageAttachments(
          clientReturning(PNG), 'u1', '5150', body, attachment('pic.png'), 'DEV',
        );
        expect((await flags(pageId)).image).toBe(false);
      });

      it('syncDrawioAttachments raises the flag on a real download, not on a cached skip', async () => {
        const pageId = await seed({ title: 'Drawio sync', source: 'confluence', confluenceId: '5151' });
        const body =
          `<ac:structured-macro ac:name="drawio">` +
          `<ac:parameter ac:name="diagramName">topology</ac:parameter></ac:structured-macro>`;

        await syncDrawioAttachments(
          clientReturning(PNG), 'u1', '5151', body, attachment('topology.png'),
        );
        expect(await flags(pageId)).toEqual({ image: true, text: false });

        await query(`UPDATE pages SET image_embedding_dirty = FALSE WHERE id = $1`, [pageId]);
        await syncDrawioAttachments(
          clientReturning(PNG), 'u1', '5151', body, attachment('topology.png'),
        );
        expect((await flags(pageId)).image).toBe(false);
      });

      it('fetchAndCachePageImage raises the flag — the recovery path for a `missing` skip', async () => {
        // A skip is terminal: the worker counts the image and the page still
        // CLEARS its flag. So when this route finally materialises the bytes,
        // nothing else would ever re-queue the page and the image stays out of
        // the index until a new version, another download or a manual re-scan.
        const pageId = await seed({ title: 'Lazy', source: 'confluence', confluenceId: '5152' });
        const body = `<ac:image><ri:attachment ri:filename="late.png" /></ac:image>`;

        const bytes = await fetchAndCachePageImage({
          client: {
            downloadAttachment: async () => PNG,
            getPageAttachments: async () => ({ results: attachment('late.png') }),
          } as never,
          userId: 'u1',
          pageId: '5152',
          localFilename: 'late.png',
          bodyStorage: body,
          currentSpaceKey: 'DEV',
        });

        expect(bytes).not.toBeNull();
        expect(await flags(pageId)).toEqual({ image: true, text: false });
      });
    });

    it('cleanPageAttachments raises the flag, so reconcile removes the orphaned rows', async () => {
      // The files are gone; the rows describing them must not survive as
      // silently-unresolvable index entries.
      const pageId = await seed({ title: 'Clean', source: 'confluence', confluenceId: '4242' });
      await writeAttachmentCache('u1', '4242', 'a.png', PNG);
      await query(`UPDATE pages SET image_embedding_dirty = FALSE WHERE id = $1`, [pageId]);

      await cleanPageAttachments('u1', '4242');

      expect(await flags(pageId)).toEqual({ image: true, text: false });
    });
  });

  describe('the sync page upsert', () => {
    function currentBody(id: string, version: number) {
      return {
        id,
        title: `Page ${id}`,
        status: 'current',
        body: { storage: { value: '<p>live</p>' } },
        version: { number: version, when: '2026-01-01T00:00:00Z', by: { displayName: 'A' } },
        metadata: { labels: { results: [] } },
        ancestors: [],
      };
    }
    const client = {
      getPage: async (id: string) => currentBody(id, 3),
      getPageAttachments: async () => ({ results: [] as never[] }),
    };

    async function run(confluenceId: string): Promise<void> {
      await syncPage(
        client as never,
        'sync-user',
        'DEV',
        { id: confluenceId } as never,
        new Date(),
        new Map(),
        { pagesCreated: 0, pagesUpdated: 0, pagesDeleted: 0 },
        'run-1',
      );
    }

    it('marks a freshly-created page for an image scan', async () => {
      await run('sync-new');
      expect(await flagsByConfluenceId('sync-new')).toEqual({ image: true, text: true });
    });

    it('marks an existing page on a new version, because the body can move an <img>', async () => {
      const pageId = await seed({ title: 'Old', source: 'confluence', confluenceId: 'sync-upd' });
      await query(`UPDATE pages SET version = 1 WHERE id = $1`, [pageId]);

      await run('sync-upd');

      expect(await flags(pageId)).toEqual({ image: true, text: true });
    });
  });
});
