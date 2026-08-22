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
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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
import {
  ATTACHMENT_SWEEP_GRACE_MS,
  ATTACHMENT_SWEEP_WORKER_LOCK,
  buildAttachmentKeepSets,
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
 * external-cache image, an unreferenced non-image, and a dot-file. Directory
 * `55555` belongs to no page (aged orphan), `66666` to no page but young
 * (grace), and the local store carries a tracked file, an untracked orphan,
 * a row with no file, and an orphan directory `99999`.
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
  await writeAged(String(standalonePageId), 'pasted.png');
  await writeAged(String(trashedPageId), 'trash-kept.png');
  await writeAged('55555', 'old.png');
  await writeYoung('66666', 'new.png');
  await writeAged('local', String(localPageId), 'tracked.png');
  await writeAged('local', String(localPageId), 'local-keep.png');
  await writeAged('local', String(localPageId), 'untracked.png');
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
      expect(run!.stores!.confluence.graceSkipped).toBeGreaterThanOrEqual(1);

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
      // 90001: 13 plain files (dot-file excluded) + pasted.png + trash-kept.png
      // + 55555/old.png + 66666/new.png = 17.
      expect(conf.files).toBe(17);
      expect(conf.directories).toBe(5);
      expect(conf.bytes).toBeGreaterThan(0);
      expect(conf.orphanDirectories).toBe(1);
      expect(conf.orphanFiles).toBe(1 + 1); // orphan.png + external-…

      const local = run!.stores!.local;
      expect(local.files).toBe(4);
      expect(local.directories).toBe(2);
      expect(local.orphanDirectories).toBe(1);
      expect(local.orphanFiles).toBe(1);

      const persisted = await readAttachmentSweepLastRun();
      expect(persisted).toEqual(run);

      const stats = await readAttachmentStorageStatsRecord();
      expect(stats).not.toBeNull();
      expect(stats!.stores.confluence.files).toBe(17);
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
