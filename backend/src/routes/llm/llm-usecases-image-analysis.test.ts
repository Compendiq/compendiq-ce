import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// Same DNS short-circuit the sibling route tests use: the SSRF guard would
// otherwise resolve the fake hostnames against a public resolver.
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => {
    const err = new Error('getaddrinfo ENOTFOUND (mocked)') as NodeJS.ErrnoException;
    err.code = 'ENOTFOUND';
    throw err;
  }),
}));

import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';
import { buildApp } from '../../app.js';
import { generateAccessToken } from '../../core/plugins/auth.js';
import { bumpProviderCacheVersion } from '../../domains/llm/services/cache-bus.js';
import { PROBE_BANDS } from '../../domains/llm/services/vision-probe.js';
import {
  computeIdentityHash,
  IMAGE_ANALYSIS_IDENTITY_KEY,
  IMAGE_ANALYSIS_PROMPT_VERSION,
} from '../../domains/llm/services/image-analysis-identity.js';
import { IMAGE_ANALYSIS_SCHEMA_VERSION, type ImageAnalysisIdentity } from '@compendiq/contracts';

/**
 * #1615 (ADR-027 D3/D7) — assigning `image_analysis` is gated on a BLOCKING
 * vision probe, and the retained identity has exactly two writers.
 *
 * The fake endpoints are real local HTTP servers answering the chat
 * completion the probe sends (the boundary is "does this endpoint read an
 * image", so it is mocked at the wire, never at the service layer):
 *  - `vision`  names the three bands → `true`
 *  - `textOnly` answers 415 → `false` (the probe's unconditional refusal status)
 *  - `sick`    answers 503 → `null` (unconfirmed)
 *  - a closed port → `null` (unconfirmed)
 * Each counts its hits, which is how "the scope preview never probes" and
 * "saving the ceiling fires no probe" are proven rather than assumed.
 */

const dbAvailable = await isDbAvailable();

let app: FastifyInstance;
let adminToken: string;
let userToken: string;

let vision: Server;
let visionUrl: string;
let visionHits = 0;
let vision2: Server;
let vision2Url: string;
let textOnly: Server;
let textOnlyUrl: string;
let sick: Server;
let sickUrl: string;
/** A port nothing listens on. */
const DEAD_URL = 'http://127.0.0.1:1/v1';

function visionServer(onHit: () => void): Server {
  return createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      onHit();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: `The bands are ${PROBE_BANDS.join(', ')}.` }, finish_reason: 'stop' }],
      }));
    });
  });
}

function statusServer(status: number, body: unknown): Server {
  return createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
}

const listen = (s: Server) => new Promise<string>((r) =>
  s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}/v1`)),
);

beforeAll(async () => {
  if (!dbAvailable) return;
  vision = visionServer(() => { visionHits++; });
  vision2 = visionServer(() => {});
  textOnly = statusServer(415, { error: 'Unsupported media type: image content parts are not accepted (tenant-7 @ 10.0.0.4)' });
  sick = statusServer(503, { error: 'the model is still loading' });
  [visionUrl, vision2Url, textOnlyUrl, sickUrl] = await Promise.all([listen(vision), listen(vision2), listen(textOnly), listen(sick)]);

  await setupTestDb();
  app = await buildApp();
  await app.ready();
}, 30_000);

afterAll(async () => {
  if (!dbAvailable) return;
  await app?.close();
  await teardownTestDb();
  await Promise.all([vision, vision2, textOnly, sick].map((s) => new Promise<void>((r) => s.close(() => r()))));
});

beforeEach(async () => {
  if (!dbAvailable) return;
  visionHits = 0;
  await truncateAllTables();
  await bumpProviderCacheVersion();
  // The admin rate limit is a per-file budget under `app.inject` (see the
  // image-embedding suite for why); a test-environment fact, not a production one.
  await query(
    `INSERT INTO admin_settings (setting_key, setting_value) VALUES ('rate_limit_admin_max', '10000')
     ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value`,
  );
  const admin = await query<{ id: string }>(
    `INSERT INTO users (username, password_hash, role) VALUES ('ia_admin','h','admin') RETURNING id`,
  );
  await query('INSERT INTO user_settings (user_id) VALUES ($1)', [admin.rows[0]!.id]);
  adminToken = await generateAccessToken({ sub: admin.rows[0]!.id, username: 'ia_admin', role: 'admin' });
  const user = await query<{ id: string }>(
    `INSERT INTO users (username, password_hash, role) VALUES ('ia_user','h','user') RETURNING id`,
  );
  await query('INSERT INTO user_settings (user_id) VALUES ($1)', [user.rows[0]!.id]);
  userToken = await generateAccessToken({ sub: user.rows[0]!.id, username: 'ia_user', role: 'user' });
});

async function seedProvider(name: string, baseUrl: string, model: string | null, isDefault = false): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO llm_providers (name, base_url, auth_type, verify_ssl, is_default, default_model)
     VALUES ($1, $2, 'none', true, $3, $4) RETURNING id`,
    [name, baseUrl, isDefault, model],
  );
  await bumpProviderCacheVersion();
  return r.rows[0]!.id;
}

async function seedPage(): Promise<number> {
  const r = await query<{ id: number }>(
    `INSERT INTO pages (title, source, visibility, body_html) VALUES ('p', 'standalone', 'shared', '<p>x</p>') RETURNING id`,
  );
  return r.rows[0]!.id;
}

async function seedAnalyzed(pageId: number, key: string, identityHash: string): Promise<void> {
  await query(
    `INSERT INTO page_image_analyses
       (page_id, source, attachment_key, content_hash, format, status, identity_hash, prompt_version, schema_version, payload, analyzed_at)
     VALUES ($1, 'local', $2, $3, 'png', 'analyzed', $4, $5, $6, '{"schemaVersion":1}'::jsonb, NOW())`,
    [pageId, key, `h-${key}`, identityHash, IMAGE_ANALYSIS_PROMPT_VERSION, IMAGE_ANALYSIS_SCHEMA_VERSION],
  );
}

const put = (payload: Record<string, unknown>, token = adminToken) => app.inject({
  method: 'PUT', url: '/api/admin/llm-usecases',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  payload: JSON.stringify(payload),
});
const get = (url: string, token = adminToken) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
const post = (url: string, token = adminToken) => app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}` } });

async function assignmentRow(): Promise<{ provider_id: string | null; model: string | null } | undefined> {
  const r = await query<{ provider_id: string | null; model: string | null }>(
    `SELECT provider_id, model FROM llm_usecase_assignments WHERE usecase = 'image_analysis'`,
  );
  return r.rows[0];
}

async function retainedRaw(): Promise<string | null> {
  const r = await query<{ setting_value: string }>(
    `SELECT setting_value FROM admin_settings WHERE setting_key = $1`, [IMAGE_ANALYSIS_IDENTITY_KEY],
  );
  return r.rows[0]?.setting_value ?? null;
}

async function retained(): Promise<ImageAnalysisIdentity | null> {
  const raw = await retainedRaw();
  return raw ? (JSON.parse(raw) as ImageAnalysisIdentity) : null;
}

describe.skipIf(!dbAvailable)('PUT /api/admin/llm-usecases — image_analysis is probe-gated (ADR-027 D3)', () => {
  it('assigns on a true probe, pins the RESOLVED model, retains the identity and answers reanalyzeRows: 0', async () => {
    const id = await seedProvider('visionbox', visionUrl, 'qwen3-vl');
    const res = await put({ image_analysis: { providerId: id } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, reanalyzeRows: 0 });
    expect(visionHits).toBe(1);

    // The row names the pair the probe verified — the provider default cannot repoint it.
    expect(await assignmentRow()).toEqual({ provider_id: id, model: 'qwen3-vl' });
    const identity = await retained();
    expect(identity).toMatchObject({
      providerId: id, model: 'qwen3-vl', baseUrl: visionUrl,
      identityHash: computeIdentityHash({ providerId: id, model: 'qwen3-vl', baseUrl: visionUrl }),
    });
    expect(new Date(identity!.assignedAt).getTime()).not.toBeNaN();

    const verdict = await query<{ vision: boolean }>(
      `SELECT vision FROM llm_model_capabilities WHERE provider_id = $1 AND model = 'qwen3-vl'`, [id],
    );
    expect(verdict.rows[0]!.vision).toBe(true);
  });

  it('re-saving the same pair is a resume: reanalyzeRows 0 and assignedAt unchanged', async () => {
    const id = await seedProvider('visionbox', visionUrl, 'qwen3-vl');
    expect((await put({ image_analysis: { providerId: id } })).statusCode).toBe(200);
    const before = await retained();
    const pageId = await seedPage();
    await seedAnalyzed(pageId, 'a.png', before!.identityHash);

    const res = await put({ image_analysis: { providerId: id, model: 'qwen3-vl' } });
    expect(res.json()).toEqual({ ok: true, reanalyzeRows: 0 });
    expect(await retained()).toEqual(before);
  });

  it('a different pair replaces the identity and reports the analyzed rows it invalidated', async () => {
    const a = await seedProvider('a', visionUrl, 'qwen3-vl');
    expect((await put({ image_analysis: { providerId: a } })).statusCode).toBe(200);
    const first = (await retained())!;
    const pageId = await seedPage();
    await seedAnalyzed(pageId, '1.png', first.identityHash);
    await seedAnalyzed(pageId, '2.png', first.identityHash);
    await seedAnalyzed(pageId, '3.png', 'some-other-hash-already-invalid');
    const b = await seedProvider('b', vision2Url, 'qwen3-vl-8b');
    // `model: null` clears the pinned model so the new provider's default
    // resolves; a bare `{ providerId }` would carry the pinned one over, which
    // is exactly what the grid shows and the tri-state contract means.
    const res = await put({ image_analysis: { providerId: b, model: null } });
    expect(res.statusCode).toBe(200);
    // All three fail the predicate under the new identity — including the one
    // that was already stale; the count is "rows the sweep will re-pend".
    expect(res.json()).toEqual({ ok: true, reanalyzeRows: 3 });
    expect((await retained())!.identityHash).toBe(computeIdentityHash({ providerId: b, model: 'qwen3-vl-8b', baseUrl: vision2Url }));
    // The rows are untouched here: re-pending them is the next batch's sweep (D13).
    const statuses = await query<{ status: string }>(`SELECT status FROM page_image_analyses`);
    expect(statuses.rows.every((r) => r.status === 'analyzed')).toBe(true);
  });

  describe('the four refusals leave the previous assignment and the retained identity byte-identical', () => {
    let liveId: string;
    let liveRow: Awaited<ReturnType<typeof assignmentRow>>;
    let liveIdentity: string | null;

    beforeEach(async () => {
      liveId = await seedProvider('live', visionUrl, 'qwen3-vl');
      expect((await put({ image_analysis: { providerId: liveId } })).statusCode).toBe(200);
      liveRow = await assignmentRow();
      liveIdentity = await retainedRaw();
      visionHits = 0;
    });

    async function expectUntouched() {
      expect(await assignmentRow()).toEqual(liveRow);
      expect(await retainedRaw()).toBe(liveIdentity);
    }

    it('no_provider — a providerId no provider row carries', async () => {
      const res = await put({ image_analysis: { providerId: '00000000-0000-4000-8000-0000000000ff' } });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ reason: 'no_provider', statusCode: 422 });
      expect(visionHits).toBe(0);
      await expectUntouched();
    });

    it('no_model — no assignment model and no provider default', async () => {
      const id = await seedProvider('nomodel', visionUrl, null);
      const res = await put({ image_analysis: { providerId: id, model: null } });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ reason: 'no_model' });
      expect(visionHits).toBe(0);
      await expectUntouched();
    });

    it('text_only — the model refused the test image; the category, never the provider body', async () => {
      const id = await seedProvider('textbox', textOnlyUrl, 'llama-text');
      const res = await put({ image_analysis: { providerId: id } });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({
        reason: 'text_only',
        error: expect.not.stringContaining('10.0.0.4'),
      });
      expect(res.json()).toMatchObject({ error: expect.not.stringContaining('tenant-7') });
      await expectUntouched();
      // The refused pair's verdict is stored as `false` — for that pair, not the live one.
      const verdicts = await query<{ provider_id: string; vision: boolean | null }>(
        `SELECT provider_id, vision FROM llm_model_capabilities ORDER BY probed_at`,
      );
      expect(verdicts.rows).toEqual([
        { provider_id: liveId, vision: true },
        { provider_id: id, vision: false },
      ]);
    });

    it('unconfirmed — a 503 is not a text-only verdict', async () => {
      const id = await seedProvider('sickbox', sickUrl, 'qwen3-vl');
      const res = await put({ image_analysis: { providerId: id } });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ reason: 'unconfirmed', error: expect.stringMatching(/not a verdict/i) });
      await expectUntouched();
    });

    it('unconfirmed — an unreachable endpoint', async () => {
      const id = await seedProvider('deadbox', DEAD_URL, 'qwen3-vl');
      const res = await put({ image_analysis: { providerId: id } });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ reason: 'unconfirmed' });
      await expectUntouched();
    });
  });

  it('clearing the assignment writes the NULL row, probes nothing and keeps the retained identity (pause, not purge)', async () => {
    const id = await seedProvider('visionbox', visionUrl, 'qwen3-vl');
    expect((await put({ image_analysis: { providerId: id } })).statusCode).toBe(200);
    const before = await retainedRaw();
    visionHits = 0;

    const res = await put({ image_analysis: { providerId: null, model: null } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(visionHits).toBe(0);
    expect(await assignmentRow()).toEqual({ provider_id: null, model: null });
    expect(await retainedRaw()).toBe(before);
  });

  it('a save that touches only other use cases neither probes nor discloses', async () => {
    const id = await seedProvider('def', textOnlyUrl, 'llama-text', true);
    const res = await put({ summary: { providerId: id, model: 'x' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(await retainedRaw()).toBeNull();
  });
});

describe.skipIf(!dbAvailable)('GET /api/admin/llm-usecases/image_analysis/capability', () => {
  it('404s when unassigned, and never inherits the default provider', async () => {
    await seedProvider('def', visionUrl, 'qwen3-vl', true);
    const res = await get('/api/admin/llm-usecases/image_analysis/capability');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: expect.stringMatching(/no provider is assigned to image analysis/i) });
  });

  it('answers the stored verdict plus the retained identity, and nulls when the verdict row is gone', async () => {
    const id = await seedProvider('visionbox', visionUrl, 'qwen3-vl');
    expect((await put({ image_analysis: { providerId: id } })).statusCode).toBe(200);

    const res = await get('/api/admin/llm-usecases/image_analysis/capability');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      providerId: id, model: 'qwen3-vl', vision: true, probeError: null, identityDrift: false,
      identity: { providerId: id, model: 'qwen3-vl', baseUrl: visionUrl },
    });
    expect(res.json()).not.toHaveProperty('reanalyzeRows');

    // A provider edit drops its verdicts (`invalidateProviderCapabilities`);
    // the pair is then "assigned, never probed" and Re-check is the remedy.
    await query(`DELETE FROM llm_model_capabilities WHERE provider_id = $1`, [id]);
    const again = await get('/api/admin/llm-usecases/image_analysis/capability');
    expect(again.json()).toMatchObject({ vision: null, probedAt: null, probeError: null });
  });

  it('names identity drift after a provider base_url edit — the one dimension no PUT touches', async () => {
    const id = await seedProvider('visionbox', visionUrl, 'qwen3-vl');
    expect((await put({ image_analysis: { providerId: id } })).statusCode).toBe(200);
    await query(`UPDATE llm_providers SET base_url = $2 WHERE id = $1`, [id, vision2Url]);
    await bumpProviderCacheVersion();

    const res = await get('/api/admin/llm-usecases/image_analysis/capability');
    expect(res.json()).toMatchObject({ identityDrift: true, identity: { baseUrl: visionUrl } });
  });

  it('carries the probe error to an admin and to nobody else', async () => {
    const id = await seedProvider('textbox', textOnlyUrl, 'llama-text');
    await query(
      `INSERT INTO llm_usecase_assignments (usecase, provider_id, model) VALUES ('image_analysis', $1, 'llama-text')
       ON CONFLICT (usecase) DO UPDATE SET provider_id = EXCLUDED.provider_id, model = EXCLUDED.model`,
      [id],
    );
    await post('/api/admin/llm-usecases/image_analysis/recheck');
    const admin = await get('/api/admin/llm-usecases/image_analysis/capability');
    expect(admin.json()).toMatchObject({ probeError: expect.stringContaining('tenant-7') });

    const user = await get('/api/admin/llm-usecases/image_analysis/capability', userToken);
    expect(user.statusCode).toBe(403);
    const pub = await get('/api/llm/usecase-default?usecase=image_analysis', userToken);
    expect(pub.statusCode).toBe(200);
    expect(pub.json()).not.toHaveProperty('probeError');
    expect(pub.json()).not.toHaveProperty('identity');
  });
});

describe.skipIf(!dbAvailable)('POST /api/admin/llm-usecases/image_analysis/recheck (D7\'s second writer)', () => {
  it('a false or null verdict touches neither the assignment nor the retained identity', async () => {
    const id = await seedProvider('visionbox', visionUrl, 'qwen3-vl');
    expect((await put({ image_analysis: { providerId: id } })).statusCode).toBe(200);
    const identityBefore = await retainedRaw();

    // The server behind the assigned provider is swapped for a text model…
    await query(`UPDATE llm_providers SET base_url = $2 WHERE id = $1`, [id, textOnlyUrl]);
    await bumpProviderCacheVersion();
    const refused = await post('/api/admin/llm-usecases/image_analysis/recheck');
    expect(refused.statusCode).toBe(200);
    expect(refused.json()).toMatchObject({ vision: false, identityDrift: true });
    expect(refused.json()).not.toHaveProperty('reanalyzeRows');
    expect(await retainedRaw()).toBe(identityBefore);
    expect(await assignmentRow()).toEqual({ provider_id: id, model: 'qwen3-vl' });

    // …and then goes down.
    await query(`UPDATE llm_providers SET base_url = $2 WHERE id = $1`, [id, DEAD_URL]);
    await bumpProviderCacheVersion();
    const unconfirmed = await post('/api/admin/llm-usecases/image_analysis/recheck');
    expect(unconfirmed.json()).toMatchObject({ vision: null, identityDrift: true });
    expect(await retainedRaw()).toBe(identityBefore);
  });

  it('a true verdict on a drifted identity adopts it and reports the rows that adoption invalidated', async () => {
    const id = await seedProvider('visionbox', visionUrl, 'qwen3-vl');
    expect((await put({ image_analysis: { providerId: id } })).statusCode).toBe(200);
    const first = (await retained())!;
    const pageId = await seedPage();
    await seedAnalyzed(pageId, 'a.png', first.identityHash);
    await seedAnalyzed(pageId, 'b.png', first.identityHash);

    await query(`UPDATE llm_providers SET base_url = $2 WHERE id = $1`, [id, vision2Url]);
    await bumpProviderCacheVersion();
    const movedHash = computeIdentityHash({ providerId: id, model: 'qwen3-vl', baseUrl: vision2Url });

    // The scope preview discloses the same count first, without probing or writing.
    const visionHitsBefore = visionHits;
    const scope = await get(`/api/admin/llm-usecases/image_analysis/reanalysis-scope?providerId=${id}`);
    expect(scope.json()).toEqual({ identityHash: movedHash, changed: true, reanalyzeRows: 2 });
    expect(visionHits).toBe(visionHitsBefore);
    expect((await retained())!.identityHash).toBe(first.identityHash);

    const res = await post('/api/admin/llm-usecases/image_analysis/recheck');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ vision: true, identityDrift: false, reanalyzeRows: 2, identity: { baseUrl: vision2Url, identityHash: movedHash } });
    expect((await retained())!.identityHash).toBe(movedHash);

    // A second true re-check is a resume: no disclosure.
    const again = await post('/api/admin/llm-usecases/image_analysis/recheck');
    expect(again.json()).not.toHaveProperty('reanalyzeRows');
  });

  it('404s when unassigned', async () => {
    expect((await post('/api/admin/llm-usecases/image_analysis/recheck')).statusCode).toBe(404);
  });
});

describe.skipIf(!dbAvailable)('GET /api/admin/llm-usecases/image_analysis/reanalysis-scope', () => {
  it('answers changed: true, 0 rows with no identity retained, and resolves the pair by the PUT rule', async () => {
    const id = await seedProvider('visionbox', visionUrl, 'qwen3-vl');
    const res = await get(`/api/admin/llm-usecases/image_analysis/reanalysis-scope?providerId=${id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      identityHash: computeIdentityHash({ providerId: id, model: 'qwen3-vl', baseUrl: visionUrl }),
      changed: true,
      reanalyzeRows: 0,
    });
    const pinned = await get(`/api/admin/llm-usecases/image_analysis/reanalysis-scope?providerId=${id}&model=other`);
    expect(pinned.json()).toMatchObject({ identityHash: computeIdentityHash({ providerId: id, model: 'other', baseUrl: visionUrl }) });
    expect(visionHits).toBe(0);
    expect(await retainedRaw()).toBeNull();
  });

  it('equals the PUT\'s later count, and answers changed: false for the retained pair', async () => {
    const a = await seedProvider('a', visionUrl, 'qwen3-vl');
    expect((await put({ image_analysis: { providerId: a } })).statusCode).toBe(200);
    const pageId = await seedPage();
    await seedAnalyzed(pageId, '1.png', (await retained())!.identityHash);
    const b = await seedProvider('b', vision2Url, 'qwen3-vl-8b');

    const same = await get(`/api/admin/llm-usecases/image_analysis/reanalysis-scope?providerId=${a}`);
    expect(same.json()).toMatchObject({ changed: false, reanalyzeRows: 0 });
    const other = await get(`/api/admin/llm-usecases/image_analysis/reanalysis-scope?providerId=${b}`);
    expect(other.json()).toMatchObject({ changed: true, reanalyzeRows: 1 });

    const res = await put({ image_analysis: { providerId: b } });
    expect(res.json()).toEqual({ ok: true, reanalyzeRows: 1 });
  });

  it('refuses with the PUT\'s resolution reasons, never the probe\'s, and 400s an unparseable query', async () => {
    const nomodel = await seedProvider('nomodel', visionUrl, null);
    expect((await get('/api/admin/llm-usecases/image_analysis/reanalysis-scope?providerId=00000000-0000-4000-8000-0000000000ff')).json())
      .toMatchObject({ reason: 'no_provider', statusCode: 422 });
    expect((await get(`/api/admin/llm-usecases/image_analysis/reanalysis-scope?providerId=${nomodel}`)).json())
      .toMatchObject({ reason: 'no_model', statusCode: 422 });
    // A text-only provider is not the preview's business: nothing is probed.
    const text = await seedProvider('textbox', textOnlyUrl, 'llama-text');
    expect((await get(`/api/admin/llm-usecases/image_analysis/reanalysis-scope?providerId=${text}`)).statusCode).toBe(200);
    expect((await get('/api/admin/llm-usecases/image_analysis/reanalysis-scope?providerId=nope')).statusCode).toBe(400);
    expect((await get('/api/admin/llm-usecases/image_analysis/reanalysis-scope')).statusCode).toBe(400);
  });
});

describe.skipIf(!dbAvailable)('admin gating and the settings ceiling', () => {
  it.each([
    ['GET', '/api/admin/llm-usecases/image_analysis/capability'],
    ['POST', '/api/admin/llm-usecases/image_analysis/recheck'],
    ['GET', '/api/admin/llm-usecases/image_analysis/reanalysis-scope?providerId=00000000-0000-4000-8000-000000000001'],
  ])('%s %s is requireAdmin', async (method, url) => {
    const r = await app.inject({ method: method as 'GET' | 'POST', url, headers: { authorization: `Bearer ${userToken}` } });
    expect(r.statusCode).toBe(403);
  });

  it('saving Max output tokens fires no probe and touches neither the assignment nor the identity', async () => {
    const id = await seedProvider('visionbox', visionUrl, 'qwen3-vl');
    expect((await put({ image_analysis: { providerId: id } })).statusCode).toBe(200);
    const identityBefore = await retainedRaw();
    visionHits = 0;

    const res = await app.inject({
      method: 'PUT', url: '/api/admin/settings',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ imageAnalysisMaxOutputTokens: 6000 }),
    });
    expect(res.statusCode).toBe(200);
    const stored = await query<{ setting_value: string }>(
      `SELECT setting_value FROM admin_settings WHERE setting_key = 'image_analysis_max_output_tokens'`,
    );
    expect(stored.rows[0]!.setting_value).toBe('6000');
    expect(visionHits).toBe(0);
    expect(await retainedRaw()).toBe(identityBefore);
    expect(await assignmentRow()).toEqual({ provider_id: id, model: 'qwen3-vl' });
  });

  it('migration 115 seeded the NULL assignment row and the default ceiling', async () => {
    // `truncateAllTables` empties both tables, so read the migration's effect
    // through the reader and the GET, which answer the same defaults.
    const r = await get('/api/admin/llm-usecases');
    expect(r.json()).toMatchObject({ image_analysis: { providerId: null, model: null } });
    const s = await get('/api/admin/settings');
    expect(s.json()).toMatchObject({ imageAnalysisMaxOutputTokens: 8192 });
  });
});
