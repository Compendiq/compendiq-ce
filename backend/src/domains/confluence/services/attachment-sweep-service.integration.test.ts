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
  CANDIDATE_SAMPLE_MAX,
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

    // #1525 — a draw.io diagram whose macro survives only in the UNPUBLISHED
    // draft. `draft_body_storage` fed no keep-set source, and the macro never
    // renders as an `/api/attachments/…` URL (the editor emits
    // `img.src = '#drawio:<name>'`), so neither the URL collector over
    // `draft_body_html` nor the storage pass over `body_storage` could see it:
    // the sweep deleted the PNG out from under a draft the author had not
    // published yet.
    it('keeps attachments referenced only by an unpublished draft body_storage (#1525)', async () => {
      await query(
        `INSERT INTO pages (title, space_key, confluence_id, source, page_type, version,
                            body_html, body_storage, draft_body_html, draft_body_storage)
         VALUES ('Drafting', 'DEV', '90007', 'confluence', 'page', 1,
                 '<p><img src="/api/attachments/90007/published.png"></p>',
                 '<ac:image><ri:attachment ri:filename="published-storage.png"/></ac:image>',
                 '<p>no image yet</p>',
                 '<ac:structured-macro ac:name="drawio"><ac:parameter ac:name="diagramName">DraftOnlyArch</ac:parameter></ac:structured-macro>'
                 || '<p><img src="/api/attachments/90007/draft-storage-url.png"></p>')`,
      );

      const keep = await buildAttachmentKeepSets();

      // The enumerator half: the macro names `DraftOnlyArch.png`, which no
      // URL regex can ever find.
      expect(keep.confluence.has('DraftOnlyArch.png')).toBe(true);
      // The URL-collector half of the same two-line treatment.
      expect(keep.confluence.has('draft-storage-url.png')).toBe(true);
      // Control: the published halves were already kept.
      expect(keep.confluence.has('published.png')).toBe(true);
      expect(keep.confluence.has('published-storage.png')).toBe(true);
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

    /**
     * Fixer r1 — `CANDIDATE_SAMPLE_MAX` was exercised by nothing: dropping
     * the `.slice()` left the suite green, so the bound on the persisted
     * `admin_settings` JSON row (and on the list the card renders) could be
     * lost silently, and the largest fixture here produced five candidates.
     * The sample is a SAMPLE; the true count lives in `candidatesTotal`, and
     * the card's "Showing the first N of M" line reads both.
     */
    it('caps the persisted candidate sample while reporting the true total', async () => {
      const overCap = CANDIDATE_SAMPLE_MAX + 17;
      await query(
        `INSERT INTO pages (title, space_key, confluence_id, source, page_type, version, body_html)
         VALUES ('Big', 'DEV', '70001', 'confluence', 'page', 1, '<p>no images</p>')`,
      );
      for (let i = 0; i < overCap; i += 1) {
        await writeAged('70001', `orphan-${i}.png`);
      }
      await ageDirs('70001');

      const run = await runAttachmentSweep({ dryRun: true });
      expect(run!.status).toBe('completed');
      expect(run!.candidatesTotal).toBe(overCap);
      expect(run!.candidateSample).toHaveLength(CANDIDATE_SAMPLE_MAX);
      // …and the persisted record carries the capped list, not the full one.
      const persisted = await readAttachmentSweepLastRun();
      expect(persisted!.candidateSample).toHaveLength(CANDIDATE_SAMPLE_MAX);
      expect(persisted!.candidatesTotal).toBe(overCap);
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

    // Verification round: this cell could not fail. It aged only the FILE, so
    // the directory's own mtime was `Date.now()` and `judgeDirectoryOrphan`
    // took the grace branch before the key filter mattered — deleting the
    // `PAGE_ID_PATTERN` test from the walk left it green. And a DRY run
    // deletes nothing by construction, so the survival assertion asserted the
    // dry run rather than the guard. Aged directory + LIVE run: the key filter
    // is now the only thing standing between `weird name!/` and an `rm -rf`.
    it('skips keys that do not match PAGE_ID_PATTERN — nothing outside the root is ever judged', async () => {
      await writeAged('weird name!', 'x.png');
      await ageDirs('weird name!');
      const run = await runAttachmentSweep({ dryRun: false });
      expect(run!.status).toBe('completed');
      expect(run!.candidateSample.find((c) => c.key === 'weird name!')).toBeUndefined();
      expect(
        await exists(path.join(tempBase, 'weird name!', 'x.png')),
        'a key the allow-list refuses is never judged, so a live run cannot touch it',
      ).toBe(true);
      expect(await exists(path.join(tempBase, 'weird name!'))).toBe(true);
      // …and it is REPORTED, not silently dropped (fixer r1). The cell above
      // pins the safety half; without this one the directory's bytes were
      // missing from `bytes`/`files`/`directories` and it incremented none of
      // the three counters the card renders — a fourth declined class on a
      // card whose contract is that a partial walk cannot look complete.
      expect(run!.stores!.confluence.unkeyedDirectories).toBe(1);
      expect(run!.stores!.confluence.unreadableDirectories).toBe(0);
      expect(run!.stores!.confluence.nestedDirectories).toBe(0);
      expect(run!.stores!.confluence.directories).toBe(0);
      expect(run!.stores!.confluence.bytes).toBe(0);
    });

    it('counts an unkeyable LOCAL directory too, and never opens it', async () => {
      await writeAged('local', 'not-a-page-id', 'x.png');
      await ageDirs(path.join('local', 'not-a-page-id'));
      const run = await runAttachmentSweep({ dryRun: false });
      expect(run!.status).toBe('completed');
      expect(run!.stores!.local.unkeyedDirectories).toBe(1);
      expect(run!.stores!.local.directories).toBe(0);
      expect(await exists(path.join(tempBase, 'local', 'not-a-page-id', 'x.png'))).toBe(true);
    });

    /**
     * Fixer r1: `LOCAL_DIR_PATTERN` was the one path-safety allow-list in this
     * PR that no test could falsify — widening it to `/^.+$/` left the whole
     * file green, because every other name it rejects (`not-a-page-id` above)
     * is caught by the `Number.isInteger(n) && n > 0` guard behind it. What
     * the pattern uniquely rejects is a name whose `Number()` → `String()`
     * round trip is not itself (`007`, ` 7`, `7.0`, `1e3`, `0x10`): the walk
     * maps a key to `Number(name)` and rebuilds every path from it, so without
     * the pattern `local/007/` is neither walked nor reported while
     * `local/4242/` is walked TWICE — one page's files, bytes and candidates
     * counted once per spelling, on a card whose stated contract is that a
     * partial walk cannot look like a complete one.
     */
    it('counts a zero-padded LOCAL directory as unkeyed, and never folds it onto the real id', async () => {
      await writeAged('local', '4242', 'a.png');
      await writeAged('local', '04242', 'b.png');
      await ageDirs(path.join('local', '4242'), path.join('local', '04242'));

      const run = await runAttachmentSweep({ dryRun: true });

      expect(run!.status).toBe('completed');
      expect(run!.stores!.local.unkeyedDirectories).toBe(1);
      expect(
        run!.candidateSample.find((c) => c.store === 'local' && c.key === '04242'),
        'a key the allow-list refuses is never judged',
      ).toBeUndefined();
      // `local/4242/` is judged exactly ONCE — not once per spelling that
      // `Number()` happens to collapse onto 4242.
      expect(
        run!.candidateSample.filter((c) => c.store === 'local' && c.key === '4242'),
      ).toHaveLength(1);
      expect(run!.stores!.local.orphanDirectories).toBe(1);
      expect(run!.stores!.local.directories).toBe(1);
      expect(run!.stores!.local.files).toBe(1);
      // #1515 (fixer, external round): the BYTES half. `files` alone left the
      // card's byte figure — the number an operator sizes a cleanup by — free
      // to double, and it does: with `LOCAL_DIR_PATTERN` widened, `local/4242/`
      // is walked once per spelling and its one file is counted twice
      // (`expected 38 to be 19`, isolated probe quoted in the PR). Statted, not
      // hard-coded, so the figure stays the walk's own arithmetic.
      const kept = await fs.stat(path.join(tempBase, 'local', '4242', 'a.png'));
      expect(run!.stores!.local.bytes).toBe(kept.size);
      expect(run!.stores!.local.orphanDirectoryBytes).toBe(kept.size);
      expect(await exists(path.join(tempBase, 'local', '04242', 'b.png'))).toBe(true);
    });

    it('does not count the reserved stores or dot-directories as unkeyed', async () => {
      // `local/` and `page-icons/` are other stores and `.cache/` is #1169
      // debris — none of the three is a directory this walk failed to judge,
      // so none may inflate the counter the card renders.
      await writeAged('local', '4242', 'x.png');
      await writeAged('page-icons', '4242', 'y.png');
      await writeAged('.cache', 'z.png');
      const run = await runAttachmentSweep({ dryRun: true });
      expect(run!.status).toBe('completed');
      expect(run!.stores!.confluence.unkeyedDirectories).toBe(0);
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
      // Review r2: the stood-down store must contribute a REAL candidate, or
      // the filter that stands it down is unfalsifiable — emptied outright it
      // produces none, and `deletable = candidates` left this whole suite
      // green. An aged, pageless, EMPTY directory is the reachable shape: it
      // holds no files, so the store still reads `files === 0` and the anomaly
      // still fires, yet `judgeDirectoryOrphan` still names it an
      // `orphan_directory` (`[].every(aged)` is vacuously true). A suspected
      // mis-mount must not delete it.
      await fs.mkdir(path.join(tempBase, '55555'), { recursive: true });
      await ageDirs('55555');

      const live = await runAttachmentSweep({ dryRun: false });
      expect(live!.status).toBe('completed');
      expect(live!.note).toMatch(/^confluence store/);
      // Reported but not deleted: the run still says what the walk found…
      expect(
        live!.candidateSample.some((c) => c.store === 'confluence' && c.key === '55555'),
        'a stood-down store’s candidates are still reported',
      ).toBe(true);
      // …and the directory is still standing.
      expect(
        await exists(path.join(tempBase, '55555')),
        'a stood-down store must lose nothing to the delete loop',
      ).toBe(true);
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

    // Review r2: the invariant one test up is defeated at half scope by the
    // per-store stand-down. A ONE-store anomaly COMPLETES, and the persist was
    // gated on `status === 'completed'` alone — so the zeroed figures of the
    // store the run had just declined to trust overwrote the reference record
    // an operator diagnosing that mount needs. Neither one-store test asserted
    // anything about the record, in either direction.
    it('a one-store anomaly leaves the stats record standing too (review r2)', async () => {
      await seedCorpus();
      const dry = await runAttachmentSweep({ dryRun: true });
      expect(dry!.status).toBe('completed');
      const before = await readAttachmentStorageStatsRecord();
      expect(before!.stores.confluence.files).toBeGreaterThan(0);
      expect(before!.stores.local.files).toBeGreaterThan(0);

      // ONE store mis-mounts: every Confluence-tree key goes, `local/` stays.
      for (const entry of await fs.readdir(tempBase)) {
        if (entry === 'local') continue;
        await fs.rm(path.join(tempBase, entry), { recursive: true, force: true });
      }

      const live = await runAttachmentSweep({ dryRun: false });
      expect(live!.status).toBe('completed');
      expect(live!.note).toMatch(/^confluence store/);
      // The RUN record reports the zero-file walk it stood the store down over…
      expect(live!.stores!.confluence.files).toBe(0);
      // …and the reference figures survive it untouched, both stores.
      expect(await readAttachmentStorageStatsRecord()).toEqual(before);
    });

    it('an empty local store stands that store down and still sweeps the Confluence tree', async () => {
      const { standalonePageId } = await seedCorpus();
      await fs.rm(path.join(tempBase, 'local'), { recursive: true, force: true });
      // Verification round — the LOCAL half of the stand-down was unpinned for
      // exactly the reason r2 fixed on the Confluence side one test up:
      // emptied outright the store contributes NO candidate, so a filter that
      // stops standing the local store down (`c.store === 'local' ||
      // anomalies[c.store] === undefined`) left the whole suite green. An
      // aged, pageless, EMPTY key directory is the reachable shape — it holds
      // no files, so `files === 0` and the anomaly still fires, yet
      // `judgeDirectoryOrphan` still names it an `orphan_directory`
      // (`[].every(aged)` is vacuously true). A suspected mis-mount must
      // report it and delete nothing.
      await fs.mkdir(path.join(tempBase, 'local', '77777'), { recursive: true });
      await ageDirs('local', path.join('local', '77777'));

      const live = await runAttachmentSweep({ dryRun: false });
      expect(live!.status).toBe('completed');
      expect(live!.note).toMatch(/^local store/);
      // Reported but not deleted, both halves.
      expect(
        live!.candidateSample.some((c) => c.store === 'local' && c.key === '77777'),
        'a stood-down store’s candidates are still reported',
      ).toBe(true);
      expect(
        await exists(path.join(tempBase, 'local', '77777')),
        'a stood-down store must lose nothing to the delete loop',
      ).toBe(true);
      // The mirror of the case above: this run stood a store down, so it is
      // not the clean measurement the stats record publishes.
      expect(await readAttachmentStorageStatsRecord()).toBeNull();
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

    // Review r2. The r1 guard read `entry.isDirectory() && !entry.name.startsWith('.')`,
    // so a DOT-directory did not count as a subdirectory — the one shape the
    // rule exists for, one character away. A key directory holding only
    // `.hidden/` reported `files: []`, both safety checks went vacuous, the dry
    // run described it as 0 B and a live run `rm -rf`'d the tree inside it.
    // "A directory we cannot MEASURE is never judged" — and a dot-subdirectory
    // is exactly as unmeasured as any other (the dot-skip on the FILE branch is
    // the separate #1169 debris rule and stays).
    it('a DOT-named subdirectory is a subdirectory too — the directory is never judged', async () => {
      await seedCorpus();
      const hidden = await writeAged('44440', '.hidden', 'secret.bin');
      await ageDirs(path.join('44440', '.hidden'), '44440');

      const dry = await runAttachmentSweep({ dryRun: true });
      expect(dry!.status).toBe('completed');
      // Not listed — and in particular not listed as the 0 B orphan the old
      // walk reported, which is what made the dry run unable to warn.
      expect(dry!.candidateSample.some((c) => c.key === '44440')).toBe(false);
      expect(dry!.stores!.confluence.nestedDirectories).toBe(1);

      const live = await runAttachmentSweep({ dryRun: false });
      expect(live!.status).toBe('completed');
      expect(await exists(hidden), 'a dot-subdirectory must survive a live sweep').toBe(true);
      expect(await exists(path.join(tempBase, '44440'))).toBe(true);
      // Sanity: the ordinary flat orphan beside it still went.
      expect(await exists(path.join(tempBase, '55555'))).toBe(false);
    });

    // Verification round — the THIRD instance of the same one-character class.
    // r1 closed it for sub-folders, r2 for dot-named ones; both branches ask
    // `entry.isDirectory()`, and a `Dirent` has more answers than two. A
    // SYMLINK is neither `isFile()` nor `isDirectory()`, so it is skipped by
    // the file branch, does not raise `hasSubdirectories`, and contributes
    // nothing to `files` — the directory around it reports `files: []`, both
    // safety checks go vacuous exactly as before, the dry run calls it 0 B and
    // a live run removes it. The blast radius is smaller than r1's (`fs.rm`
    // removes the link, never the target's bytes), which is why this is the
    // instance that survived two rounds — but "reported as 0 B, destroyed
    // anyway" is the reporting failure the whole guard exists to prevent, and
    // the module's own rule is that a directory it cannot MEASURE is never
    // judged. A symlink is unmeasured: `dir.files` never carries its name, so
    // the keep-set cannot protect it even when a body references it.
    it('a SYMLINK is not a plain file either — the directory around it is never judged', async () => {
      await seedCorpus();
      const target = await writeAged('link-target', 'real.bin');
      const link = path.join(tempBase, '44439', 'shortcut.png');
      await fs.mkdir(path.join(tempBase, '44439'), { recursive: true });
      await fs.symlink(target, link);
      await ageDirs('44439');

      const dry = await runAttachmentSweep({ dryRun: true });
      expect(dry!.status).toBe('completed');
      expect(
        dry!.candidateSample.some((c) => c.key === '44439'),
        'a directory holding an unmeasurable entry is never a candidate',
      ).toBe(false);
      expect(dry!.stores!.confluence.nestedDirectories).toBe(1);

      const live = await runAttachmentSweep({ dryRun: false });
      expect(live!.status).toBe('completed');
      // `lstat`, not `stat`: the question is whether the LINK survived, and
      // `exists` follows it to the target, which a recursive delete never
      // touches — so stat-following would pass against the unfixed code.
      await expect(fs.lstat(link), 'the symlink itself must survive a live sweep').resolves.toBeDefined();
      expect(await exists(path.join(tempBase, '44439'))).toBe(true);
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

    // Review r2: `readKeyDir` answers `null` for two different facts — the
    // directory vanished, and the directory is there but unreadable — and only
    // the first is evidence a row's file is gone. Counting the second made the
    // card state that N `local_attachments` records "point at a file that is
    // not on disk" for files sitting right there, on a surface whose stated
    // contract is to report only what the walk could see.
    it.skipIf(process.getuid?.() === 0)(
      'does not report a row as missing because its directory could not be read',
      async () => {
        const { localPageId } = await seedCorpus();
        const baseline = await runAttachmentSweep({ dryRun: true });
        // seedCorpus's one genuinely absent file (`missing.png`).
        expect(baseline!.missingLocalFiles).toBe(1);

        const sealed = path.join(tempBase, 'local', String(localPageId));
        await fs.chmod(sealed, 0o000);
        try {
          const dry = await runAttachmentSweep({ dryRun: true });

          expect(dry!.status).toBe('completed');
          expect(dry!.stores!.local.unreadableDirectories).toBe(1);
          // `tracked.png` is on disk and unreachable — a fact about the mount,
          // already carried by the counter above, not a missing record.
          expect(
            dry!.missingLocalFiles,
            'an unreadable directory is not evidence its rows are missing',
          ).toBe(0);
        } finally {
          await fs.chmod(sealed, 0o700);
        }
      },
    );

    // Verification round r2: the same "unreadable ≠ absent" distinction, one
    // level UP. The cell above seals ONE key directory, which `readKeyDir`
    // already told apart; the local store's ROOT readdir had a bare `catch`
    // that answered "absent" for every failure — so a `chmod 000` on
    // `<ATTACHMENTS_DIR>/local` published `0 B · 0 files in 0 directories`
    // for a full store and reported every row as pointing at a file that is
    // not on disk. A dry run persists those figures into the stats record
    // (the anomaly guard is `!dryRun`-gated), so the card then carries them
    // at rest.
    it.skipIf(process.getuid?.() === 0)(
      'does not report the whole local store as absent when its root cannot be read',
      async () => {
        await seedCorpus();
        const sealedRoot = path.join(tempBase, 'local');
        await fs.chmod(sealedRoot, 0o000);
        try {
          const dry = await runAttachmentSweep({ dryRun: true });

          expect(dry!.status).toBe('completed');
          expect(
            dry!.stores!.local.unreadableDirectories,
            'an unreadable store root is a fact the walk must report',
          ).toBe(1);
          expect(
            dry!.missingLocalFiles,
            'a store that could not be read is not evidence any row’s file is gone',
          ).toBe(0);
          expect(dry!.candidateSample.some((c) => c.store === 'local')).toBe(false);
        } finally {
          await fs.chmod(sealedRoot, 0o700);
        }
      },
    );
  });

  describe('live run', () => {
    async function liveImageEmbeddingWidth(): Promise<number> {
      const r = await query<{ type: string }>(
        `SELECT format_type(atttypid, atttypmod) AS type
           FROM pg_attribute
          WHERE attrelid = 'page_image_embeddings'::regclass AND attname = 'embedding'`,
      );
      const m = /^(?:halfvec|vector)\((\d+)\)$/.exec(r.rows[0]?.type ?? '');
      if (!m) {
        throw new Error(`unexpected page_image_embeddings.embedding type ${r.rows[0]?.type}`);
      }
      return Number(m[1]);
    }

    async function seedEmbeddingRow(pageId: number, source: string, key: string): Promise<void> {
      // Sibling files on this worker may have retyped the column (4, 1024, …).
      // The sweep only needs a row to prune; match the live width.
      const dims = await liveImageEmbeddingWidth();
      const vec = '[' + new Array(dims).fill(0).join(',') + ']';
      await query(
        `INSERT INTO page_image_embeddings (page_id, source, attachment_key, sha256, format, model, embedding)
         VALUES ($1, $2, $3, 'sha', 'png', 'test-model', $4::vector)`,
        [pageId, source, key, vec],
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

    /**
     * Fixer r1 — the pages row's `body_storage` is scanned for RAW attachment
     * URLs as well as for `ri:filename` references, and nothing exercised that
     * scan: dropping `collectAttachmentUrlReferences(row.body_storage, keep)`
     * left every sweep test green.
     *
     * It is the only feeder of LOCAL-store keep names out of storage format
     * (`getExpectedAttachmentFilenames` reads `ac:image`/`ri:attachment` only,
     * and every name it yields lands in the CONFLUENCE set), and the only one
     * that sees an anchor-style reference at all — which is exactly what a
     * #1169 Markdown import produces and `htmlToConfluence` preserves. So a
     * page whose HTML column is not populated (a fresh import, a row synced
     * before the body was rendered) had the files its storage format still
     * points at judged orphans and deleted.
     */
    it('keeps files referenced only by a raw attachment URL inside body_storage', async () => {
      const inserted = await query<{ id: number }>(
        `INSERT INTO pages (title, space_key, confluence_id, source, page_type, version,
                            body_html, body_storage)
         VALUES ('Imported', 'DEV', '90001', 'confluence', 'page', 1, NULL, '')
         RETURNING id`,
      );
      const pageId = inserted.rows[0]!.id;
      // Both stores in one body: a relocated page legitimately carries the
      // local prefix beside the Confluence one.
      await query(`UPDATE pages SET body_storage = $2 WHERE id = $1`, [
        pageId,
        `<p><a href="/api/attachments/90001/import-anchor.png">plan</a>` +
          `<img src="/api/local-attachments/${pageId}/import-local.png" /></p>`,
      ]);

      const anchorFile = await writeAged('90001', 'import-anchor.png');
      const localFile = await writeAged('local', String(pageId), 'import-local.png');
      await ageDirs('90001', path.join('local', String(pageId)));

      const run = await runAttachmentSweep({ dryRun: false });

      expect(run!.status).toBe('completed');
      expect.soft(await exists(anchorFile), 'an anchor reference in body_storage must keep its file').toBe(
        true,
      );
      // The local file has no `local_attachments` row, so the keep-set is the
      // only thing standing between it and a delete.
      expect.soft(
        await exists(localFile),
        'a local-store reference in body_storage must keep its file',
      ).toBe(true);
      expect(run!.deleted).toMatchObject({ directories: 0, files: 0 });
    });

    /**
     * #1516 — `asPageId`'s round-trip guard (`if (String(parsed) !== key)
     * return null; // zero-padded '007' must not match id 7`) was the one
     * safety predicate in this file no test could falsify: deleting it left
     * all 71 sweep cells green.
     *
     * The issue asks for the guard to be pinned on the directory-ORPHAN
     * verdict, and that assertion cannot falsify it (executed probe, quoted
     * in the PR): `knownConfluenceTreeKeys` records `String(row.id)`, so a
     * widened `asPageId('042')` puts `'42'` — never the key `'042'` — into
     * the known set, and `042/` is judged exactly as it is with the guard in
     * place. The reachable call site is `confluenceKeyOwners`, which answers
     * a page-id LIST for one key and feeds both the `page_image_embeddings`
     * prune and the image-reindex re-queue. With the guard gone, key `042`
     * (a key a page really owns via `confluence_id`) ALSO resolves to the
     * unrelated live page whose id is 42, so deleting an orphan file under
     * `042/` prunes THAT page's index row for a file it still holds and
     * re-queues it — silent index loss booked against the wrong page.
     */
    it('a zero-padded Confluence key never prunes the index rows of the page id it collapses onto (#1516)', async () => {
      const userId = await seedUser('zero-pad');
      // The collateral page: the zero-padded key's numeric collapse is its id.
      const collateral = await query<{ id: number }>(
        `INSERT INTO pages (title, space_key, source, page_type, version, body_html, created_by_user_id)
         VALUES ('Collateral', 'LOCAL', 'standalone', 'page', 1, '', $1) RETURNING id`,
        [userId],
      );
      const collateralId = collateral.rows[0]!.id;
      // Number(key) === collateralId, but String(Number(key)) !== key.
      const key = `0${collateralId}`;
      // The page that really owns the directory key.
      const owner = await query<{ id: number }>(
        `INSERT INTO pages (title, space_key, confluence_id, source, page_type, version, body_html)
         VALUES ('Owner', 'DEV', $1, 'confluence', 'page', 1, '') RETURNING id`,
        [key],
      );
      const ownerId = owner.rows[0]!.id;

      await query(`UPDATE pages SET image_embedding_dirty = FALSE WHERE id = ANY($1::int[])`, [
        [collateralId, ownerId],
      ]);
      // The SAME attachment_key on both pages: the prune is keyed by
      // (page_id, source, attachment_key), so the owner LIST is the only
      // thing deciding which of the two rows goes.
      await seedEmbeddingRow(ownerId, 'confluence', 'orphan.png');
      await seedEmbeddingRow(collateralId, 'confluence', 'orphan.png');

      const orphan = await writeAged(key, 'orphan.png');
      await ageDirs(key);

      const run = await runAttachmentSweep({ dryRun: false });

      expect(run!.status).toBe('completed');
      // The file is an unreferenced orphan under a key its own page owns, so
      // it goes — this cell is about the collateral, not about the delete.
      expect(await exists(orphan)).toBe(false);
      expect(run!.deleted!.imageEmbeddingRows).toBe(1);
      const survivors = await query<{ page_id: number }>(
        `SELECT page_id FROM page_image_embeddings ORDER BY page_id`,
      );
      expect(
        survivors.rows.map((r) => r.page_id),
        'the collapsed-onto page keeps its own index row',
      ).toEqual([collateralId]);
      const dirty = await query<{ id: number; image_embedding_dirty: boolean }>(
        `SELECT id, image_embedding_dirty FROM pages WHERE id = ANY($1::int[])`,
        [[collateralId, ownerId]],
      );
      expect(dirty.rows.find((r) => r.id === ownerId)!.image_embedding_dirty).toBe(true);
      expect(
        dirty.rows.find((r) => r.id === collateralId)!.image_embedding_dirty,
        'the collapsed-onto page is never re-queued for an image re-index',
      ).toBe(false);
      expect(run!.deleted!.pagesMarkedDirty).toBe(1);
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

    // Review r2 — the test above could not FAIL. Its fixture is
    // `page-icons/<pageId>/<sha>.png`, a NESTED tree, so the later
    // `hasSubdirectories` refusal answers for it and the reservation is never
    // reached: dropping `page-icons` from `ATTACHMENT_ROOT_RESERVED_DIRNAMES`
    // left the whole suite green. A FLAT fixture takes `hasSubdirectories` out
    // of the picture, so the store survives only because the walk's name filter
    // skipped it — which is the thing under test. Not hypothetical: the store's
    // layout is an implementation detail of `page-icon-store.ts`, and a
    // content-addressed flat one (`page-icons/<sha>.<ext>`) would restore the
    // exact permanent loss commit 3057bd0f fixed.
    it('never judges a FLAT page-icon store either — the name filter, not the nested-tree guard', async () => {
      await seedCorpus();
      const sha = 'b'.repeat(64);
      const icon = await writeAged('page-icons', `${sha}.png`);
      await ageDirs('page-icons');

      const run = await runAttachmentSweep({ dryRun: false });

      expect(run!.status).toBe('completed');
      expect(await exists(icon), 'a flat page-icon store must survive a live sweep').toBe(true);
      expect(run!.candidateSample.some((c) => c.key === 'page-icons')).toBe(false);
      // Never even walked: not counted as one of the Confluence tree's
      // directories, and not counted as an unjudged nested one either.
      expect(run!.stores!.confluence.nestedDirectories).toBe(0);
    });

    it('never judges client-models — a live run leaves operator-supplied weights standing (#1418 SPEC-009)', async () => {
      const { ATTACHMENT_ROOT_RESERVED_DIRNAMES } = await import(
        '../../../core/services/attachment-store.js'
      );
      expect(ATTACHMENT_ROOT_RESERVED_DIRNAMES.has('client-models')).toBe(true);

      await seedCorpus();
      const weight = await writeAged(
        'client-models',
        'qwen2.5-0.5b-instruct-q4',
        'model.onnx',
      );
      await ageDirs(
        'client-models',
        path.join('client-models', 'qwen2.5-0.5b-instruct-q4'),
      );

      const run = await runAttachmentSweep({ dryRun: false });

      expect(run!.status).toBe('completed');
      expect(await exists(weight), 'operator-supplied weights must survive a live sweep').toBe(true);
      expect(await exists(path.join(tempBase, 'client-models'))).toBe(true);
      expect(run!.candidateSample.some((c) => c.key === 'client-models')).toBe(false);
      const dry = await runAttachmentSweep({ dryRun: true });
      expect(dry!.candidateSample.some((c) => c.key === 'client-models')).toBe(false);
      expect(dry!.stores!.confluence.orphanDirectories).toBe(0);
    });

    it('never judges a FLAT client-models store either — the name filter, not the nested-tree guard (#1418)', async () => {
      await seedCorpus();
      const weight = await writeAged('client-models', 'model.onnx');
      await ageDirs('client-models');

      const run = await runAttachmentSweep({ dryRun: false });

      expect(run!.status).toBe('completed');
      expect(await exists(weight), 'a flat client-models store must survive a live sweep').toBe(true);
      expect(run!.candidateSample.some((c) => c.key === 'client-models')).toBe(false);
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
      const { confPageId } = await seedCorpus();
      // One index row for a file the sweep really removes, so `rows_pruned`
      // below is asserted against a non-zero value rather than a default.
      await seedEmbeddingRow(confPageId, 'confluence', 'orphan.png');
      const run = await runAttachmentSweep({ dryRun: false });
      expect(run!.status).toBe('completed');

      const audit = await query<{
        user_id: string | null;
        metadata: {
          dry_run: boolean;
          files_pruned: number;
          table?: string;
          rows_pruned?: number;
          orphan_files?: number;
          orphan_directories?: number;
        };
      }>(
        `SELECT user_id, metadata FROM audit_log
          WHERE action = 'RETENTION_PRUNED' AND resource_id = 'attachments_orphan_sweep'
          ORDER BY created_at DESC LIMIT 1`,
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]!.metadata.dry_run).toBe(false);
      expect(audit.rows[0]!.metadata.files_pruned).toBeGreaterThan(0);
      // The two keys `audit-service.ts` declares for RETENTION_PRUNED, which
      // the EE Data Retention Attestation renders as "the table touched" and
      // "rows pruned" (review r2 — omitting them put this run in the report
      // with both columns blank). The pair describes the DATABASE fact: the
      // only table this sweep prunes rows from is `page_image_embeddings`, so
      // `rows_pruned` is that count and never the file count beside it.
      expect(audit.rows[0]!.metadata.table).toBe('page_image_embeddings');
      expect(audit.rows[0]!.metadata.rows_pruned).toBe(run!.deleted!.imageEmbeddingRows);
      expect(audit.rows[0]!.metadata.rows_pruned).toBeGreaterThan(0);
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

    it('a FILE candidate whose filename is in the keep-set survives at delete time (fixer r2)', async () => {
      // The directory branch re-checked the keep-set at delete time; the file
      // branch re-checked only existence, is-file and mtime, so a reference
      // that landed after the walk was honoured for directories and ignored
      // for files — over a window that is the whole run. Reachable shape: a
      // sync re-adds an image whose bytes are already cached (so
      // `getMissingAttachments` does not re-download it and its mtime stays
      // aged) and the body carrying the reference is written after the walk
      // listed the file.
      await writeAged('90001', 'kept-file.png');
      await writeAged('local', '4243', 'local-kept-file.png');

      const totals = emptyDeletedTotals();
      await deleteCandidates(
        [
          fileCandidate('confluence', '90001', 'kept-file.png'),
          fileCandidate('local', '4243', 'local-kept-file.png'),
        ],
        { confluence: new Set(['kept-file.png']), local: new Set(['local-kept-file.png']) },
        noAbort,
        totals,
      );

      expect(await exists(path.join(tempBase, '90001', 'kept-file.png'))).toBe(true);
      expect(await exists(path.join(tempBase, 'local', '4243', 'local-kept-file.png'))).toBe(true);
      expect(totals.files).toBe(0);
      expect(totals.bytes).toBe(0);
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

    /**
     * Fixer r1 — `if (!removed) continue` was unguarded: dropping it left the
     * suite green, so a filename the local store REFUSED could be counted as
     * a deletion that never happened, which is exactly what the comment
     * beside it forbids. No fixture reached the `false` return, because the
     * walk skips dot-files and so can never nominate one.
     *
     * A hand-built candidate is the point: the guard exists for a list that
     * names something `removeLocalAttachmentFileForSweep` will not touch, and
     * the real `canStoreLocalFilename` is what refuses it here.
     */
    it('a local filename the store refuses is not counted as a deletion', async () => {
      const hidden = await writeAged('local', '4242', '.hidden.png');

      const totals = emptyDeletedTotals();
      await deleteCandidates(
        [fileCandidate('local', '4242', '.hidden.png')],
        emptyKeep(),
        noAbort,
        totals,
      );

      expect(await exists(hidden), 'the store refused the name, so nothing was removed').toBe(true);
      expect(totals.files).toBe(0);
      expect(totals.bytes).toBe(0);
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
