/**
 * #1349 — the orphan sweep against real Postgres and a temp attachment tree.
 *
 * DATA LOSS is the failure mode this feature can have, so most of these tests
 * are about what the sweep must NOT touch: files referenced by any body
 * anywhere (live, trashed, drafts, versions, pending sync versions, templates,
 * comments), non-image cached attachments, dot-files, anything younger than
 * the grace window, `local_attachments` rows whose file is missing, and the
 * entire `local/` entry as seen from the Confluence-tree walk.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createClient, type RedisClientType } from 'redis';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import {
  acquireWorkerLock,
  releaseWorkerLock,
  setRedisClient,
} from '../../../core/services/redis-cache.js';
import type { AttachmentSweepCandidate } from '@compendiq/contracts';
import {
  ATTACHMENT_SWEEP_GRACE_MS,
  ATTACHMENT_SWEEP_WORKER_LOCK,
  buildAttachmentKeepSets,
  deleteCandidates,
  emptyDeletedTotals,
  readAttachmentStorageStatsRecord,
  readAttachmentSweepLastRun,
  runAttachmentSweep,
} from './attachment-sweep-service.js';

const dbAvailable = await isDbAvailable();

/**
 * A real Redis where reachable, connected at module level (the
 * image-embedding-worker.integration.test.ts pattern): `acquireWorkerLock`'s
 * no-Redis fallback hands every caller a token, which would make the
 * single-flight test assert nothing.
 */
const redis = await (async (): Promise<RedisClientType | null> => {
  try {
    const client = createClient({
      url: process.env.REDIS_URL ?? 'redis://localhost:6379',
    }) as RedisClientType;
    client.on('error', () => undefined);
    await client.connect();
    setRedisClient(client);
    return client;
  } catch {
    return null;
  }
})();

let tempBase = '';
const originalAttachmentsDir = process.env.ATTACHMENTS_DIR;

/** Age a path safely past the 24h grace window. */
const AGED = new Date(Date.now() - ATTACHMENT_SWEEP_GRACE_MS - 24 * 60 * 60 * 1000);

async function writeAged(...segments: string[]): Promise<string> {
  const filePath = path.join(tempBase, ...segments);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, Buffer.from('bytes-of-' + segments.join('/')));
  await fs.utimes(filePath, AGED, AGED);
  return filePath;
}

async function writeYoung(...segments: string[]): Promise<string> {
  const filePath = path.join(tempBase, ...segments);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, Buffer.from('young-bytes'));
  return filePath;
}

/** Age the DIRECTORY mtimes after all files are in place (writes touch dirs). */
async function ageDirs(...dirs: string[]): Promise<void> {
  for (const dir of dirs) {
    await fs.utimes(path.join(tempBase, dir), AGED, AGED);
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function seedUser(name = 'sweeper'): Promise<string> {
  const u = await query<{ id: string }>(
    `INSERT INTO users (username, password_hash, role) VALUES ($1, 'hash', 'user') RETURNING id`,
    [name],
  );
  return u.rows[0]!.id;
}

interface SeededCorpus {
  userId: string;
  confPageId: number;
  standalonePageId: number;
  localPageId: number;
  trashedPageId: number;
}

/**
 * The full scenario the brief prescribes. Confluence page `90001` carries a
 * body/img reference, a storage-format reference, a draft reference and a
 * percent-encoded reference; a version, a pending sync version, a template
 * and a comment each reference one more of its files. Beside those sit an
 * unreferenced aged image (the per-file orphan), an unreferenced aged
 * external-cache image, an unreferenced non-image, a dot-file, and an
 * unreferenced YOUNG image — the exact state a paste leaves between staging
 * bytes and saving the body, which the per-file mtime grace exists for.
 * Directory `55555` belongs to no page (aged orphan), `66666` to no page but
 * young (grace), and the local store carries a tracked file, an untracked
 * orphan, an untracked YOUNG file, a row with no file, and an orphan
 * directory `99999`.
 */
async function seedCorpus(): Promise<SeededCorpus> {
  const userId = await seedUser();

  const conf = await query<{ id: number }>(
    `INSERT INTO pages (title, space_key, confluence_id, source, page_type, version,
                        body_html, body_storage, draft_body_html)
     VALUES ('Conf', 'DEV', '90001', 'confluence', 'page', 1,
             '<p><img src="/api/attachments/90001/keep.png"><img src="/api/attachments/90001/Screen%20shot.png"><a href="/api/attachments/90001/anchor-kept.png">a</a></p>',
             '<ac:image><ri:attachment ri:filename="storage-kept.png"/></ac:image>',
             '<p><img src="/api/attachments/90001/draft-kept.png"></p>')
     RETURNING id`,
  );
  const confPageId = conf.rows[0]!.id;

  await query(
    `INSERT INTO page_versions (page_id, version_number, title, body_html)
     VALUES ($1, 1, 'Conf v1', '<p><img src="/api/attachments/90001/version-kept.png"></p>')`,
    [confPageId],
  );
  await query(
    `INSERT INTO pending_sync_versions (page_id, confluence_version, body_storage, body_html, body_text, sync_run_id)
     VALUES ($1, 2, '<ac:image><ri:attachment ri:filename="pending-storage-kept.png"/></ac:image>',
             '<p><img src="/api/attachments/90001/pending-kept.png"></p>', 'pending', gen_random_uuid())`,
    [confPageId],
  );
  // The apostrophe reference is deliberate (review r2): encodeURIComponent
  // leaves ' literal, the template body is this file's ONLY reference (no
  // body_storage feeder), and the original URL-regex class terminated at ' —
  // so the keep-set held the truncated "John" and a live run deleted the file.
  await query(
    `INSERT INTO templates (title, body_json, body_html, created_by)
     VALUES ('T', '{}', $1, $2)`,
    [
      `<p><img src="/api/attachments/90001/template-kept.png"><img src="/api/attachments/90001/John's%20notes.png"></p>`,
      userId,
    ],
  );
  await query(
    `INSERT INTO comments (page_id, user_id, body, body_html)
     VALUES ($1, $2, 'c', '<p><img src="/api/attachments/90001/comment-kept.png"></p>')`,
    [confPageId, userId],
  );

  const standalone = await query<{ id: number }>(
    `INSERT INTO pages (title, space_key, source, page_type, version, body_html, created_by_user_id)
     VALUES ('Standalone', 'LOCAL', 'standalone', 'page', 1, '', $1) RETURNING id`,
    [userId],
  );
  const standalonePageId = standalone.rows[0]!.id;
  await query(`UPDATE pages SET body_html = $2 WHERE id = $1`, [
    standalonePageId,
    `<p><img src="/api/attachments/${standalonePageId}/pasted.png"></p>`,
  ]);

  const local = await query<{ id: number }>(
    `INSERT INTO pages (title, space_key, source, page_type, version, body_html, created_by_user_id)
     VALUES ('Local', 'LOCAL', 'standalone', 'page', 1, '', $1) RETURNING id`,
    [userId],
  );
  const localPageId = local.rows[0]!.id;
  await query(`UPDATE pages SET body_html = $2 WHERE id = $1`, [
    localPageId,
    `<p><img src="/api/local-attachments/${localPageId}/local-keep.png"></p>`,
  ]);
  await query(
    `INSERT INTO local_attachments (page_id, filename, content_type, size_bytes, sha256)
     VALUES ($1, 'tracked.png', 'image/png', 9, 'sha-tracked'),
            ($1, 'missing.png', 'image/png', 9, 'sha-missing')`,
    [localPageId],
  );

  const trashed = await query<{ id: number }>(
    `INSERT INTO pages (title, space_key, source, page_type, version, body_html, created_by_user_id, deleted_at)
     VALUES ('Trashed', 'LOCAL', 'standalone', 'page', 1, '', $1, NOW()) RETURNING id`,
    [userId],
  );
  const trashedPageId = trashed.rows[0]!.id;
  await query(`UPDATE pages SET body_html = $2 WHERE id = $1`, [
    trashedPageId,
    `<p><img src="/api/attachments/${trashedPageId}/trash-kept.png"></p>`,
  ]);

  // ── Files on disk ─────────────────────────────────────────────────────
  await writeAged('90001', 'keep.png');
  await writeAged('90001', 'Screen shot.png');
  await writeAged('90001', 'anchor-kept.png');
  await writeAged('90001', 'storage-kept.png');
  await writeAged('90001', 'draft-kept.png');
  await writeAged('90001', 'version-kept.png');
  await writeAged('90001', 'pending-kept.png');
  await writeAged('90001', 'pending-storage-kept.png');
  await writeAged('90001', 'template-kept.png');
  await writeAged('90001', "John's notes.png");
  await writeAged('90001', 'comment-kept.png');
  await writeAged('90001', 'orphan.png');
  await writeAged('90001', 'external-aaaabbbbcccc.png');
  await writeAged('90001', 'manual.pdf');
  await writeAged('90001', '.DS_Store');
  await writeYoung('90001', 'young-orphan.png');
  await writeAged(String(standalonePageId), 'pasted.png');
  await writeAged(String(trashedPageId), 'trash-kept.png');
  await writeAged('55555', 'old.png');
  await writeYoung('66666', 'new.png');
  await writeAged('local', String(localPageId), 'tracked.png');
  await writeAged('local', String(localPageId), 'local-keep.png');
  await writeAged('local', String(localPageId), 'untracked.png');
  await writeYoung('local', String(localPageId), 'young-untracked.png');
  await writeAged('local', '99999', 'x.png');
  await ageDirs(
    '90001',
    String(standalonePageId),
    String(trashedPageId),
    '55555',
    path.join('local', String(localPageId)),
    path.join('local', '99999'),
  );

  return { userId, confPageId, standalonePageId, localPageId, trashedPageId };
}

describe.skipIf(!dbAvailable)('#1349 attachment sweep (integration)', () => {
  beforeAll(async () => {
    await setupTestDb();
    tempBase = await fs.mkdtemp(path.join(os.tmpdir(), 'compendiq-attachment-sweep-'));
    process.env.ATTACHMENTS_DIR = tempBase;
  });

  afterAll(async () => {
    await teardownTestDb();
    if (redis) {
      setRedisClient(null as unknown as RedisClientType);
      await redis.quit();
    }
    await fs.rm(tempBase, { recursive: true, force: true });
    if (originalAttachmentsDir) {
      process.env.ATTACHMENTS_DIR = originalAttachmentsDir;
    } else {
      delete process.env.ATTACHMENTS_DIR;
    }
  });

  beforeEach(async () => {
    await truncateAllTables();
    await fs.rm(tempBase, { recursive: true, force: true });
    await fs.mkdir(tempBase, { recursive: true });
    process.env.ATTACHMENTS_DIR = tempBase;
  });

  describe('buildAttachmentKeepSets', () => {
    it('keeps a filename referenced by ANY body anywhere, per store', async () => {
      await seedCorpus();
      const keep = await buildAttachmentKeepSets();

      for (const name of [
        'keep.png', 'Screen shot.png', 'anchor-kept.png', 'storage-kept.png',
        'draft-kept.png', 'version-kept.png', 'pending-kept.png',
        'pending-storage-kept.png', 'template-kept.png', "John's notes.png",
        'comment-kept.png', 'pasted.png', 'trash-kept.png',
      ]) {
        expect(keep.confluence.has(name), `confluence keep-set should hold ${name}`).toBe(true);
      }
      expect(keep.local.has('local-keep.png')).toBe(true);
      expect(keep.confluence.has('orphan.png')).toBe(false);
      expect(keep.confluence.has('untracked.png')).toBe(false);
    });

    // Review, external round: since #1361 `toPersistedSources` copies an image
    // source's `attachmentUrl` into `llm_conversations.messages`, and
    // `GET /llm/conversations/:id` renders the thumbnail back from it — so a
    // file whose only surviving reference is a saved answer was an orphan.
    it('keeps a filename referenced only by a persisted AI conversation turn (#1361)', async () => {
      const userId = await seedUser('chatter');
      await query(
        `INSERT INTO llm_conversations (user_id, model, title, messages)
         VALUES ($1, 'test-model', 'T', $2::jsonb)`,
        [
          userId,
          JSON.stringify([
            { role: 'user', content: 'what is this?' },
            {
              role: 'assistant',
              content: 'a diagram',
              sources: [
                {
                  kind: 'image',
                  title: 'Arch',
                  attachmentUrl: '/api/attachments/90001/answer-cited.png',
                },
                {
                  kind: 'image',
                  title: 'Local',
                  attachmentUrl: '/api/local-attachments/7/answer-local.png',
                },
              ],
            },
          ]),
        ],
      );

      const keep = await buildAttachmentKeepSets();
      expect(keep.confluence.has('answer-cited.png')).toBe(true);
      expect(keep.local.has('answer-local.png')).toBe(true);
    });

    // Review, external round: the UUID-keyed sources moved from
    // `id::text > $1 ORDER BY id::text` (unindexable, a full scan per batch)
    // to a native `id > $1::uuid`. The cursor is still carried as text, so a
    // corpus past one batch is what proves the pagination still terminates
    // AND still reaches the last row.
    it('paginates the UUID-keyed sources past one batch without losing a reference', async () => {
      const { confPageId } = await seedCorpus();
      // KEEP_SET_BATCH is 200; 250 rows forces a second and third page.
      await query(
        `INSERT INTO page_versions (page_id, version_number, title, body_html)
         SELECT $1, 100 + g, 'bulk', '<p><img src="/api/attachments/90001/bulk-' || g || '.png"></p>'
           FROM generate_series(1, 250) g`,
        [confPageId],
      );

      const keep = await buildAttachmentKeepSets();
      expect(keep.confluence.has('bulk-1.png')).toBe(true);
      expect(keep.confluence.has('bulk-250.png')).toBe(true);
      expect([...keep.confluence].filter((n) => n.startsWith('bulk-'))).toHaveLength(250);
    });
  });

  describe('dry run', () => {
    it('reports candidates and totals without touching a single file', async () => {
      const { localPageId } = await seedCorpus();

      const run = await runAttachmentSweep({ dryRun: true });

      expect(run).not.toBeNull();
      expect(run!.status).toBe('completed');
      expect(run!.dryRun).toBe(true);
      expect(run!.deleted).toBeNull();

      const byKey = (store: string, key: string, filename: string | null) =>
        run!.candidateSample.find(
          (c) => c.store === store && c.key === key && c.filename === filename,
        );

      // Exactly these candidates, and nothing else.
      expect(byKey('confluence', '90001', 'orphan.png')).toBeDefined();
      expect(byKey('confluence', '90001', 'external-aaaabbbbcccc.png')).toBeDefined();
      expect(byKey('confluence', '55555', null)).toBeDefined();
      expect(byKey('local', String(localPageId), 'untracked.png')).toBeDefined();
      expect(byKey('local', '99999', null)).toBeDefined();
      expect(run!.candidatesTotal).toBe(5);
      expect(run!.candidateSample).toHaveLength(5);

      // The young orphan directory is grace-skipped, never listed.
      expect(run!.candidateSample.find((c) => c.key === '66666')).toBeUndefined();

      // The per-file mtime grace, in BOTH stores: an unreferenced young file
      // inside a page's own directory — the paste-race state — is never a
      // candidate (review r1: the directory-level grace alone left this
      // unpinned).
      expect(byKey('confluence', '90001', 'young-orphan.png')).toBeUndefined();
      expect(byKey('local', String(localPageId), 'young-untracked.png')).toBeUndefined();
      expect(run!.stores!.confluence.graceSkipped).toBeGreaterThanOrEqual(2); // 66666/ + young-orphan.png
      expect(run!.stores!.local.graceSkipped).toBeGreaterThanOrEqual(1); // young-untracked.png

      // `local/` is never a candidate of the Confluence-tree walk.
      expect(run!.candidateSample.find((c) => c.store === 'confluence' && c.key === 'local')).toBeUndefined();

      // Rows whose file is missing are counted, never deleted.
      expect(run!.missingLocalFiles).toBe(1);
      const rows = await query(`SELECT filename FROM local_attachments WHERE filename = 'missing.png'`);
      expect(rows.rows).toHaveLength(1);

      // Nothing was touched — every seeded file is still on disk.
      for (const p of [
        path.join(tempBase, '90001', 'orphan.png'),
        path.join(tempBase, '90001', 'manual.pdf'),
        path.join(tempBase, '55555', 'old.png'),
        path.join(tempBase, '66666', 'new.png'),
        path.join(tempBase, 'local', String(localPageId), 'untracked.png'),
        path.join(tempBase, 'local', '99999', 'x.png'),
      ]) {
        expect(await exists(p), `${p} must survive a dry run`).toBe(true);
      }
    });

    it('counts stats per store and persists both the run and the stats record', async () => {
      await seedCorpus();
      const run = await runAttachmentSweep({ dryRun: true });

      const conf = run!.stores!.confluence;
      // 90001: 15 plain files (dot-file excluded) + pasted.png + trash-kept.png
      // + 55555/old.png + 66666/new.png = 19.
      expect(conf.files).toBe(19);
      expect(conf.directories).toBe(5);
      expect(conf.bytes).toBeGreaterThan(0);
      expect(conf.orphanDirectories).toBe(1);
      expect(conf.orphanFiles).toBe(1 + 1); // orphan.png + external-… (young-orphan.png grace-skipped)

      const local = run!.stores!.local;
      expect(local.files).toBe(5);
      expect(local.directories).toBe(2);
      expect(local.orphanDirectories).toBe(1);
      expect(local.orphanFiles).toBe(1);

      const persisted = await readAttachmentSweepLastRun();
      expect(persisted).toEqual(run);

      const stats = await readAttachmentStorageStatsRecord();
      expect(stats).not.toBeNull();
      expect(stats!.stores.confluence.files).toBe(19);
      expect(stats!.missingLocalFiles).toBe(1);
    });

    it('with an empty database, the local store is still never a Confluence-tree candidate', async () => {
      await writeAged('local', '123', 'x.png');
      await ageDirs('local', path.join('local', '123'));

      const run = await runAttachmentSweep({ dryRun: true });

      expect(run!.status).toBe('completed');
      expect(
        run!.candidateSample.find((c) => c.store === 'confluence' && c.key === 'local'),
      ).toBeUndefined();
      expect(await exists(path.join(tempBase, 'local', '123', 'x.png'))).toBe(true);
    });

    it('skips keys that do not match PAGE_ID_PATTERN — nothing outside the root is ever judged', async () => {
      await writeAged('weird name!', 'x.png');
      const run = await runAttachmentSweep({ dryRun: true });
      expect(run!.status).toBe('completed');
      expect(run!.candidateSample.find((c) => c.key === 'weird name!')).toBeUndefined();
      expect(await exists(path.join(tempBase, 'weird name!', 'x.png'))).toBe(true);
    });
  });

  describe('root sanity', () => {
    it('refuses (dry AND live) when the attachments root does not exist', async () => {
      process.env.ATTACHMENTS_DIR = path.join(tempBase, 'no-such-dir');

      const dry = await runAttachmentSweep({ dryRun: true });
      expect(dry!.status).toBe('refused');
      expect(dry!.note).toMatch(/root/i);
      expect(dry!.stores).toBeNull();

      const live = await runAttachmentSweep({ dryRun: false });
      expect(live!.status).toBe('refused');
      expect(live!.deleted).toBeNull();
    });

    it('a live run refuses when a store is empty on disk while the database references it', async () => {
      const { localPageId } = await seedCorpus();
      // Simulate a mis-mounted disk: the tree exists but is empty.
      await fs.rm(tempBase, { recursive: true, force: true });
      await fs.mkdir(tempBase, { recursive: true });

      const live = await runAttachmentSweep({ dryRun: false });
      expect(live!.status).toBe('refused');
      expect(live!.note).toMatch(/zero files|empty/i);
      expect(live!.deleted).toBeNull();

      // The rows were counted as missing, not deleted.
      const rows = await query(`SELECT 1 FROM local_attachments WHERE page_id = $1`, [localPageId]);
      expect(rows.rows.length).toBe(2);
    });

    // The two anomaly branches, each pinned ALONE (review r1: emptying both
    // stores let either branch's refusal satisfy the joint test, so disabling
    // one shipped green).
    it("an anomaly refusal leaves the last completed walk's stats record standing (review r1)", async () => {
      // The refusal exists BECAUSE the zero-file walk is suspected to be a
      // mis-mounted ATTACHMENTS_DIR — persisting those figures would clobber
      // the one reference record an operator diagnosing the mount would want,
      // and the PR's stated invariant is that only a completed walk writes it.
      await seedCorpus();
      const dry = await runAttachmentSweep({ dryRun: true });
      expect(dry!.status).toBe('completed');
      const before = await readAttachmentStorageStatsRecord();
      expect(before).not.toBeNull();
      expect(before!.stores.confluence.files).toBeGreaterThan(0);

      // Simulate the mis-mount: the tree exists but is empty.
      await fs.rm(tempBase, { recursive: true, force: true });
      await fs.mkdir(tempBase, { recursive: true });

      const live = await runAttachmentSweep({ dryRun: false });
      expect(live!.status).toBe('refused');
      // The RUN record still reports the zero-file walk it refused over…
      expect(live!.stores).not.toBeNull();
      expect((await readAttachmentSweepLastRun())!.status).toBe('refused');
      // …but the reference figures survive it untouched.
      expect(await readAttachmentStorageStatsRecord()).toEqual(before);
    });

    // Review r1: the anomaly is PER STORE. It used to be computed globally
    // and returned before the delete phase, so an instance whose Confluence
    // cache is legitimately empty could never sweep its LOCAL orphans — which
    // are not re-fetchable — at all. The anomalous store still stands down.
    it('an empty Confluence tree stands that store down and still sweeps the local one', async () => {
      const { localPageId } = await seedCorpus();
      for (const entry of await fs.readdir(tempBase)) {
        if (entry === 'local') continue;
        await fs.rm(path.join(tempBase, entry), { recursive: true, force: true });
      }

      const live = await runAttachmentSweep({ dryRun: false });
      expect(live!.status).toBe('completed');
      expect(live!.note).toMatch(/^confluence store/);
      // The sound store really was swept: its aged untracked orphan is gone…
      expect(await exists(path.join(tempBase, 'local', String(localPageId), 'untracked.png'))).toBe(
        false,
      );
      // …and its referenced/tracked/young files are not.
      expect(await exists(path.join(tempBase, 'local', String(localPageId), 'local-keep.png'))).toBe(
        true,
      );
      expect(await exists(path.join(tempBase, 'local', String(localPageId), 'tracked.png'))).toBe(true);
      expect(
        await exists(path.join(tempBase, 'local', String(localPageId), 'young-untracked.png')),
      ).toBe(true);
    });

    it('an empty local store stands that store down and still sweeps the Confluence tree', async () => {
      const { standalonePageId } = await seedCorpus();
      await fs.rm(path.join(tempBase, 'local'), { recursive: true, force: true });

      const live = await runAttachmentSweep({ dryRun: false });
      expect(live!.status).toBe('completed');
      expect(live!.note).toMatch(/^local store/);
      // Swept: the pageless aged directory and the per-file orphan.
      expect(await exists(path.join(tempBase, '55555'))).toBe(false);
      expect(await exists(path.join(tempBase, '90001', 'orphan.png'))).toBe(false);
      // Kept: everything referenced anywhere, and the standalone's own paste.
      expect(await exists(path.join(tempBase, '90001', 'keep.png'))).toBe(true);
      expect(await exists(path.join(tempBase, String(standalonePageId), 'pasted.png'))).toBe(true);
    });
  });

  // Review r1 (security). `readKeyDir` counts only `entry.isFile()`, so for a
  // directory holding ONLY subdirectories `files` is `[]` — which makes both
  // safety checks in `judgeDirectoryOrphan` vacuous (`some(keep.has)` false,
  // `every(aged)` vacuously true) and made the whole tree a `bytes: 0`
  // `rm -rf` candidate, with the dry run reporting 0 B so a review of its
  // output could not show what was about to be destroyed. That is exactly how
  // the page-icon store was lost; `ATTACHMENT_ROOT_RESERVED_DIRNAMES` closed
  // that instance BY NAME. These pin the structural close.
  describe('nested directories are never judged', () => {
    it('an aged pageless directory whose files sit one level deeper survives a live run', async () => {
      await seedCorpus();
      const buried = await writeAged('4242', 'space-DEV', 'important.bin');
      await ageDirs(path.join('4242', 'space-DEV'), '4242');

      const live = await runAttachmentSweep({ dryRun: false });

      expect(live!.status).toBe('completed');
      expect(await exists(buried)).toBe(true);
      expect(await exists(path.join(tempBase, '4242'))).toBe(true);
      // Reported rather than judged: no candidate names it, and the counter
      // says it was left standing.
      expect(live!.candidateSample.some((c) => c.key === '4242')).toBe(false);
      expect(live!.stores!.confluence.nestedDirectories).toBe(1);
      // Sanity: the ordinary flat orphan beside it still went.
      expect(await exists(path.join(tempBase, '55555'))).toBe(false);
    });

    it('the delete-time re-check refuses a directory that gained a subdirectory since the listing', async () => {
      await seedCorpus();
      const dry = await runAttachmentSweep({ dryRun: true });
      const candidate = dry!.candidateSample.find(
        (c) => c.reason === 'orphan_directory' && c.key === '55555',
      );
      expect(candidate).toBeDefined();

      // The tree changes between the listing and the delete.
      const buried = await writeAged('55555', 'later', 'arrived.bin');
      await ageDirs(path.join('55555', 'later'), '55555');

      await deleteCandidates(
        [candidate!],
        await buildAttachmentKeepSets(),
        () => undefined,
        emptyDeletedTotals(),
      );

      expect(await exists(buried)).toBe(true);
      expect(await exists(path.join(tempBase, '55555', 'old.png'))).toBe(true);
    });
  });

  // Review r1: decision (e)'s "a directory must have been successfully
  // readdir'd before any of its files can be judged" — and the counter that
  // reports it — had no backend test at all. The two EACCES tests below
  // exercise a failing `rm`, not a failing `readdir`.
  describe('unreadable directories', () => {
    it.skipIf(process.getuid?.() === 0)(
      'counts an unreadable key directory, emits no candidate for it, and leaves it standing',
      async () => {
        await seedCorpus();
        // A pageless, aged directory that would otherwise be a clean orphan.
        await writeAged('77777', 'old.png');
        await ageDirs('77777');
        const sealed = path.join(tempBase, '77777');
        await fs.chmod(sealed, 0o000);
        try {
          const live = await runAttachmentSweep({ dryRun: false });

          expect(live!.status).toBe('completed');
          expect(live!.stores!.confluence.unreadableDirectories).toBe(1);
          expect(live!.candidateSample.some((c) => c.key === '77777')).toBe(false);
          expect(await exists(sealed)).toBe(true);
          // …and it is not counted as walked content either.
          expect(await exists(path.join(tempBase, '55555'))).toBe(false);
        } finally {
          await fs.chmod(sealed, 0o700);
        }
      },
    );
  });

  describe('live run', () => {
    const VEC_2048 = '[' + new Array(2048).fill(0).join(',') + ']';

    async function seedEmbeddingRow(pageId: number, source: string, key: string): Promise<void> {
      await query(
        `INSERT INTO page_image_embeddings (page_id, source, attachment_key, sha256, format, model, embedding)
         VALUES ($1, $2, $3, 'sha', 'png', 'test-model', $4::vector)`,
        [pageId, source, key, VEC_2048],
      );
    }

    it('deletes exactly the orphans, prunes their index rows and marks owners dirty', async () => {
      const { confPageId, localPageId } = await seedCorpus();
      await query(`UPDATE pages SET image_embedding_dirty = FALSE WHERE id = ANY($1::int[])`, [
        [confPageId, localPageId],
      ]);
      // A row for the orphan (the safety net under test) and one for a kept
      // file (which must survive the prune).
      await seedEmbeddingRow(confPageId, 'confluence', 'orphan.png');
      await seedEmbeddingRow(confPageId, 'confluence', 'keep.png');
      await seedEmbeddingRow(localPageId, 'local', 'untracked.png');

      const run = await runAttachmentSweep({ dryRun: false });

      expect(run!.status).toBe('completed');
      expect(run!.dryRun).toBe(false);

      // The orphans are gone…
      for (const p of [
        path.join(tempBase, '90001', 'orphan.png'),
        path.join(tempBase, '90001', 'external-aaaabbbbcccc.png'),
        path.join(tempBase, '55555'),
        path.join(tempBase, 'local', String(localPageId), 'untracked.png'),
        path.join(tempBase, 'local', '99999'),
      ]) {
        expect(await exists(p), `${p} must be deleted by a live run`).toBe(false);
      }

      // …and NOTHING else: every referenced file, the non-image cached
      // attachment, the dot-file, the young grace-window directory and the
      // tracked local file all survive.
      for (const p of [
        path.join(tempBase, '90001', 'keep.png'),
        path.join(tempBase, '90001', 'Screen shot.png'),
        path.join(tempBase, '90001', 'anchor-kept.png'),
        path.join(tempBase, '90001', 'storage-kept.png'),
        path.join(tempBase, '90001', 'draft-kept.png'),
        path.join(tempBase, '90001', 'version-kept.png'),
        path.join(tempBase, '90001', 'pending-kept.png'),
        path.join(tempBase, '90001', 'pending-storage-kept.png'),
        path.join(tempBase, '90001', 'template-kept.png'),
        path.join(tempBase, '90001', "John's notes.png"),
        path.join(tempBase, '90001', 'comment-kept.png'),
        path.join(tempBase, '90001', 'manual.pdf'),
        path.join(tempBase, '90001', '.DS_Store'),
        path.join(tempBase, '90001', 'young-orphan.png'),
        path.join(tempBase, '66666', 'new.png'),
        path.join(tempBase, 'local', String(localPageId), 'tracked.png'),
        path.join(tempBase, 'local', String(localPageId), 'local-keep.png'),
        path.join(tempBase, 'local', String(localPageId), 'young-untracked.png'),
      ]) {
        expect(await exists(p), `${p} must survive a live run`).toBe(true);
      }

      // Deleted totals: 3 per-file orphans + 2 directory orphans of 1 file each.
      expect(run!.deleted).toMatchObject({ directories: 2, files: 5 });
      expect(run!.deleted!.bytes).toBeGreaterThan(0);

      // Index rows for deleted files are pruned; rows for kept files stay.
      const rows = await query<{ attachment_key: string }>(
        `SELECT attachment_key FROM page_image_embeddings ORDER BY attachment_key`,
      );
      expect(rows.rows.map((r) => r.attachment_key)).toEqual(['keep.png']);
      expect(run!.deleted!.imageEmbeddingRows).toBe(2);

      // Owners of deleted files are re-queued for the image index.
      const dirty = await query<{ id: number; image_embedding_dirty: boolean }>(
        `SELECT id, image_embedding_dirty FROM pages WHERE id = ANY($1::int[]) ORDER BY id`,
        [[confPageId, localPageId]],
      );
      expect(dirty.rows.every((r) => r.image_embedding_dirty)).toBe(true);
      expect(run!.deleted!.pagesMarkedDirty).toBeGreaterThanOrEqual(2);

      // The missing-file row is still counted, never deleted.
      expect(run!.missingLocalFiles).toBe(1);
      const missingRow = await query(`SELECT 1 FROM local_attachments WHERE filename = 'missing.png'`);
      expect(missingRow.rows).toHaveLength(1);
    });

    // Fixer, external round — permanent data loss. `page-icons/` is a store of
    // its own under the SAME root, its name passes PAGE_ID_PATTERN (`-` is in
    // the class), and no page row claims the key. `readKeyDir` sees only its
    // per-page SUBDIRECTORIES, so `files` is empty, the keep-set check is
    // vacuous and `[].every()` collapses the grace check onto the directory's
    // own mtime — a live run then removed the whole tree recursively. The
    // uploaded marks are the only copy (migrations 095/096 store only the sha),
    // so every page icon 404s until re-upload, reported as "1 directory (0 B)".
    it('never judges the page-icon store — a live run leaves every uploaded mark standing', async () => {
      const { confPageId } = await seedCorpus();
      const sha = 'a'.repeat(64);
      const icon = await writeAged('page-icons', String(confPageId), `${sha}.png`);
      await ageDirs('page-icons', path.join('page-icons', String(confPageId)));

      const run = await runAttachmentSweep({ dryRun: false });

      expect(run!.status).toBe('completed');
      expect(await exists(icon), 'the uploaded page mark must survive a live sweep').toBe(true);
      expect(await exists(path.join(tempBase, 'page-icons'))).toBe(true);
      // Not merely spared at delete time: never listed, and never counted as
      // one of the Confluence tree's directories.
      expect(run!.candidateSample.some((c) => c.key === 'page-icons')).toBe(false);
      const dry = await runAttachmentSweep({ dryRun: true });
      expect(dry!.stores!.confluence.orphanDirectories).toBe(0);
    });

    // Fixer, external round: the record the card polls must describe the tree
    // as it is NOW. Persisting the pre-delete walk showed the orphans the run
    // had just destroyed as current candidates, dated "Measured just now",
    // beside "deleted N files" — so the operator presses Delete orphans again.
    it('a completed live run persists POST-delete figures, not the walk it swept with', async () => {
      await seedCorpus();

      const before = await runAttachmentSweep({ dryRun: true });
      expect(before!.stores!.confluence.orphanFiles).toBeGreaterThan(0);
      expect(before!.stores!.confluence.orphanDirectories).toBeGreaterThan(0);

      const live = await runAttachmentSweep({ dryRun: false });
      expect(live!.status).toBe('completed');
      expect(live!.deleted!.files).toBeGreaterThan(0);

      const record = await readAttachmentStorageStatsRecord();
      expect(record).not.toBeNull();
      for (const store of ['confluence', 'local'] as const) {
        expect(record!.stores[store].orphanFiles, `${store} orphan files`).toBe(0);
        expect(record!.stores[store].orphanDirectories, `${store} orphan dirs`).toBe(0);
        expect(record!.stores[store].orphanFileBytes).toBe(0);
        expect(record!.stores[store].orphanDirectoryBytes).toBe(0);
      }

      // And the size/count figures match a fresh walk of what is left.
      const after = await runAttachmentSweep({ dryRun: true });
      for (const store of ['confluence', 'local'] as const) {
        expect(record!.stores[store].bytes, `${store} bytes`).toBe(after!.stores![store].bytes);
        expect(record!.stores[store].files, `${store} files`).toBe(after!.stores![store].files);
        expect(record!.stores[store].directories, `${store} dirs`).toBe(
          after!.stores![store].directories,
        );
      }
    });

    it('emits a RETENTION_PRUNED audit event with the counts', async () => {
      await seedCorpus();
      const run = await runAttachmentSweep({ dryRun: false });
      expect(run!.status).toBe('completed');

      const audit = await query<{
        user_id: string | null;
        metadata: { dry_run: boolean; files_pruned: number };
      }>(
        `SELECT user_id, metadata FROM audit_log
          WHERE action = 'RETENTION_PRUNED' AND resource_id = 'attachments_orphan_sweep'
          ORDER BY created_at DESC LIMIT 1`,
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]!.metadata.dry_run).toBe(false);
      expect(audit.rows[0]!.metadata.files_pruned).toBeGreaterThan(0);
      // The audit states what was FOUND beside what was destroyed, so it
      // reads the WALK, never the run record's post-delete residue —
      // `orphan_files: 0` beside a non-zero `files_pruned` contradicts itself.
      expect(audit.rows[0]!.metadata.orphan_files).toBeGreaterThan(0);
      expect(audit.rows[0]!.metadata.orphan_directories).toBeGreaterThan(0);
      // No `triggeredBy` (a non-request caller): a null-actor system event.
      expect(audit.rows[0]!.user_id).toBeNull();
    });

    // Review, external round: the first cut's side-channel carried only
    // `deleted`, so a run that threw mid-delete recorded `stores: null` and
    // `candidatesTotal: 0` although the walk had completed — and its audit row
    // then said `orphan_files: 0` beside a non-zero `files_pruned`.
    it('a run that fails mid-delete still records the walk it completed', async () => {
      await seedCorpus();
      // A directory whose files cannot be unlinked (no write bit on the
      // directory itself): the delete loop reaches its orphan and throws.
      const locked = path.join(tempBase, '90001');
      await fs.chmod(locked, 0o500);
      let run: Awaited<ReturnType<typeof runAttachmentSweep>>;
      try {
        run = await runAttachmentSweep({ dryRun: false });
      } finally {
        await fs.chmod(locked, 0o700);
      }

      expect(run!.status).toBe('failed');
      expect(run!.stores, 'the completed walk must survive the failure').not.toBeNull();
      expect(run!.candidatesTotal).toBeGreaterThan(0);
      expect(run!.deleted).not.toBeNull();

      const audit = await query<{
        metadata: { orphan_files: number; files_pruned: number; status: string };
      }>(
        `SELECT metadata FROM audit_log
          WHERE action = 'RETENTION_PRUNED' AND resource_id = 'attachments_orphan_sweep'
          ORDER BY created_at DESC LIMIT 1`,
      );
      expect(audit.rows[0]!.metadata.status).toBe('failed');
      expect(audit.rows[0]!.metadata.orphan_files).toBeGreaterThan(0);
    });

    // Verification round r1: the sweep is manual-only, so every destructive
    // run has an admin behind it — an audit trail that records files were
    // permanently deleted but never WHO pressed Delete orphans is half a
    // trail. The route threads its `request.userId` through `triggeredBy`.
    it('attributes the audit event to the triggering admin when triggeredBy is passed', async () => {
      const adminId = await seedUser('sweep-admin');
      const run = await runAttachmentSweep({ dryRun: true, triggeredBy: adminId });
      expect(run!.status).toBe('completed');

      const audit = await query<{ user_id: string | null }>(
        `SELECT user_id FROM audit_log
          WHERE action = 'RETENTION_PRUNED' AND resource_id = 'attachments_orphan_sweep'
          ORDER BY created_at DESC LIMIT 1`,
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]!.user_id).toBe(adminId);
    });

    // Review r1: a throw mid-delete (an EACCES here; a lost worker lock in
    // production) must still record, audit and dirty-mark the destructive
    // work already done — `deleted: null` + `files_pruned: 0` under-reported
    // exactly the runs an operator most needs to audit. The EACCES also pins
    // the local-store deleter's honesty: a swallowed `fs.rm` error used to be
    // counted as a deletion that never happened.
    it.skipIf(process.getuid?.() === 0)(
      'a live run that fails mid-delete records the partial totals, audits them and still dirty-marks',
      async () => {
        const { confPageId, localPageId } = await seedCorpus();
        await query(`UPDATE pages SET image_embedding_dirty = FALSE WHERE id = $1`, [confPageId]);
        await seedEmbeddingRow(confPageId, 'confluence', 'orphan.png');

        // Read-only parent directory: the rm of local/<id>/untracked.png
        // fails with EACCES after every Confluence-tree candidate (which the
        // delete loop visits first) has already been removed.
        const lockedDir = path.join(tempBase, 'local', String(localPageId));
        await fs.chmod(lockedDir, 0o555);
        try {
          const run = await runAttachmentSweep({ dryRun: false });

          expect(run!.status).toBe('failed');
          // The delete phase started, so the partial totals are recorded…
          expect(run!.deleted).not.toBeNull();
          expect(run!.deleted!.files).toBeGreaterThanOrEqual(3);
          expect(await exists(path.join(tempBase, '90001', 'orphan.png'))).toBe(false);
          // …and the file whose rm failed is neither deleted nor counted.
          expect(await exists(path.join(lockedDir, 'untracked.png'))).toBe(true);
          expect(run!.deleted!.files).toBeLessThanOrEqual(4);

          // The audit event carries the partial counts, not zero.
          const audit = await query<{ metadata: { status: string; files_pruned: number } }>(
            `SELECT metadata FROM audit_log
              WHERE action = 'RETENTION_PRUNED' AND resource_id = 'attachments_orphan_sweep'
              ORDER BY created_at DESC LIMIT 1`,
          );
          expect(audit.rows[0]!.metadata.status).toBe('failed');
          expect(audit.rows[0]!.metadata.files_pruned).toBe(run!.deleted!.files);

          // Owners of files that WERE deleted are re-queued despite the throw.
          expect(run!.deleted!.imageEmbeddingRows).toBe(1);
          expect(run!.deleted!.pagesMarkedDirty).toBeGreaterThanOrEqual(1);
          const dirty = await query<{ image_embedding_dirty: boolean }>(
            `SELECT image_embedding_dirty FROM pages WHERE id = $1`,
            [confPageId],
          );
          expect(dirty.rows[0]!.image_embedding_dirty).toBe(true);
        } finally {
          await fs.chmod(lockedDir, 0o755);
        }
      },
    );
  });

  /**
   * Fixer r1: the acceptance criterion "never deletes files referenced by a
   * live body, draft, retained version, pending sync version, template,
   * comment or trashed page" is UNIVERSAL — it does not stop at the
   * directory boundary. A directory whose page row is gone (a legacy leak
   * from before the #1349 hard-delete fix) can still hold a file a template
   * or another page's body references by URL, and deleting the directory
   * whole would take that file with it. The keep-set outranks the
   * directory-level verdict: such a directory is skipped (counted as
   * `keepProtectedDirectories`), conservative by construction.
   */
  describe('directory-level candidates consult the keep-set (fixer r1)', () => {
    it('a pageless directory holding a template-referenced file is never a candidate, in both stores', async () => {
      const userId = await seedUser();
      // NO page row claims key 77777 (Confluence tree) or 88888 (local
      // store); the template body is each file's ONLY reference anywhere.
      await query(
        `INSERT INTO templates (title, body_json, body_html, created_by)
         VALUES ('T', '{}',
                 '<p><img src="/api/attachments/77777/legacy.png"><img src="/api/local-attachments/88888/local-legacy.png"></p>',
                 $1)`,
        [userId],
      );
      await writeAged('77777', 'legacy.png');
      await writeAged('77777', 'junk.png');
      await writeAged('local', '88888', 'local-legacy.png');
      await ageDirs('77777', path.join('local', '88888'));

      const dry = await runAttachmentSweep({ dryRun: true });
      expect(dry!.status).toBe('completed');
      expect(dry!.candidateSample.find((c) => c.key === '77777')).toBeUndefined();
      expect(dry!.candidateSample.find((c) => c.key === '88888')).toBeUndefined();
      expect(dry!.stores!.confluence.keepProtectedDirectories).toBe(1);
      expect(dry!.stores!.local.keepProtectedDirectories).toBe(1);
      expect(dry!.stores!.confluence.orphanDirectories).toBe(0);
      expect(dry!.stores!.local.orphanDirectories).toBe(0);

      const live = await runAttachmentSweep({ dryRun: false });
      expect(live!.status).toBe('completed');
      // The whole directory is skipped, unreferenced siblings included —
      // all-or-nothing is the conservative direction for a directory verdict.
      for (const p of [
        path.join(tempBase, '77777', 'legacy.png'),
        path.join(tempBase, '77777', 'junk.png'),
        path.join(tempBase, 'local', '88888', 'local-legacy.png'),
      ]) {
        expect(await exists(p), `${p} must survive a live run`).toBe(true);
      }
    });
  });

  /**
   * The DECISIONS' binding "a live run deletes ONLY what the same walk would
   * list now" — exercised directly against `deleteCandidates` with hand-built
   * (i.e. deliberately stale) candidates, because through `runAttachmentSweep`
   * the walk and the delete run back-to-back and nothing can change in
   * between (review r1: all three re-checks were deletable without a red
   * test).
   */
  describe('delete-time re-verification (deleteCandidates)', () => {
    const noAbort = () => undefined;
    const emptyKeep = () => ({ confluence: new Set<string>(), local: new Set<string>() });
    const dirCandidate = (store: 'confluence' | 'local', key: string): AttachmentSweepCandidate => ({
      store,
      key,
      filename: null,
      bytes: 0,
      reason: 'orphan_directory',
    });
    const fileCandidate = (
      store: 'confluence' | 'local',
      key: string,
      filename: string,
    ): AttachmentSweepCandidate => ({ store, key, filename, bytes: 0, reason: 'orphan_file' });

    it('a directory whose page appeared since the listing survives, in both stores (first-sync race)', async () => {
      const userId = await seedUser();
      await writeAged('55555', 'old.png');
      await ageDirs('55555');
      const local = await query<{ id: number }>(
        `INSERT INTO pages (title, space_key, source, page_type, version, body_html, created_by_user_id)
         VALUES ('Late local', 'LOCAL', 'standalone', 'page', 1, '', $1) RETURNING id`,
        [userId],
      );
      const localId = local.rows[0]!.id;
      await writeAged('local', String(localId), 'x.png');
      await ageDirs(path.join('local', String(localId)));
      // The page rows land AFTER the (simulated) walk listed both directories.
      await query(
        `INSERT INTO pages (title, space_key, confluence_id, source, page_type, version)
         VALUES ('Late conf', 'DEV', '55555', 'confluence', 'page', 1)`,
      );

      const totals = emptyDeletedTotals();
      await deleteCandidates(
        [dirCandidate('confluence', '55555'), dirCandidate('local', String(localId))],
        emptyKeep(),
        noAbort,
        totals,
      );

      expect(await exists(path.join(tempBase, '55555', 'old.png'))).toBe(true);
      expect(await exists(path.join(tempBase, 'local', String(localId), 'x.png'))).toBe(true);
      expect(totals.directories).toBe(0);
      expect(totals.files).toBe(0);
    });

    it('a directory that gained a young file since the listing survives (grace re-check)', async () => {
      await writeAged('55555', 'old.png');
      await writeYoung('55555', 'fresh.png');
      await ageDirs('55555'); // dir mtime aged — only the contained file is young

      const totals = emptyDeletedTotals();
      await deleteCandidates([dirCandidate('confluence', '55555')], emptyKeep(), noAbort, totals);

      expect(await exists(path.join(tempBase, '55555', 'old.png'))).toBe(true);
      expect(await exists(path.join(tempBase, '55555', 'fresh.png'))).toBe(true);
      expect(totals.directories).toBe(0);
    });

    it('a file rewritten inside the grace window since the listing survives (stat re-check)', async () => {
      await writeYoung('90001', 'rewritten.png'); // young NOW; the stale candidate listed it aged

      const totals = emptyDeletedTotals();
      await deleteCandidates(
        [fileCandidate('confluence', '90001', 'rewritten.png')],
        emptyKeep(),
        noAbort,
        totals,
      );

      expect(await exists(path.join(tempBase, '90001', 'rewritten.png'))).toBe(true);
      expect(totals.files).toBe(0);
    });

    it('a directory candidate whose contents include a kept filename survives at delete time (fixer r1)', async () => {
      // The walk already refuses such a directory; this pins the delete-time
      // re-check against a stale candidate list, per store — a file carrying
      // a kept name can land in the directory between the walk and the
      // delete loop reaching it.
      await writeAged('55555', 'kept.png');
      await ageDirs('55555');
      await writeAged('local', '99999', 'local-kept.png');
      await ageDirs(path.join('local', '99999'));

      const totals = emptyDeletedTotals();
      await deleteCandidates(
        [dirCandidate('confluence', '55555'), dirCandidate('local', '99999')],
        { confluence: new Set(['kept.png']), local: new Set(['local-kept.png']) },
        noAbort,
        totals,
      );

      expect(await exists(path.join(tempBase, '55555', 'kept.png'))).toBe(true);
      expect(await exists(path.join(tempBase, 'local', '99999', 'local-kept.png'))).toBe(true);
      expect(totals.directories).toBe(0);
      expect(totals.files).toBe(0);
    });

    it('sanity: an unchanged orphan still falls through every re-check and is deleted', async () => {
      await writeAged('55555', 'old.png');
      await ageDirs('55555');
      await writeAged('90001', 'gone.png');

      const totals = emptyDeletedTotals();
      await deleteCandidates(
        [dirCandidate('confluence', '55555'), fileCandidate('confluence', '90001', 'gone.png')],
        emptyKeep(),
        noAbort,
        totals,
      );

      expect(await exists(path.join(tempBase, '55555'))).toBe(false);
      expect(await exists(path.join(tempBase, '90001', 'gone.png'))).toBe(false);
      expect(totals.directories).toBe(1);
      expect(totals.files).toBe(2); // the directory's one file + gone.png
    });
  });

  describe('persisted reads', () => {
    it('the stats/last-run readers never touch the filesystem — the card polls them', async () => {
      await seedCorpus();
      await runAttachmentSweep({ dryRun: true });

      const readdirSpy = vi.spyOn(fs, 'readdir');
      const statSpy = vi.spyOn(fs, 'stat');
      try {
        expect(await readAttachmentStorageStatsRecord()).not.toBeNull();
        expect(await readAttachmentSweepLastRun()).not.toBeNull();
        expect(readdirSpy).not.toHaveBeenCalled();
        expect(statSpy).not.toHaveBeenCalled();
      } finally {
        readdirSpy.mockRestore();
        statSpy.mockRestore();
      }
    });
  });

  describe('single-flight', () => {
    it.skipIf(!redis)('answers null while another holder has the sweep lock', async () => {
      const held = await acquireWorkerLock(ATTACHMENT_SWEEP_WORKER_LOCK, 60);
      expect(held).not.toBeNull();
      try {
        const run = await runAttachmentSweep({ dryRun: true });
        expect(run).toBeNull();
      } finally {
        await releaseWorkerLock(ATTACHMENT_SWEEP_WORKER_LOCK, held!);
      }
    });
  });
});
