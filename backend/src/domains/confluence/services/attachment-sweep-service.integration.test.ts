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
  await query(
    `INSERT INTO templates (title, body_json, body_html, created_by)
     VALUES ('T', '{}', '<p><img src="/api/attachments/90001/template-kept.png"></p>', $1)`,
    [userId],
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
        'pending-storage-kept.png', 'template-kept.png', 'comment-kept.png',
        'pasted.png', 'trash-kept.png',
      ]) {
        expect(keep.confluence.has(name), `confluence keep-set should hold ${name}`).toBe(true);
      }
      expect(keep.local.has('local-keep.png')).toBe(true);
      expect(keep.confluence.has('orphan.png')).toBe(false);
      expect(keep.confluence.has('untracked.png')).toBe(false);
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
      // 90001: 14 plain files (dot-file excluded) + pasted.png + trash-kept.png
      // + 55555/old.png + 66666/new.png = 18.
      expect(conf.files).toBe(18);
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
      expect(stats!.stores.confluence.files).toBe(18);
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
    it('refuses on its confluence branch when only the Confluence tree is empty', async () => {
      const { localPageId } = await seedCorpus();
      for (const entry of await fs.readdir(tempBase)) {
        if (entry === 'local') continue;
        await fs.rm(path.join(tempBase, entry), { recursive: true, force: true });
      }

      const live = await runAttachmentSweep({ dryRun: false });
      expect(live!.status).toBe('refused');
      expect(live!.note).toMatch(/^confluence store/);
      expect(live!.deleted).toBeNull();
      // The intact local store was not touched — the refusal is run-wide.
      expect(await exists(path.join(tempBase, 'local', String(localPageId), 'untracked.png'))).toBe(true);
    });

    it('refuses on its local branch when only the local store is empty', async () => {
      await seedCorpus();
      await fs.rm(path.join(tempBase, 'local'), { recursive: true, force: true });

      const live = await runAttachmentSweep({ dryRun: false });
      expect(live!.status).toBe('refused');
      expect(live!.note).toMatch(/^local store/);
      expect(live!.deleted).toBeNull();
      // The intact Confluence tree was not touched — the refusal is run-wide.
      expect(await exists(path.join(tempBase, '90001', 'orphan.png'))).toBe(true);
    });
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

    it('emits a RETENTION_PRUNED audit event with the counts', async () => {
      await seedCorpus();
      const run = await runAttachmentSweep({ dryRun: false });
      expect(run!.status).toBe('completed');

      const audit = await query<{ metadata: { dry_run: boolean; files_pruned: number } }>(
        `SELECT metadata FROM audit_log
          WHERE action = 'RETENTION_PRUNED' AND resource_id = 'attachments_orphan_sweep'
          ORDER BY created_at DESC LIMIT 1`,
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]!.metadata.dry_run).toBe(false);
      expect(audit.rows[0]!.metadata.files_pruned).toBeGreaterThan(0);
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
   * The DECISIONS' binding "a live run deletes ONLY what the same walk would
   * list now" — exercised directly against `deleteCandidates` with hand-built
   * (i.e. deliberately stale) candidates, because through `runAttachmentSweep`
   * the walk and the delete run back-to-back and nothing can change in
   * between (review r1: all three re-checks were deletable without a red
   * test).
   */
  describe('delete-time re-verification (deleteCandidates)', () => {
    const noAbort = () => undefined;
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
      await deleteCandidates([dirCandidate('confluence', '55555')], noAbort, totals);

      expect(await exists(path.join(tempBase, '55555', 'old.png'))).toBe(true);
      expect(await exists(path.join(tempBase, '55555', 'fresh.png'))).toBe(true);
      expect(totals.directories).toBe(0);
    });

    it('a file rewritten inside the grace window since the listing survives (stat re-check)', async () => {
      await writeYoung('90001', 'rewritten.png'); // young NOW; the stale candidate listed it aged

      const totals = emptyDeletedTotals();
      await deleteCandidates([fileCandidate('confluence', '90001', 'rewritten.png')], noAbort, totals);

      expect(await exists(path.join(tempBase, '90001', 'rewritten.png'))).toBe(true);
      expect(totals.files).toBe(0);
    });

    it('sanity: an unchanged orphan still falls through every re-check and is deleted', async () => {
      await writeAged('55555', 'old.png');
      await ageDirs('55555');
      await writeAged('90001', 'gone.png');

      const totals = emptyDeletedTotals();
      await deleteCandidates(
        [dirCandidate('confluence', '55555'), fileCandidate('confluence', '90001', 'gone.png')],
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
