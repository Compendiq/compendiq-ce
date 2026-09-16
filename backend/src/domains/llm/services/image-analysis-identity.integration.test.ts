import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { IMAGE_ANALYSIS_SCHEMA_VERSION } from '@compendiq/contracts';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import { bumpProviderCacheVersion } from './cache-bus.js';
import {
  computeIdentityHash,
  countRowsInvalidatedBy,
  getRetainedImageAnalysisIdentity,
  IMAGE_ANALYSIS_IDENTITY_KEY,
  IMAGE_ANALYSIS_PROMPT_VERSION,
  ImageAnalysisResolutionError,
  reanalysisScopeFor,
  resolveCandidateImageAnalysisIdentity,
  resolveImageAnalysisIdentity,
  retainImageAnalysisIdentity,
} from './image-analysis-identity.js';

/**
 * ADR-027 D5 — "every identity dimension": the three identity fields, the two
 * version constants and `content_hash` each change whether an analyzed row is
 * valid; the seventh case, the output-token ceiling, must change nothing.
 * Against real Postgres, because validity is a SQL predicate and the
 * retained identity is a row.
 */

const dbAvailable = await isDbAvailable();

beforeAll(async () => {
  if (!dbAvailable) return;
  await setupTestDb();
}, 30_000);

afterAll(async () => {
  if (!dbAvailable) return;
  await teardownTestDb();
});

beforeEach(async () => {
  if (!dbAvailable) return;
  await truncateAllTables();
  await bumpProviderCacheVersion();
});

async function seedProvider(name: string, baseUrl: string, model: string | null): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO llm_providers (name, base_url, auth_type, verify_ssl, is_default, default_model)
     VALUES ($1, $2, 'none', true, false, $3) RETURNING id`,
    [name, baseUrl, model],
  );
  await bumpProviderCacheVersion();
  return r.rows[0]!.id;
}

async function seedPage(title: string): Promise<number> {
  const r = await query<{ id: number }>(
    `INSERT INTO pages (title, source, visibility, body_html) VALUES ($1, 'standalone', 'shared', '<p>x</p>') RETURNING id`,
    [title],
  );
  return r.rows[0]!.id;
}

/** One analyzed row under an identity and versions the test chooses. */
async function seedAnalyzed(
  pageId: number,
  key: string,
  over: { identityHash: string; promptVersion?: number; schemaVersion?: number; contentHash?: string },
): Promise<void> {
  await query(
    `INSERT INTO page_image_analyses
       (page_id, source, attachment_key, content_hash, format, status, identity_hash, prompt_version, schema_version, payload, analyzed_at)
     VALUES ($1, 'local', $2, $3, 'png', 'analyzed', $4, $5, $6, '{"schemaVersion":1}'::jsonb, NOW())`,
    [
      pageId,
      key,
      over.contentHash ?? `sha256-${key}`,
      over.identityHash,
      over.promptVersion ?? IMAGE_ANALYSIS_PROMPT_VERSION,
      over.schemaVersion ?? IMAGE_ANALYSIS_SCHEMA_VERSION,
    ],
  );
}

/** D5's validity predicate, exactly as composition binds it, for one row. */
async function isValid(pageId: number, key: string, retainedHash: string): Promise<boolean> {
  const r = await query<{ ok: boolean }>(
    `SELECT (status = 'analyzed' AND identity_hash = $3 AND prompt_version = $4 AND schema_version = $5) AS ok
       FROM page_image_analyses WHERE page_id = $1 AND attachment_key = $2`,
    [pageId, key, retainedHash, IMAGE_ANALYSIS_PROMPT_VERSION, IMAGE_ANALYSIS_SCHEMA_VERSION],
  );
  return r.rows[0]!.ok;
}

const BASE = { providerId: '00000000-0000-4000-8000-000000000001', model: 'qwen3-vl', baseUrl: 'http://vision/v1' };

describe('computeIdentityHash — D5 canonical form', () => {
  it('is sha256 over the newline-joined triple, hex', () => {
    expect(computeIdentityHash(BASE)).toMatch(/^[0-9a-f]{64}$/);
    expect(computeIdentityHash(BASE)).toBe(computeIdentityHash({ ...BASE }));
  });

  it('changes with each of the three identity fields and with nothing else', () => {
    const h = computeIdentityHash(BASE);
    expect(computeIdentityHash({ ...BASE, providerId: '00000000-0000-4000-8000-000000000002' })).not.toBe(h);
    expect(computeIdentityHash({ ...BASE, model: 'qwen3-vl-8b' })).not.toBe(h);
    expect(computeIdentityHash({ ...BASE, baseUrl: 'http://vision:8001/v1' })).not.toBe(h);
    // A concatenation without the separator would let "ab"+"c" collide with "a"+"bc".
    expect(computeIdentityHash({ providerId: 'ab', model: 'c', baseUrl: 'd' }))
      .not.toBe(computeIdentityHash({ providerId: 'a', model: 'bc', baseUrl: 'd' }));
  });
});

describe.skipIf(!dbAvailable)('the validity predicate — six dimensions and one negative', () => {
  it('each identity dimension, each version constant and the content hash decides validity; the ceiling does not', async () => {
    const pageId = await seedPage('dims');
    const retained = computeIdentityHash(BASE);

    await seedAnalyzed(pageId, 'ok.png', { identityHash: retained });
    await seedAnalyzed(pageId, 'provider.png', { identityHash: computeIdentityHash({ ...BASE, providerId: '00000000-0000-4000-8000-000000000009' }) });
    await seedAnalyzed(pageId, 'model.png', { identityHash: computeIdentityHash({ ...BASE, model: 'other' }) });
    await seedAnalyzed(pageId, 'url.png', { identityHash: computeIdentityHash({ ...BASE, baseUrl: 'http://moved/v1' }) });
    await seedAnalyzed(pageId, 'prompt.png', { identityHash: retained, promptVersion: IMAGE_ANALYSIS_PROMPT_VERSION + 1 });
    await seedAnalyzed(pageId, 'schema.png', { identityHash: retained, schemaVersion: IMAGE_ANALYSIS_SCHEMA_VERSION + 1 });

    expect(await isValid(pageId, 'ok.png', retained)).toBe(true);
    expect(await isValid(pageId, 'provider.png', retained)).toBe(false);
    expect(await isValid(pageId, 'model.png', retained)).toBe(false);
    expect(await isValid(pageId, 'url.png', retained)).toBe(false);
    expect(await isValid(pageId, 'prompt.png', retained)).toBe(false);
    expect(await isValid(pageId, 'schema.png', retained)).toBe(false);

    // The sixth dimension, content_hash, is the reference revision: the
    // reconcile replaces it and NULLs the payload when the bytes change, and a
    // row with new bytes is `pending` — no longer analyzed under any identity.
    await query(
      `UPDATE page_image_analyses SET content_hash = 'sha256-new-bytes', status = 'pending', payload = NULL
        WHERE page_id = $1 AND attachment_key = 'ok.png'`,
      [pageId],
    );
    expect(await isValid(pageId, 'ok.png', retained)).toBe(false);

    // Seventh, negative: the ceiling enters neither the hash nor the predicate.
    await query(
      `INSERT INTO admin_settings (setting_key, setting_value) VALUES ('image_analysis_max_output_tokens', '16384')
       ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value`,
    );
    await seedAnalyzed(pageId, 'ceiling.png', { identityHash: retained });
    expect(await isValid(pageId, 'ceiling.png', retained)).toBe(true);
    expect(computeIdentityHash(BASE)).toBe(retained);
    expect(await countRowsInvalidatedBy(retained)).toBe(5);
  });

  it('countRowsInvalidatedBy counts analyzed rows only, and only those failing the predicate under the hash', async () => {
    const pageId = await seedPage('count');
    const a = computeIdentityHash(BASE);
    const b = computeIdentityHash({ ...BASE, model: 'b' });
    await seedAnalyzed(pageId, '1.png', { identityHash: a });
    await seedAnalyzed(pageId, '2.png', { identityHash: a });
    await seedAnalyzed(pageId, '3.png', { identityHash: b });
    await seedAnalyzed(pageId, '4.png', { identityHash: a, promptVersion: 0 });
    // A failed row under the other hash is not "invalidated" — it was never valid.
    await query(
      `INSERT INTO page_image_analyses (page_id, source, attachment_key, content_hash, format, status, identity_hash, next_attempt_at, error)
       VALUES ($1, 'local', 'f.png', 'h', 'png', 'failed', $2, NOW(), 'malformed')`,
      [pageId, b],
    );

    expect(await countRowsInvalidatedBy(a)).toBe(2); // 3.png (other hash) + 4.png (old prompt)
    expect(await countRowsInvalidatedBy(b)).toBe(3); // 1, 2 and 4
  });
});

describe.skipIf(!dbAvailable)('the retained identity (D7)', () => {
  it('is null until adopted; reanalysisScopeFor then answers changed with zero rows', async () => {
    expect(await getRetainedImageAnalysisIdentity()).toBeNull();
    expect(await reanalysisScopeFor(computeIdentityHash(BASE))).toEqual({ changed: true, reanalyzeRows: 0 });
  });

  it('retain writes the row once, resumes on the same hash without touching assignedAt, replaces on a different one with the invalidated count', async () => {
    const pageId = await seedPage('retain');
    const first = { ...BASE, identityHash: computeIdentityHash(BASE) };
    const r1 = await retainImageAnalysisIdentity(first);
    expect(r1).toMatchObject({ changed: true, reanalyzeRows: 0 });
    const stored1 = await getRetainedImageAnalysisIdentity();
    expect(stored1).toMatchObject({ ...BASE, identityHash: first.identityHash });
    expect(stored1!.assignedAt).toBe(r1.identity.assignedAt);

    await seedAnalyzed(pageId, 'a.png', { identityHash: first.identityHash });
    await seedAnalyzed(pageId, 'b.png', { identityHash: first.identityHash });

    // Same identity again: a resume. Nothing written, nothing invalidated.
    const r2 = await retainImageAnalysisIdentity(first);
    expect(r2).toEqual({ changed: false, reanalyzeRows: 0, identity: stored1 });
    expect((await getRetainedImageAnalysisIdentity())!.assignedAt).toBe(stored1!.assignedAt);

    // A different one: replaced, and the two analyzed rows are what it invalidates.
    const moved = { ...BASE, baseUrl: 'http://moved/v1' };
    const second = { ...moved, identityHash: computeIdentityHash(moved) };
    expect(await reanalysisScopeFor(second.identityHash)).toEqual({ changed: true, reanalyzeRows: 2 });
    const r3 = await retainImageAnalysisIdentity(second);
    expect(r3).toMatchObject({ changed: true, reanalyzeRows: 2 });
    expect((await getRetainedImageAnalysisIdentity())!.identityHash).toBe(second.identityHash);
    // The rows themselves are untouched here — the next sweep re-pends them (D13).
    const rows = await query<{ status: string }>(`SELECT status FROM page_image_analyses WHERE page_id = $1`, [pageId]);
    expect(rows.rows.map((r) => r.status)).toEqual(['analyzed', 'analyzed']);
  });

  it('a row that does not parse reads as unset rather than as an identity', async () => {
    await query(`INSERT INTO admin_settings (setting_key, setting_value) VALUES ($1, 'not json')`, [IMAGE_ANALYSIS_IDENTITY_KEY]);
    expect(await getRetainedImageAnalysisIdentity()).toBeNull();
    await query(`UPDATE admin_settings SET setting_value = '{"providerId":"x"}' WHERE setting_key = $1`, [IMAGE_ANALYSIS_IDENTITY_KEY]);
    expect(await getRetainedImageAnalysisIdentity()).toBeNull();
  });
});

describe.skipIf(!dbAvailable)('resolution — the live assignment and a candidate pair', () => {
  it('resolveImageAnalysisIdentity is null when unassigned, and the hashed live triple when assigned', async () => {
    expect(await resolveImageAnalysisIdentity()).toBeNull();
    const id = await seedProvider('vision', 'http://vision/v1', 'qwen3-vl');
    await query(
      `INSERT INTO llm_usecase_assignments (usecase, provider_id, model) VALUES ('image_analysis', $1, NULL)
       ON CONFLICT (usecase) DO UPDATE SET provider_id = EXCLUDED.provider_id, model = EXCLUDED.model`,
      [id],
    );
    await bumpProviderCacheVersion();
    const live = await resolveImageAnalysisIdentity();
    expect(live).toEqual({
      providerId: id,
      model: 'qwen3-vl',
      baseUrl: 'http://vision/v1',
      identityHash: computeIdentityHash({ providerId: id, model: 'qwen3-vl', baseUrl: 'http://vision/v1' }),
    });
  });

  it('a candidate resolves by the PUT rule: assignment model, else the provider default, else no_model; unknown provider is no_provider', async () => {
    const withDefault = await seedProvider('vd', 'http://a/v1', 'default-vl');
    const withoutDefault = await seedProvider('vn', 'http://b/v1', null);

    expect((await resolveCandidateImageAnalysisIdentity({ providerId: withDefault })).model).toBe('default-vl');
    expect((await resolveCandidateImageAnalysisIdentity({ providerId: withDefault, model: 'pinned' })).model).toBe('pinned');
    expect((await resolveCandidateImageAnalysisIdentity({ providerId: withoutDefault, model: 'pinned' })).baseUrl).toBe('http://b/v1');

    await expect(resolveCandidateImageAnalysisIdentity({ providerId: withoutDefault })).rejects.toMatchObject({ reason: 'no_model' });
    await expect(resolveCandidateImageAnalysisIdentity({ providerId: '00000000-0000-4000-8000-0000000000ff' })).rejects.toBeInstanceOf(ImageAnalysisResolutionError);
    await expect(resolveCandidateImageAnalysisIdentity({ providerId: '00000000-0000-4000-8000-0000000000ff' })).rejects.toMatchObject({ reason: 'no_provider' });
  });

  it('only a missing row is no_provider: a database error while loading the provider propagates as itself', async () => {
    // A malformed uuid makes Postgres itself fail the lookup — a real DB
    // error, not "no such provider" — and the route turns an unclassified
    // throw into a 500 rather than telling the operator the provider is gone.
    const attempt = resolveCandidateImageAnalysisIdentity({ providerId: 'not-a-uuid' });
    await expect(attempt).rejects.not.toBeInstanceOf(ImageAnalysisResolutionError);
    await expect(attempt).rejects.toThrow(/invalid input syntax for type uuid/);
  });
});
