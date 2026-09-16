import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createHash } from 'crypto';
import { createClient, type RedisClientType } from 'redis';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import { invalidateRagImageIntakeCache } from '../../../core/services/admin-settings-service.js';
import { setRedisClient } from '../../../core/services/redis-cache.js';
import {
  IMAGE_ANALYSIS_LAST_RUN_KEY,
  IMAGE_ANALYSIS_MAX_ATTEMPTS,
  IMAGE_ANALYSIS_WORKER_LOCK,
  readImageAnalysisLastRun,
  reanalyzeAllImages,
  retryFailedImageAnalyses,
  runImageAnalysisBatch,
  type ImageAnalysisWorkerDeps,
} from './image-analysis-worker.js';
import {
  computeIdentityHash,
  IMAGE_ANALYSIS_IDENTITY_KEY,
  IMAGE_ANALYSIS_PROMPT_VERSION,
  IMAGE_ANALYSIS_SCHEMA_VERSION,
  type AnalyzeImageInput,
  type AnalyzeImageResult,
  type ImageAnalysisIdentity,
  type ImageAnalysisPayload,
} from './image-analysis-provider.js';
import type * as AttachmentStore from '../../../core/services/attachment-store.js';
import type { ResolveAttachmentBytesInput } from '../../../core/services/attachment-store.js';

/**
 * One seam BELOW the intake: `resolveAttachmentBytes` raising for a key, as
 * the store does for `EACCES`/`EIO`/`ESTALE`. A `chmod 000` would be the real
 * thing but reads fine as root (Docker CI), so the fault is injected where
 * the store's contract hands it over; the store's own suite pins that
 * contract against a real mode-bit refusal.
 */
const storeFaults = vi.hoisted(() => new Map<string, NodeJS.ErrnoException>());
vi.mock('../../../core/services/attachment-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof AttachmentStore>();
  return {
    ...actual,
    resolveAttachmentBytes: async (input: ResolveAttachmentBytesInput) => {
      const fault = storeFaults.get(input.key);
      if (fault) throw fault;
      return actual.resolveAttachmentBytes(input);
    },
  };
});
function eacces(key: string): NodeJS.ErrnoException {
  const err = new Error(`EACCES: permission denied, open '${key}'`) as NodeJS.ErrnoException;
  err.code = 'EACCES';
  return err;
}

/**
 * ADR-027 D13 — the worker against real Postgres (and real Redis where one is
 * reachable: the lease is the only thing stopping two pods draining one
 * backlog, and a mocked lock asserts the mock). The ONLY doubles are the
 * boundaries #1615 owns — identity resolution, the vision verdict and the
 * client — injected through `ImageAnalysisWorkerDeps` as deterministic canned
 * answers. The table, the pages, the bytes, the lock and the settings are real.
 */
const dbAvailable = await isDbAvailable();

const redis = await (async (): Promise<RedisClientType | null> => {
  try {
    const client = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' }) as RedisClientType;
    client.on('error', () => undefined);
    await client.connect();
    setRedisClient(client);
    return client;
  } catch {
    return null;
  }
})();

let attachmentsDir: string;
let previousAttachmentsDir: string | undefined;
let providerId: string;

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function png(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(8);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  return Buffer.concat([PNG_SIG, Buffer.from([0, 0, 0, 13]), Buffer.from('IHDR'), ihdr]);
}
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

function identityFor(baseUrl: string): ImageAnalysisIdentity {
  const triple = { providerId, model: 'qwen3-vl', baseUrl };
  return { ...triple, identityHash: computeIdentityHash(triple), assignedAt: '2026-09-15T00:00:00.000Z' };
}

async function retain(identity: ImageAnalysisIdentity | null): Promise<void> {
  await query(`DELETE FROM admin_settings WHERE setting_key = $1`, [IMAGE_ANALYSIS_IDENTITY_KEY]);
  if (identity) {
    await query(`INSERT INTO admin_settings (setting_key, setting_value) VALUES ($1, $2)`, [
      IMAGE_ANALYSIS_IDENTITY_KEY,
      JSON.stringify(identity),
    ]);
  }
}

const PAYLOAD: ImageAnalysisPayload = {
  schemaVersion: 1,
  kind: 'screenshot',
  language: 'en',
  description: 'A dialog showing error 0x8007045D with a Retry button.',
  visibleText: 'Error 0x8007045D\nRetry',
  limitations: [],
};

const ok = (): AnalyzeImageResult => ({ ok: true, payload: PAYLOAD, finishReason: 'stop', usage: { promptTokens: 900, completionTokens: 60 } });
const fail = (cls: Extract<AnalyzeImageResult, { ok: false }>['class'], extra: Partial<Extract<AnalyzeImageResult, { ok: false }>> = {}): AnalyzeImageResult =>
  ({ ok: false, class: cls, providerLevel: false, message: cls, ...extra });

/** A deterministic client double: a queue of canned answers, then `ok`. */
function client(answers: AnalyzeImageResult[] = []): { calls: AnalyzeImageInput[]; analyzeImage: ImageAnalysisWorkerDeps['analyzeImage'] } {
  const calls: AnalyzeImageInput[] = [];
  const queue = [...answers];
  return {
    calls,
    analyzeImage: async (input) => {
      calls.push(input);
      return queue.shift() ?? ok();
    },
  };
}

function deps(over: Partial<ImageAnalysisWorkerDeps>, identity: ImageAnalysisIdentity | null): Partial<ImageAnalysisWorkerDeps> {
  return {
    resolveIdentity: async () => identity,
    getVisionCapability: async () => true,
    refreshVisionCapability: async () => undefined,
    getMaxOutputTokens: async () => 8192,
    getBatchSize: async () => 50,
    ...over,
  };
}

async function seedPage(bodyHtml: string, opts: { dirty?: boolean; title?: string } = {}): Promise<number> {
  const r = await query<{ id: number }>(
    `INSERT INTO pages (title, space_key, body_html, page_type, source, image_analysis_dirty, embedding_dirty)
     VALUES ($1, 'DEV', $2, 'page', 'standalone', $3, FALSE) RETURNING id`,
    [opts.title ?? 'Doc', bodyHtml, opts.dirty ?? true],
  );
  return r.rows[0]!.id;
}

async function writeAttachment(pageId: number, name: string, bytes: Buffer): Promise<void> {
  const dir = path.join(attachmentsDir, String(pageId));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), bytes);
}

/** One page with N images, rows already reconciled to `pending`. */
async function seedPending(names: string[]): Promise<{ pageId: number; ids: number[] }> {
  const pageId = await seedPage(names.map((n) => `<img src="/api/attachments/1/${n}">`).join(''), { dirty: false });
  const ids: number[] = [];
  for (const [i, n] of names.entries()) {
    const bytes = png(4 + i, 4);
    await writeAttachment(pageId, n, bytes);
    const r = await query<{ id: number }>(
      `INSERT INTO page_image_analyses (page_id, source, attachment_key, content_hash, format, width, height, status)
       VALUES ($1, 'confluence', $2, $3, 'png', $4, 4, 'pending') RETURNING id`,
      [pageId, n, sha(bytes), 4 + i],
    );
    ids.push(r.rows[0]!.id);
  }
  return { pageId, ids };
}

interface Row {
  id: number;
  attachment_key: string;
  content_hash: string;
  status: string;
  skip_reason: string | null;
  attempts: number;
  next_attempt_at: Date | null;
  error: string | null;
  payload: unknown;
  identity_hash: string | null;
  prompt_version: number | null;
  schema_version: number | null;
  analysis_version: number;
  provider_id: string | null;
  model: string | null;
  base_url: string | null;
}
async function rowsFor(pageId: number): Promise<Row[]> {
  const r = await query<Row>(
    `SELECT id, attachment_key, content_hash, status, skip_reason, attempts, next_attempt_at, error, payload,
            identity_hash, prompt_version, schema_version, analysis_version, provider_id, model, base_url
       FROM page_image_analyses WHERE page_id = $1 ORDER BY attachment_key`,
    [pageId],
  );
  return r.rows;
}
async function pageState(pageId: number): Promise<{ revision: number; embeddingDirty: boolean; analysisDirty: boolean }> {
  const r = await query<{ image_analysis_revision: string; embedding_dirty: boolean; image_analysis_dirty: boolean }>(
    `SELECT image_analysis_revision, embedding_dirty, image_analysis_dirty FROM pages WHERE id = $1`,
    [pageId],
  );
  return {
    revision: Number(r.rows[0]!.image_analysis_revision),
    embeddingDirty: r.rows[0]!.embedding_dirty,
    analysisDirty: r.rows[0]!.image_analysis_dirty,
  };
}

const SHAPE_KEYS = ['processed', 'reused', 'skipped', 'failed', 'terminal', 'repended', 'returned', 'reopened', 'reconciledPages', 'removed', 'pagesFailed', 'unreadableRefs'];

describe.skipIf(!dbAvailable)('runImageAnalysisBatch (ADR-027 D13, #1616)', () => {
  beforeAll(async () => {
    await setupTestDb();
    previousAttachmentsDir = process.env.ATTACHMENTS_DIR;
    attachmentsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cq-image-analysis-worker-'));
    process.env.ATTACHMENTS_DIR = attachmentsDir;
  });
  afterAll(async () => {
    if (redis) {
      try { await redis.quit(); } catch { /* best effort */ }
    }
    if (previousAttachmentsDir === undefined) delete process.env.ATTACHMENTS_DIR;
    else process.env.ATTACHMENTS_DIR = previousAttachmentsDir;
    await fs.rm(attachmentsDir, { recursive: true, force: true });
    await teardownTestDb();
  });
  beforeEach(async () => {
    await truncateAllTables();
    invalidateRagImageIntakeCache();
    storeFaults.clear();
    if (redis) await redis.flushDb();
    const prov = await query<{ id: string }>(
      `INSERT INTO llm_providers (name, base_url, auth_type, verify_ssl, default_model)
       VALUES ('vision-box', 'http://vision/v1', 'none', TRUE, 'qwen3-vl') RETURNING id`,
    );
    providerId = prov.rows[0]!.id;
  });

  it('unassigned: sweeps and reconciles, analyzes nothing, and answers the full shape with reason unassigned', async () => {
    await retain(null);
    const pageId = await seedPage('<img src="/api/attachments/1/a.png"><img src="/api/attachments/1/gone.png">');
    await writeAttachment(pageId, 'a.png', png(4, 4));
    const c = client();

    const result = await runImageAnalysisBatch({ deps: deps({ analyzeImage: c.analyzeImage }, null) });

    expect(result).toMatchObject({ processed: 0, failed: 0, terminal: 0, reason: 'unassigned', reconciledPages: 1, skipped: 1 });
    for (const k of SHAPE_KEYS) expect(result).toHaveProperty(k);
    expect(c.calls).toHaveLength(0);
    expect((await rowsFor(pageId)).map((r) => r.status)).toEqual(['pending', 'skipped']);
    expect((await pageState(pageId)).analysisDirty).toBe(false);
  });

  it('the first batch after 115 lands drains 116\'s backlog seed into pending rows without re-embedding one page (D6.3)', async () => {
    // An existing, fully embedded corpus: every image page was flagged by
    // migration 116's backlog seed and is NOT text-dirty. Store just landed,
    // nothing assigned yet.
    await retain(null);
    const pages: number[] = [];
    for (const n of ['a', 'b', 'c']) {
      const pageId = await seedPage(`<p>prose</p><img src="/api/attachments/1/${n}.png">`);
      await writeAttachment(pageId, `${n}.png`, png(4, 4));
      await query(`UPDATE pages SET embedding_dirty = FALSE, embedding_status = 'embedded' WHERE id = $1`, [pageId]);
      pages.push(pageId);
    }

    const result = await runImageAnalysisBatch({ deps: deps({}, null) });

    expect(result).toMatchObject({ reconciledPages: 3, reason: 'unassigned', processed: 0 });
    for (const pageId of pages) {
      expect((await rowsFor(pageId)).map((r) => r.status)).toEqual(['pending']);
      // No valid derived set moved: no revision bump, no text re-embed queued.
      expect(await pageState(pageId)).toEqual({ revision: 0, embeddingDirty: false, analysisDirty: false });
    }
    const dirty = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM pages WHERE embedding_dirty`);
    expect(dirty.rows[0]!.n).toBe(0);
  });

  it('shuts the gate on a non-true verdict and on identity drift, with no call either way', async () => {
    const retained = identityFor('http://vision/v1');
    await retain(retained);
    await seedPending(['a.png']);
    const c = client();

    const capability = await runImageAnalysisBatch({
      deps: deps({ analyzeImage: c.analyzeImage, getVisionCapability: async () => null }, retained),
    });
    expect(capability).toMatchObject({ processed: 0, reason: 'capability' });

    // The provider's base_url moved under the retained identity.
    const drift = await runImageAnalysisBatch({
      deps: deps({ analyzeImage: c.analyzeImage }, identityFor('http://moved/v1')),
    });
    expect(drift).toMatchObject({ processed: 0, reason: 'identity_drift' });
    expect(c.calls).toHaveLength(0);
  });

  it('analyzes work rows with the retained identity, stamps them, bumps the page, and records the run', async () => {
    const retained = identityFor('http://vision/v1');
    await retain(retained);
    const { pageId } = await seedPending(['a.png', 'b.png']);
    const c = client();

    const result = await runImageAnalysisBatch({ deps: deps({ analyzeImage: c.analyzeImage, getMaxOutputTokens: async () => 6000 }, retained) });

    expect(result).toMatchObject({ processed: 2, failed: 0, terminal: 0 });
    expect(result.reason).toBeUndefined();
    expect(c.calls).toHaveLength(2);
    expect(c.calls[0]).toMatchObject({
      mimeType: 'image/png',
      identity: { providerId, model: 'qwen3-vl', baseUrl: 'http://vision/v1' },
      maxOutputTokens: 6000,
    });
    const rows = await rowsFor(pageId);
    for (const row of rows) {
      expect(row).toMatchObject({
        status: 'analyzed',
        attempts: 0,
        next_attempt_at: null,
        error: null,
        payload: PAYLOAD,
        identity_hash: retained.identityHash,
        prompt_version: IMAGE_ANALYSIS_PROMPT_VERSION,
        schema_version: IMAGE_ANALYSIS_SCHEMA_VERSION,
        analysis_version: 1,
        provider_id: providerId,
        model: 'qwen3-vl',
        base_url: 'http://vision/v1',
      });
    }
    expect(await pageState(pageId)).toMatchObject({ revision: 2, embeddingDirty: true });
    expect(await readImageAnalysisLastRun()).toMatchObject({ processed: 2 });
  });

  it('Run Now is one bounded batch: the batch size caps the calls, the rest wait', async () => {
    const retained = identityFor('http://vision/v1');
    await retain(retained);
    const { pageId } = await seedPending(['a.png', 'b.png', 'c.png']);
    const c = client();

    const result = await runImageAnalysisBatch({ deps: deps({ analyzeImage: c.analyzeImage, getBatchSize: async () => 2 }, retained) });

    expect(result.processed).toBe(2);
    expect(c.calls).toHaveLength(2);
    expect((await rowsFor(pageId)).map((r) => r.status)).toEqual(['analyzed', 'analyzed', 'pending']);
  });

  it('sweep: re-pends analyzed rows that fail the predicate (payload kept, page bumped); the inverse reuses them without a call', async () => {
    const before = identityFor('http://vision/v1');
    await retain(before);
    const { pageId } = await seedPending(['a.png']);
    const c = client();
    await runImageAnalysisBatch({ deps: deps({ analyzeImage: c.analyzeImage }, before) });
    await query(`UPDATE pages SET embedding_dirty = FALSE WHERE id = $1`, [pageId]);
    const bumped = (await pageState(pageId)).revision;

    // The operator re-assigned to another endpoint: the retained identity moved.
    const after = identityFor('http://other/v1');
    await retain(after);
    const swept = await runImageAnalysisBatch({ deps: deps({ analyzeImage: c.analyzeImage, getVisionCapability: async () => null }, after) });

    expect(swept).toMatchObject({ repended: 1, reused: 0, reason: 'capability' });
    let rows = await rowsFor(pageId);
    expect(rows[0]).toMatchObject({ status: 'pending', payload: PAYLOAD, identity_hash: before.identityHash, analysis_version: 1 });
    expect(await pageState(pageId)).toMatchObject({ revision: bumped + 1, embeddingDirty: true });

    // …and came back. The kept payload passes again: reused, no call, no
    // analysis_version bump.
    await retain(before);
    await query(`UPDATE pages SET embedding_dirty = FALSE WHERE id = $1`, [pageId]);
    const returned = await runImageAnalysisBatch({ deps: deps({ analyzeImage: c.analyzeImage }, before) });

    expect(returned).toMatchObject({ reused: 1, repended: 0, processed: 0 });
    expect(c.calls).toHaveLength(1);
    rows = await rowsFor(pageId);
    expect(rows[0]).toMatchObject({ status: 'analyzed', analysis_version: 1 });
    expect(await pageState(pageId)).toMatchObject({ revision: bumped + 2, embeddingDirty: true });
  });

  it('sweep: a stale failed or terminal row returns to failed, attempts 0, due now — once', async () => {
    const retained = identityFor('http://vision/v1');
    await retain(retained);
    const { pageId, ids } = await seedPending(['a.png', 'b.png']);
    await query(
      `UPDATE page_image_analyses SET status = 'failed_terminal', attempts = 5, next_attempt_at = NULL, error = 'malformed',
              identity_hash = 'old-hash', prompt_version = $2, schema_version = $3 WHERE id = $1`,
      [ids[0], IMAGE_ANALYSIS_PROMPT_VERSION, IMAGE_ANALYSIS_SCHEMA_VERSION],
    );
    await query(
      `UPDATE page_image_analyses SET status = 'failed', attempts = 3, next_attempt_at = NOW() + interval '1 day', error = 'refused',
              identity_hash = $2, prompt_version = $3 + 1, schema_version = $4 WHERE id = $1`,
      [ids[1], retained.identityHash, IMAGE_ANALYSIS_PROMPT_VERSION, IMAGE_ANALYSIS_SCHEMA_VERSION],
    );

    const first = await runImageAnalysisBatch({ deps: deps({ getVisionCapability: async () => null }, retained) });
    expect(first.returned).toBe(2);
    const rows = await rowsFor(pageId);
    for (const row of rows) {
      expect(row.status).toBe('failed');
      expect(row.attempts).toBe(0);
      expect(row.next_attempt_at!.getTime()).toBeLessThanOrEqual(Date.now());
    }
    // Already in that state: not rewritten every batch.
    const second = await runImageAnalysisBatch({ deps: deps({ getVisionCapability: async () => null }, retained) });
    expect(second.returned).toBe(0);
  });

  it('sweep: re-opens truncated rows only when the ceiling was raised above the recorded one', async () => {
    const retained = identityFor('http://vision/v1');
    await retain(retained);
    const { pageId, ids } = await seedPending(['a.png', 'b.png']);
    const stamp = `identity_hash = $2, prompt_version = ${IMAGE_ANALYSIS_PROMPT_VERSION}, schema_version = ${IMAGE_ANALYSIS_SCHEMA_VERSION}`;
    await query(
      `UPDATE page_image_analyses SET status = 'failed_terminal', attempts = 5, next_attempt_at = NULL, error = 'truncated:8192', ${stamp} WHERE id = $1`,
      [ids[0], retained.identityHash],
    );
    await query(
      `UPDATE page_image_analyses SET status = 'failed', attempts = 2, next_attempt_at = NOW() + interval '1 hour', error = 'truncated:16384', ${stamp} WHERE id = $1`,
      [ids[1], retained.identityHash],
    );

    const lowered = await runImageAnalysisBatch({ deps: deps({ getVisionCapability: async () => null, getMaxOutputTokens: async () => 8192 }, retained) });
    expect(lowered.reopened).toBe(0);

    const raised = await runImageAnalysisBatch({ deps: deps({ getVisionCapability: async () => null, getMaxOutputTokens: async () => 12000 }, retained) });
    expect(raised.reopened).toBe(1);
    const rows = await rowsFor(pageId);
    expect(rows[0]).toMatchObject({ status: 'failed', attempts: 0, error: 'truncated:8192' });
    expect(rows[1]).toMatchObject({ status: 'failed', attempts: 2, error: 'truncated:16384' });
  });

  it('backoff: a failure counts an attempt with a doubling due time; a deterministic class goes terminal at the cap, unavailable never does', async () => {
    const retained = identityFor('http://vision/v1');
    await retain(retained);
    const { pageId, ids } = await seedPending(['det.png', 'unav.png']);
    const c = client([fail('malformed'), fail('unavailable', { httpStatus: 503 })]);

    const result = await runImageAnalysisBatch({ deps: deps({ analyzeImage: c.analyzeImage }, retained) });

    expect(result).toMatchObject({ processed: 0, failed: 2, terminal: 0 });
    let rows = await rowsFor(pageId);
    expect(rows[0]).toMatchObject({ status: 'failed', attempts: 1, error: 'malformed', payload: null, identity_hash: retained.identityHash });
    expect(rows[1]).toMatchObject({ status: 'failed', attempts: 1, error: 'unavailable:503' });
    // 15 min × 2^0 for the first failure.
    const due = rows[0]!.next_attempt_at!.getTime() - Date.now();
    expect(due).toBeGreaterThan(14 * 60_000);
    expect(due).toBeLessThanOrEqual(15 * 60_000);

    // At the cap: attempts = MAX - 1 and due now, one more identical reply.
    await query(
      `UPDATE page_image_analyses SET attempts = $2, next_attempt_at = NOW() WHERE id = ANY($1::bigint[])`,
      [ids, IMAGE_ANALYSIS_MAX_ATTEMPTS - 1],
    );
    const capped = client([fail('malformed'), fail('unavailable', { httpStatus: 503 })]);
    const atCap = await runImageAnalysisBatch({ deps: deps({ analyzeImage: capped.analyzeImage }, retained) });

    expect(atCap).toMatchObject({ failed: 2, terminal: 1 });
    rows = await rowsFor(pageId);
    expect(rows[0]).toMatchObject({ status: 'failed_terminal', attempts: IMAGE_ANALYSIS_MAX_ATTEMPTS, next_attempt_at: null });
    expect(rows[1]).toMatchObject({ status: 'failed', attempts: IMAGE_ANALYSIS_MAX_ATTEMPTS });
    expect(rows[1]!.next_attempt_at).not.toBeNull();
    // Success resets the budget.
    await query(`UPDATE page_image_analyses SET next_attempt_at = NOW() WHERE id = $1`, [ids[1]]);
    await runImageAnalysisBatch({ deps: deps({ analyzeImage: client().analyzeImage }, retained) });
    expect((await rowsFor(pageId))[1]).toMatchObject({ status: 'analyzed', attempts: 0 });
  });

  it('provider-status stop: a 4xx outside the rejected list ends the batch before the next call and re-probes', async () => {
    const retained = identityFor('http://vision/v1');
    await retain(retained);
    const { pageId } = await seedPending(['a.png', 'b.png', 'c.png']);
    const c = client([fail('unavailable', { httpStatus: 401, providerLevel: true })]);
    const refresh = vi.fn(async () => undefined);

    const result = await runImageAnalysisBatch({ deps: deps({ analyzeImage: c.analyzeImage, refreshVisionCapability: refresh }, retained) });

    expect(result).toMatchObject({ processed: 0, failed: 1, terminal: 0, reason: 'provider_status', httpStatus: 401 });
    expect(c.calls).toHaveLength(1);
    expect(refresh).toHaveBeenCalledWith(providerId, 'qwen3-vl');
    const rows = await rowsFor(pageId);
    expect(rows[0]).toMatchObject({ status: 'failed', attempts: 1, error: 'unavailable:401' });
    // Rows not yet attempted are not charged.
    expect(rows.slice(1).map((r) => [r.status, r.attempts])).toEqual([['pending', 0], ['pending', 0]]);
    expect(await readImageAnalysisLastRun()).toMatchObject({ reason: 'provider_status', httpStatus: 401 });
  });
  it('uniform-rejection stop: three identical rejected statuses first rewrite those rows unavailable, never terminal, and end the batch', async () => {
    const retained = identityFor('http://vision/v1');
    await retain(retained);
    const { pageId, ids } = await seedPending(['a.png', 'b.png', 'c.png', 'd.png']);
    // All four are due retries, oldest first. The first row's rejection is
    // its fifth attempt: the per-row write takes it terminal, and the stop's
    // rewrite must take precedence over the cap.
    for (const [i, id] of ids.entries()) {
      await query(
        `UPDATE page_image_analyses SET status = 'failed', error = 'malformed', attempts = $2,
                next_attempt_at = NOW() - interval '10 minutes' + ($3 * interval '1 minute'),
                identity_hash = $4, prompt_version = $5, schema_version = $6
          WHERE id = $1`,
        [id, i === 0 ? IMAGE_ANALYSIS_MAX_ATTEMPTS - 1 : 1, i, retained.identityHash, IMAGE_ANALYSIS_PROMPT_VERSION, IMAGE_ANALYSIS_SCHEMA_VERSION],
      );
    }
    const rejected = (): AnalyzeImageResult => fail('rejected', { httpStatus: 400 });
    const c = client([rejected(), rejected(), rejected()]);
    const refresh = vi.fn(async () => undefined);

    const result = await runImageAnalysisBatch({ deps: deps({ analyzeImage: c.analyzeImage, refreshVisionCapability: refresh }, retained) });

    expect(result).toMatchObject({ processed: 0, failed: 3, terminal: 0, reason: 'uniform_rejection', httpStatus: 400 });
    expect(c.calls).toHaveLength(3);
    expect(refresh).toHaveBeenCalledTimes(1);
    const rows = await rowsFor(pageId);
    expect(rows.map((r) => [r.status, r.error, r.attempts])).toEqual([
      ['failed', 'unavailable:400', IMAGE_ANALYSIS_MAX_ATTEMPTS],
      ['failed', 'unavailable:400', 2],
      ['failed', 'unavailable:400', 2],
      ['failed', 'malformed', 1],
    ]);
    // Never terminal, always due: both of migration 115's CHECKs hold.
    for (const row of rows) expect(row.next_attempt_at).not.toBeNull();
  });

  it('does not trip the uniform stop when a rejection follows a success or a different status', async () => {
    const retained = identityFor('http://vision/v1');
    await retain(retained);
    await seedPending(['a.png', 'b.png', 'c.png', 'd.png']);
    const c = client([fail('rejected', { httpStatus: 400 }), fail('rejected', { httpStatus: 413 }), fail('rejected', { httpStatus: 400 })]);

    const result = await runImageAnalysisBatch({ deps: deps({ analyzeImage: c.analyzeImage }, retained) });

    expect(result.reason).toBeUndefined();
    expect(c.calls).toHaveLength(4);
    expect(result).toMatchObject({ processed: 1, failed: 3 });
  });

  it('commit predicate: a result whose bytes moved during the call is discarded, never published', async () => {
    const retained = identityFor('http://vision/v1');
    await retain(retained);
    const { pageId, ids } = await seedPending(['a.png']);
    const replaced = png(9, 9);
    const c = {
      calls: 0,
      analyzeImage: async (): Promise<AnalyzeImageResult> => {
        c.calls++;
        // The reconcile lands while the call is in flight: new bytes, new hash, payload nulled.
        await query(`UPDATE page_image_analyses SET content_hash = $2, payload = NULL WHERE id = $1`, [ids[0], sha(replaced)]);
        return ok();
      },
    };

    const result = await runImageAnalysisBatch({ deps: deps({ analyzeImage: c.analyzeImage }, retained) });

    expect(result).toMatchObject({ processed: 0, skipped: 1, failed: 0 });
    const rows = await rowsFor(pageId);
    expect(rows[0]).toMatchObject({ status: 'pending', payload: null, analysis_version: 0 });
    expect((await pageState(pageId)).embeddingDirty).toBe(false);
  });

  it('bytes that changed under the row before its call spend no call and re-queue the page', async () => {
    const retained = identityFor('http://vision/v1');
    await retain(retained);
    const { pageId } = await seedPending(['a.png']);
    await writeAttachment(pageId, 'a.png', png(7, 7));
    const c = client();

    const result = await runImageAnalysisBatch({ deps: deps({ analyzeImage: c.analyzeImage }, retained) });

    expect(c.calls).toHaveLength(0);
    expect(result).toMatchObject({ processed: 0, skipped: 1 });
    expect((await pageState(pageId)).analysisDirty).toBe(true);
  });

  it('rows whose bytes are unreadable at call time leave the work window as skipped (missing) and cannot starve a later pending row', async () => {
    const retained = identityFor('http://vision/v1');
    await retain(retained);
    // Two rows whose attachments were cleaned after the reconcile (their
    // references stay in the body), then one readable row. With a window of
    // two, the unreadable pair fills every batch unless it is taken out.
    const { pageId, ids } = await seedPending(['gone-1.png', 'gone-2.png', 'ok.png']);
    await fs.rm(path.join(attachmentsDir, String(pageId), 'gone-1.png'));
    await fs.rm(path.join(attachmentsDir, String(pageId), 'gone-2.png'));
    await query(`UPDATE pages SET image_analysis_revision = 0, embedding_dirty = FALSE WHERE id = $1`, [pageId]);
    const c = client();

    const first = await runImageAnalysisBatch({ deps: deps({ analyzeImage: c.analyzeImage, getBatchSize: async () => 2 }, retained) });

    expect(first).toMatchObject({ processed: 0, skipped: 2, failed: 0 });
    expect(c.calls).toHaveLength(0);
    let rows = await rowsFor(pageId);
    expect(rows.slice(0, 2).map((r) => [r.status, r.skip_reason, r.content_hash, r.attempts, r.next_attempt_at, r.error])).toEqual([
      ['skipped', 'missing', '', 0, null, null],
      ['skipped', 'missing', '', 0, null, null],
    ]);
    // Nothing composed before or after: no bump, and the page is not
    // re-queued for a reconcile that would find the same absent files.
    expect(await pageState(pageId)).toEqual({ revision: 0, embeddingDirty: false, analysisDirty: false });

    // The next batch reaches the readable row.
    const second = await runImageAnalysisBatch({ deps: deps({ analyzeImage: c.analyzeImage, getBatchSize: async () => 2 }, retained) });
    expect(second).toMatchObject({ processed: 1, skipped: 0 });
    expect(c.calls).toHaveLength(1);
    expect((await rowsFor(pageId)).map((r) => r.status)).toEqual(['skipped', 'skipped', 'analyzed']);

    // Recovery: the bytes come back and their writer raises the page flag —
    // the reconcile re-pends the skipped row and the batch analyzes it.
    await writeAttachment(pageId, 'gone-1.png', png(4, 4));
    await query(`UPDATE pages SET image_analysis_dirty = TRUE WHERE id = $1`, [pageId]);
    const third = await runImageAnalysisBatch({ deps: deps({ analyzeImage: c.analyzeImage, getBatchSize: async () => 2 }, retained) });
    expect(third).toMatchObject({ reconciledPages: 1, processed: 1 });
    rows = await rowsFor(pageId);
    expect(rows.map((r) => [r.attachment_key, r.status, r.skip_reason])).toEqual([
      ['gone-1.png', 'analyzed', null],
      ['gone-2.png', 'skipped', 'missing'],
      ['ok.png', 'analyzed', null],
    ]);
    expect(ids).toHaveLength(3);
  });

  it('bytes that are no longer a raster at call time are skipped with the intake\'s reason under the hash predicate', async () => {
    const retained = identityFor('http://vision/v1');
    await retain(retained);
    const { pageId } = await seedPending(['diagram.png']);
    // draw.io XML behind a .png name replaced the raster after the reconcile.
    await writeAttachment(pageId, 'diagram.png', Buffer.from('<mxfile host="Confluence"><diagram/></mxfile>', 'utf8'));
    const c = client();

    const result = await runImageAnalysisBatch({ deps: deps({ analyzeImage: c.analyzeImage }, retained) });

    expect(result).toMatchObject({ processed: 0, skipped: 1 });
    expect(c.calls).toHaveLength(0);
    const rows = await rowsFor(pageId);
    expect(rows[0]).toMatchObject({ status: 'skipped', skip_reason: 'unsupported', attempts: 0, next_attempt_at: null });
    expect(rows[0]!.content_hash).toHaveLength(64);
  });

  it('a file that is there but unreadable at call time fails the row (unavailable:bytes) with backoff — never skipped (missing) — and is re-read when due', async () => {
    const retained = identityFor('http://vision/v1');
    await retain(retained);
    const { pageId } = await seedPending(['locked.png']);
    const [seeded] = await rowsFor(pageId);
    await query(`UPDATE pages SET image_analysis_revision = 0, embedding_dirty = FALSE WHERE id = $1`, [pageId]);
    storeFaults.set('locked.png', eacces('locked.png'));
    const c = client();
    const run = () => runImageAnalysisBatch({ deps: deps({ analyzeImage: c.analyzeImage }, retained) });

    const first = await run();

    // Charged like any `unavailable`: one attempt, backoff, no call, no bump,
    // no flag — and the row keeps the hash and stays out of `skipped`.
    expect(first).toMatchObject({ processed: 0, skipped: 0, failed: 1, terminal: 0 });
    expect(c.calls).toHaveLength(0);
    let [row] = await rowsFor(pageId);
    expect(row).toMatchObject({ status: 'failed', error: 'unavailable:bytes', attempts: 1, skip_reason: null, content_hash: seeded!.content_hash });
    expect(row!.next_attempt_at!.getTime()).toBeGreaterThan(Date.now());
    expect(await pageState(pageId)).toEqual({ revision: 0, embeddingDirty: false, analysisDirty: false });

    // Not due: the next batch leaves it alone.
    expect(await run()).toMatchObject({ failed: 0, skipped: 0 });
    expect((await rowsFor(pageId))[0]!.attempts).toBe(1);

    // Never terminal (D8): at the cap it is still `failed` and still due later.
    await query(`UPDATE page_image_analyses SET attempts = $2, next_attempt_at = NOW() WHERE id = $1`, [row!.id, IMAGE_ANALYSIS_MAX_ATTEMPTS - 1]);
    expect(await run()).toMatchObject({ failed: 1, terminal: 0 });
    [row] = await rowsFor(pageId);
    expect(row).toMatchObject({ status: 'failed', attempts: IMAGE_ANALYSIS_MAX_ATTEMPTS, error: 'unavailable:bytes' });
    expect(c.calls).toHaveLength(0);

    // The fault clears (permissions fixed, mount back): the due row is read
    // again and analyzed with no writer having touched the page.
    storeFaults.clear();
    await query(`UPDATE page_image_analyses SET next_attempt_at = NOW() WHERE id = $1`, [row!.id]);
    expect(await run()).toMatchObject({ processed: 1, failed: 0 });
    expect(c.calls).toHaveLength(1);
    [row] = await rowsFor(pageId);
    expect(row).toMatchObject({ status: 'analyzed', attempts: 0, error: null });
    expect(await pageState(pageId)).toMatchObject({ revision: 1, embeddingDirty: true });
  });

  it('attempts that outran the backoff exponent still finish the batch, write the last run and leave the row due at the 24 h cap', async () => {
    const retained = identityFor('http://vision/v1');
    await retain(retained);
    const { pageId } = await seedPending(['locked.png']);
    storeFaults.set('locked.png', eacces('locked.png'));
    const c = client();
    const run = () => runImageAnalysisBatch({ deps: deps({ analyzeImage: c.analyzeImage }, retained) });

    // One real failure first, so the row carries the identity it failed
    // under and step 1's stale-failed return does not reset its budget.
    expect(await run()).toMatchObject({ failed: 1 });
    const [charged] = await rowsFor(pageId);
    // About 28 days of a persistent EACCES. `unavailable` never goes
    // terminal, so nothing capped `attempts` — and the backoff multiplied
    // before it clamped, so from 34 up the UPDATE raised `interval out of
    // range`: the throw escaped the batch, no last-run line was written and
    // the row headed the due-ordered work window on every later batch, with
    // the analyze step permanently dead (#1626 review r3).
    await query(`UPDATE page_image_analyses SET attempts = 40, next_attempt_at = NOW() WHERE id = $1`, [charged!.id]);
    await query(`DELETE FROM admin_settings WHERE setting_key = $1`, [IMAGE_ANALYSIS_LAST_RUN_KEY]);

    const result = await run();

    expect(result).toMatchObject({ failed: 1, terminal: 0 });
    const [row] = await rowsFor(pageId);
    expect(row).toMatchObject({ status: 'failed', error: 'unavailable:bytes', attempts: 41 });
    const dueInMs = row!.next_attempt_at!.getTime() - Date.now();
    expect(dueInMs).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(dueInMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
    // The batch reached its end, so the operator's card moved on with it.
    expect(await readImageAnalysisLastRun()).toMatchObject({ failed: 1 });
  });

  it('a file that is there but unreadable at reconcile time still indexes the page\'s readable images, counts the page failed and leaves it dirty', async () => {
    const retained = identityFor('http://vision/v1');
    await retain(retained);
    const pageId = await seedPage('<img src="/api/attachments/1/locked.png"><img src="/api/attachments/1/ok.png">');
    await writeAttachment(pageId, 'locked.png', png(4, 4));
    await writeAttachment(pageId, 'ok.png', png(5, 4));
    storeFaults.set('locked.png', eacces('locked.png'));
    const c = client();
    const run = () => runImageAnalysisBatch({ deps: deps({ analyzeImage: c.analyzeImage }, retained) });

    const first = await run();

    // AC-3: the readable image is indexed in the same batch — one locked file
    // no longer discards the page's whole desired set. Nothing durable
    // describes the unreadable one, the page stays dirty (D6.2), and the
    // operator's counters say a page did not complete.
    expect(first).toMatchObject({ reconciledPages: 1, pagesFailed: 1, processed: 1, failed: 0, skipped: 0 });
    expect((await rowsFor(pageId)).map((r) => [r.attachment_key, r.status])).toEqual([['ok.png', 'analyzed']]);
    expect((await pageState(pageId)).analysisDirty).toBe(true);
    expect(c.calls).toHaveLength(1);
    // Visible where #1618's card reads it, not only in the return value.
    expect(await readImageAnalysisLastRun()).toMatchObject({ pagesFailed: 1, processed: 1 });

    storeFaults.clear();
    const second = await run();

    // Recovery: the still-dirty page is re-enumerated, the freed reference is
    // pended and analyzed, and the already-analyzed sibling is not re-sent.
    expect(second).toMatchObject({ reconciledPages: 1, pagesFailed: 0, processed: 1, skipped: 0 });
    expect(c.calls).toHaveLength(2);
    expect((await rowsFor(pageId)).map((r) => [r.attachment_key, r.status])).toEqual([['locked.png', 'analyzed'], ['ok.png', 'analyzed']]);
    expect((await pageState(pageId)).analysisDirty).toBe(false);

    // And an unreadable reference is not a deletion: the fault returns, the
    // page is re-dirtied, and its already-analyzed row stands rather than
    // being swept out with the references that left the body.
    storeFaults.set('locked.png', eacces('locked.png'));
    await query(`UPDATE pages SET image_analysis_dirty = TRUE WHERE id = $1`, [pageId]);

    const third = await run();

    expect(third).toMatchObject({ reconciledPages: 1, pagesFailed: 1, processed: 0, removed: 0 });
    expect(c.calls).toHaveLength(2);
    expect((await rowsFor(pageId)).map((r) => [r.attachment_key, r.status])).toEqual([['locked.png', 'analyzed'], ['ok.png', 'analyzed']]);
    expect((await pageState(pageId)).analysisDirty).toBe(true);
  });

  it.skipIf(!redis)('lease loss: the batch stops before its next write, committed rows stand, the result says so', async () => {
    const retained = identityFor('http://vision/v1');
    await retain(retained);
    const { pageId } = await seedPending(['a.png', 'b.png', 'c.png']);
    let calls = 0;
    const c: ImageAnalysisWorkerDeps['analyzeImage'] = async () => {
      calls++;
      if (calls === 2) {
        // Another holder took the lease mid-call (a force-release, or an
        // expiry and re-acquire on another pod). Detection is the renewal
        // TIMER's (the #1612 pattern), so this is a real wall-clock wait for
        // its next tick — a fake clock cannot drive the Redis round trip.
        await redis!.set(`worker:lock:${IMAGE_ANALYSIS_WORKER_LOCK}`, 'someone-else');
        const tick = Promise.withResolvers<void>();
        setTimeout(tick.resolve, 80);
        await tick.promise;
      }
      return ok();
    };

    const result = await runImageAnalysisBatch({ deps: deps({ analyzeImage: c }, retained), lockRefreshMs: 20 });

    expect(result.reason).toBe('lease_lost');
    expect(result.processed).toBe(1);
    expect(calls).toBe(2);
    const rows = await rowsFor(pageId);
    expect(rows.map((r) => r.status)).toEqual(['analyzed', 'pending', 'pending']);
    // The other holder's lock survives the stand-down: release is ownership-checked.
    expect(await redis!.get(`worker:lock:${IMAGE_ANALYSIS_WORKER_LOCK}`)).toBe('someone-else');
    // D6.4: the loser writes nothing after the loss — not even the last-run
    // line; the partial counts are the failed job's message.
    expect(await readImageAnalysisLastRun()).toBeNull();
  });

  it.skipIf(!redis)('a second trigger while a batch holds the lease does nothing', async () => {
    const retained = identityFor('http://vision/v1');
    await retain(retained);
    await seedPending(['a.png']);
    await redis!.set(`worker:lock:${IMAGE_ANALYSIS_WORKER_LOCK}`, 'other-pod');
    const c = client();

    const result = await runImageAnalysisBatch({ deps: deps({ analyzeImage: c.analyzeImage }, retained) });

    expect(result).toMatchObject({ alreadyRunning: true, processed: 0 });
    expect(c.calls).toHaveLength(0);
  });

  it('Retry failed makes every failed and terminal row due at once; Re-analyze all re-pends with payloads nulled and bumps pages', async () => {
    const retained = identityFor('http://vision/v1');
    await retain(retained);
    const { pageId, ids } = await seedPending(['a.png', 'b.png', 'c.png']);
    await runImageAnalysisBatch({ deps: deps({ analyzeImage: client([ok(), fail('malformed'), fail('refused')]).analyzeImage }, retained) });
    await query(`UPDATE page_image_analyses SET status = 'failed_terminal', attempts = 5, next_attempt_at = NULL WHERE id = $1`, [ids[2]]);

    expect(await retryFailedImageAnalyses()).toBe(2);
    let rows = await rowsFor(pageId);
    expect(rows.map((r) => [r.status, r.attempts])).toEqual([['analyzed', 0], ['failed', 0], ['failed', 0]]);
    expect(rows[2]!.next_attempt_at!.getTime()).toBeLessThanOrEqual(Date.now());
    expect(rows[2]!.error).toBe('refused');

    await query(`UPDATE pages SET embedding_dirty = FALSE WHERE id = $1`, [pageId]);
    const revision = (await pageState(pageId)).revision;
    expect(await reanalyzeAllImages()).toBe(3);
    rows = await rowsFor(pageId);
    expect(rows.map((r) => [r.status, r.payload, r.attempts, r.next_attempt_at])).toEqual([
      ['pending', null, 0, null],
      ['pending', null, 0, null],
      ['pending', null, 0, null],
    ]);
    expect(await pageState(pageId)).toMatchObject({ revision: revision + 1, embeddingDirty: true });
    // Nothing to reuse: the next batch must call for every row.
    const c = client();
    const again = await runImageAnalysisBatch({ deps: deps({ analyzeImage: c.analyzeImage }, retained) });
    expect(again).toMatchObject({ reused: 0, processed: 3 });
    expect(c.calls).toHaveLength(3);
  });
});
