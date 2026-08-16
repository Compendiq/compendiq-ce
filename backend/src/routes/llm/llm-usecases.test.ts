import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

// Short-circuit DNS lookups performed by the SSRF guard — the tests POST
// providers with URLs like `http://a` / `http://b` which would otherwise
// trigger real DNS resolution that hangs for ~25s per call against public
// resolvers. The guard swallows DNS errors silently, so a fake ENOTFOUND is
// safe here. Mirrors the pattern in llm-providers.test.ts.
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => {
    const err = new Error('getaddrinfo ENOTFOUND (mocked)') as NodeJS.ErrnoException;
    err.code = 'ENOTFOUND';
    throw err;
  }),
}));

// #1154 — Mock model-capabilities to prevent real LLM probes during tests.
// GET /llm/usecase-default calls getVisionCapability (which schedules background
// refreshes, never blocking). PUT /admin/llm-usecases fires a fire-and-forget
// refreshVisionCapability after save. Both are mocked here to keep tests fast
// and deterministic, avoiding real undici fetches to the test's fake provider
// URLs (`http://a/v1`, `http://b/v1`).
const mockGetVisionCapability = vi.fn().mockResolvedValue(null);
const mockRefreshVisionCapability = vi.fn().mockResolvedValue({
  vision: null,
  probedAt: '2026-08-01T00:00:00.000Z',
  probeError: null,
});
const mockReadVisionCapabilityDetail = vi.fn().mockResolvedValue(null);
vi.mock('../../domains/llm/services/model-capabilities.js', () => ({
  getVisionCapability: (...args: unknown[]) => mockGetVisionCapability(...args),
  refreshVisionCapability: (...args: unknown[]) => mockRefreshVisionCapability(...args),
  readVisionCapabilityDetail: (...args: unknown[]) => mockReadVisionCapabilityDetail(...args),
  invalidateProviderCapabilities: vi.fn(),
}));

import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';
import { buildApp } from '../../app.js';
import { generateAccessToken } from '../../core/plugins/auth.js';
import { logger } from '../../core/utils/logger.js';
import { invalidateRagConfidenceThresholdCache } from '../../core/services/admin-settings-service.js';
import { UsecaseDefaultSchema } from '@compendiq/contracts';

// Local helper — mirrors llm-providers.test.ts.
async function createAdminAndLogin(): Promise<{ token: string; userId: string }> {
  const result = await query<{ id: string }>(
    `INSERT INTO users (username, password_hash, role)
     VALUES ('llm_usecase_admin', 'fakehash', 'admin') RETURNING id`,
  );
  const userId = result.rows[0]!.id;
  await query('INSERT INTO user_settings (user_id) VALUES ($1)', [userId]);
  const token = await generateAccessToken({
    sub: userId,
    username: 'llm_usecase_admin',
    role: 'admin',
  });
  return { token, userId };
}

const dbAvailable = await isDbAvailable();

let app: FastifyInstance;
let adminToken: string;

beforeAll(async () => {
  if (!dbAvailable) return;
  await setupTestDb();
  app = await buildApp();
  await app.ready();
}, 30_000);

afterAll(async () => {
  if (!dbAvailable) return;
  await app?.close();
  await teardownTestDb();
});

beforeEach(async () => {
  if (!dbAvailable) return;
  await truncateAllTables();
  ({ token: adminToken } = await createAdminAndLogin());
});

describe.skipIf(!dbAvailable)('GET /api/admin/llm-usecases', () => {
  it('returns all 6 rows with resolved blocks (#1104 adds rerank)', async () => {
    const p = await app.inject({
      method: 'POST', url: '/api/admin/llm-providers',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'A', baseUrl: 'http://a/v1', authType: 'none', verifySsl: true, defaultModel: 'mA' }),
    });
    const { id } = p.json();
    await app.inject({
      method: 'POST', url: `/api/admin/llm-providers/${id}/set-default`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const r = await app.inject({
      method: 'GET', url: '/api/admin/llm-usecases',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(Object.keys(body).sort()).toEqual(['auto_tag', 'chat', 'embedding', 'quality', 'rerank', 'summary']);
    expect(body.chat.resolved).toMatchObject({ providerId: id, model: 'mA' });
    // Rerank must NOT inherit the default provider: unassigned renders the
    // empty sentinel — the stage is disabled, not defaulted (#1104).
    expect(body.rerank.resolved).toMatchObject({
      providerId: '00000000-0000-0000-0000-000000000000',
      providerName: '',
      model: '',
    });
  });

  it('PUT assigns rerank and GET resolves it without a default-provider fallback (#1104)', async () => {
    const p = await app.inject({
      method: 'POST', url: '/api/admin/llm-providers',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Rerank box', baseUrl: 'http://rr/v1', authType: 'none', verifySsl: true, defaultModel: 'bge-reranker-v2-m3' }),
    });
    const { id } = p.json();
    const put = await app.inject({
      method: 'PUT', url: '/api/admin/llm-usecases',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ rerank: { providerId: id } }),
    });
    expect(put.statusCode).toBe(200);
    const r = await app.inject({
      method: 'GET', url: '/api/admin/llm-usecases',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(r.json().rerank.resolved).toMatchObject({ providerId: id, model: 'bge-reranker-v2-m3' });
  });

  it('PUT upserts a use-case assignment and takes effect on next GET', async () => {
    const a = await app.inject({
      method: 'POST', url: '/api/admin/llm-providers',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'A', baseUrl: 'http://a/v1', authType: 'none', verifySsl: true, defaultModel: 'mA' }),
    });
    const b = await app.inject({
      method: 'POST', url: '/api/admin/llm-providers',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'B', baseUrl: 'http://b/v1', authType: 'none', verifySsl: true, defaultModel: 'mB' }),
    });
    await app.inject({
      method: 'POST', url: `/api/admin/llm-providers/${a.json().id}/set-default`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const put = await app.inject({
      method: 'PUT', url: '/api/admin/llm-usecases',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ summary: { providerId: b.json().id, model: 'gpt-4o-mini' } }),
    });
    expect(put.statusCode).toBe(200);
    const get = await app.inject({
      method: 'GET', url: '/api/admin/llm-usecases',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const body = get.json();
    expect(body.summary).toMatchObject({
      providerId: b.json().id,
      model: 'gpt-4o-mini',
      resolved: { providerId: b.json().id, providerName: 'B', model: 'gpt-4o-mini' },
    });
  });

  /**
   * #1154: the post-save probe is a real outbound chat completion. Only the
   * `chat` assignment ever resolves to a model that will be shown an image, so
   * saving anything else must not fire one.
   */
  it('fires the post-save vision probe only when the save touched chat', async () => {
    const a = await app.inject({
      method: 'POST', url: '/api/admin/llm-providers',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'A', baseUrl: 'http://a/v1', authType: 'none', verifySsl: true, defaultModel: 'mA' }),
    });
    const providerId: string = a.json().id;
    await app.inject({
      method: 'POST', url: `/api/admin/llm-providers/${providerId}/set-default`,
      headers: { authorization: `Bearer ${adminToken}` },
    });

    const put = (payload: Record<string, unknown>) => app.inject({
      method: 'PUT', url: '/api/admin/llm-usecases',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: JSON.stringify(payload),
    });

    mockRefreshVisionCapability.mockClear();

    expect((await put({ summary: { providerId, model: 'mA' } })).statusCode).toBe(200);
    expect((await put({ embedding: { providerId, model: 'bge-m3' } })).statusCode).toBe(200);
    expect(mockRefreshVisionCapability).not.toHaveBeenCalled();

    expect((await put({ chat: { providerId, model: 'qwen2.5vl' } })).statusCode).toBe(200);
    // Fire-and-forget, so poll rather than sleep — vi.waitFor only fails when
    // the call genuinely never happens, not when the runner is slow.
    await vi.waitFor(() => expect(mockRefreshVisionCapability).toHaveBeenCalledTimes(1));
    expect(mockRefreshVisionCapability).toHaveBeenCalledWith(providerId, 'qwen2.5vl');
  });
});

/**
 * #1114 — re-pointing an embedding or rerank assignment moves the scale the
 * matching confidence threshold sits on. The shadow swap is the loud path;
 * THIS is the quiet one — a plain assignment change, no migration, no
 * runbook. Warn, don't mutate: the operator hears about it and the threshold
 * is left exactly as they set it.
 */
describe.skipIf(!dbAvailable)('an assignment change warns about a live confidence threshold (#1114)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation((() => logger) as never);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    invalidateRagConfidenceThresholdCache();
  });

  function calibrationWarnings(): Array<Record<string, unknown>> {
    return warnSpy.mock.calls
      .map((call) => call[0])
      .filter(
        (fields): fields is Record<string, unknown> =>
          typeof fields === 'object' && fields !== null && 'settingKey' in fields,
      );
  }

  async function setThreshold(key: string, value: string): Promise<void> {
    await query(
      `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (setting_key) DO UPDATE SET setting_value = $2, updated_at = NOW()`,
      [key, value],
    );
    invalidateRagConfidenceThresholdCache();
  }

  /**
   * Seeded with SQL, not through `POST /admin/llm-providers`: every admin
   * route shares one per-minute budget (`ADMIN_LIMIT` → `getRateLimits()`),
   * and this file already spends most of it. The subject here is
   * `PUT /admin/llm-usecases`, so that is the only admin request each test
   * makes — the setup has no reason to compete with it for the quota.
   */
  async function seedProvider(name: string, model: string): Promise<string> {
    const res = await query<{ id: string }>(
      `INSERT INTO llm_providers (name, base_url, auth_type, verify_ssl, is_default, default_model)
       VALUES ($1, $2, 'none', true, false, $3) RETURNING id`,
      [name, `http://${name}/v1`, model],
    );
    return res.rows[0]!.id;
  }

  async function seedAssignment(usecase: string, providerId: string | null, model: string | null): Promise<void> {
    await query(
      `INSERT INTO llm_usecase_assignments (usecase, provider_id, model, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (usecase) DO UPDATE SET provider_id = $2, model = $3, updated_at = NOW()`,
      [usecase, providerId, model],
    );
  }

  const put = (payload: Record<string, unknown>) => app.inject({
    method: 'PUT', url: '/api/admin/llm-usecases',
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });

  it('warns when the embedding model moves under a live similarity threshold', async () => {
    const providerId = await seedProvider('emb', 'bge-m3');
    await seedAssignment('embedding', providerId, 'bge-m3');
    await setThreshold('rag_confidence_threshold', '0.35');
    warnSpy.mockClear();

    expect((await put({ embedding: { providerId, model: 'Qwen3-Embedding-4B' } })).statusCode).toBe(200);

    expect(calibrationWarnings()).toEqual([
      expect.objectContaining({
        previousModel: 'bge-m3',
        newModel: 'Qwen3-Embedding-4B',
        threshold: 0.35,
        settingKey: 'rag_confidence_threshold',
        guidance: expect.stringContaining('Settings → AI Models → Retrieval'),
      }),
    ]);
    // Warn, don't mutate.
    const after = await query<{ setting_value: string }>(
      `SELECT setting_value FROM admin_settings WHERE setting_key = 'rag_confidence_threshold'`,
    );
    expect(after.rows[0]!.setting_value).toBe('0.35');
  });

  it('warns when the rerank assignment moves under a live rerank threshold', async () => {
    const providerId = await seedProvider('rr', 'bge-reranker-v2-m3');
    await seedAssignment('rerank', providerId, 'bge-reranker-v2-m3');
    await setThreshold('rag_confidence_threshold_rerank', '0.2');
    warnSpy.mockClear();

    expect((await put({ rerank: { providerId, model: 'jina-reranker-v2' } })).statusCode).toBe(200);

    expect(calibrationWarnings()).toEqual([
      expect.objectContaining({
        previousModel: 'bge-reranker-v2-m3',
        newModel: 'jina-reranker-v2',
        settingKey: 'rag_confidence_threshold_rerank',
      }),
    ]);
  });

  it('warns when the rerank stage is turned OFF under a live rerank threshold', async () => {
    const providerId = await seedProvider('rr2', 'bge-reranker-v2-m3');
    await seedAssignment('rerank', providerId, null); // model inherits default_model
    await setThreshold('rag_confidence_threshold_rerank', '0.2');
    warnSpy.mockClear();

    // ADR-021: clearing the assignment disables the stage. The threshold now
    // gates nothing it was tuned on, which is worth saying out loud.
    expect((await put({ rerank: { providerId: null, model: null } })).statusCode).toBe(200);

    expect(calibrationWarnings()).toEqual([
      expect.objectContaining({ previousModel: 'bge-reranker-v2-m3', newModel: null }),
    ]);
  });

  it('says nothing when the gate is off — 0 is the default on every instance', async () => {
    const providerId = await seedProvider('emb2', 'bge-m3');
    await seedAssignment('embedding', providerId, 'bge-m3');
    warnSpy.mockClear();

    expect((await put({ embedding: { providerId, model: 'Qwen3-Embedding-4B' } })).statusCode).toBe(200);

    expect(calibrationWarnings()).toEqual([]);
  });

  it('says nothing when the save re-writes the SAME pair, or moves an unrelated use case', async () => {
    const providerId = await seedProvider('emb3', 'bge-m3');
    await seedAssignment('embedding', providerId, 'bge-m3');
    await setThreshold('rag_confidence_threshold', '0.35');
    await setThreshold('rag_confidence_threshold_rerank', '0.2');
    warnSpy.mockClear();

    // Both in one request: nothing about the embedding pair moved, and
    // `summary` has no confidence basis at all.
    expect(
      (await put({ embedding: { providerId, model: 'bge-m3' }, summary: { providerId, model: 'mA' } })).statusCode,
    ).toBe(200);

    expect(calibrationWarnings()).toEqual([]);
  });

  /**
   * Review r1: the staleness verdict itself, driven by a REAL
   * `llm_usecase_assignments` change rather than a mocked resolver.
   *
   * `admin-confidence-calibration.test.ts` mocks `resolveConfidenceBasisPair`,
   * which is right for the write-gating rules it pins — those are about which
   * thresholds a body carried — but it means nothing there ever exercises the
   * resolver against a real row. CLAUDE.md's rule is to mock at the HTTP
   * boundary, and this file already has real Postgres and the real route, so
   * the whole loop fits: record a threshold, re-point the model, read the
   * verdict back off `GET /admin/settings`.
   */
  it('reports the threshold as stale on GET after a real assignment change', async () => {
    const providerId = await seedProvider('emb4', 'bge-m3');
    await seedAssignment('embedding', providerId, 'bge-m3');

    const saved = await app.inject({
      method: 'PUT',
      url: '/api/admin/settings',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ ragConfidenceThreshold: 0.35 }),
    });
    expect(saved.statusCode).toBe(200);

    const readCalibration = async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/settings',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      return (res.json() as { ragConfidenceCalibration: { similarity: Record<string, unknown> | null } })
        .ragConfidenceCalibration.similarity;
    };

    expect(await readCalibration()).toMatchObject({
      providerId,
      model: 'bge-m3',
      liveProviderId: providerId,
      liveModel: 'bge-m3',
      stale: false,
    });

    expect((await put({ embedding: { providerId, model: 'Qwen3-Embedding-4B' } })).statusCode).toBe(200);

    expect(await readCalibration()).toMatchObject({
      model: 'bge-m3',
      liveModel: 'Qwen3-Embedding-4B',
      stale: true,
    });
  });

  it('reports stale on GET when the rerank stage really becomes unassigned', async () => {
    // ADR-021's disabled state, reached through the route rather than a stub:
    // `resolveRerankUsecase` must answer null for a cleared assignment instead
    // of inheriting the default provider, or the verdict would read "still the
    // model this was tuned on" for a stage that is off.
    const providerId = await seedProvider('rr4', 'bge-reranker-v2-m3');
    await seedAssignment('rerank', providerId, 'bge-reranker-v2-m3');

    const saved = await app.inject({
      method: 'PUT',
      url: '/api/admin/settings',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ ragConfidenceThresholdRerank: 0.2 }),
    });
    expect(saved.statusCode).toBe(200);

    expect((await put({ rerank: { providerId: null, model: null } })).statusCode).toBe(200);

    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/settings',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(
      (res.json() as { ragConfidenceCalibration: { rerank: Record<string, unknown> | null } })
        .ragConfidenceCalibration.rerank,
    ).toMatchObject({
      model: 'bge-reranker-v2-m3',
      liveProviderId: null,
      liveModel: null,
      stale: true,
    });
  });
});

/**
 * #1184 — the two capability routes seen through a mocked capability module.
 * Their real behaviour against a real store lives in
 * `llm-usecases-vision.test.ts`; what only this file can assert is *which*
 * service function each route calls, because here they are distinguishable.
 */
describe.skipIf(!dbAvailable)('vision capability routes call the right store function (#1184)', () => {
  async function seedDefaultProvider(): Promise<string> {
    const created = await app.inject({
      method: 'POST', url: '/api/admin/llm-providers',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'A', baseUrl: 'http://a/v1', authType: 'none', verifySsl: true, defaultModel: 'qwen2.5vl' }),
    });
    const providerId: string = created.json().id;
    await app.inject({
      method: 'POST', url: `/api/admin/llm-providers/${providerId}/set-default`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    mockRefreshVisionCapability.mockClear();
    mockReadVisionCapabilityDetail.mockClear();
    return providerId;
  }

  it('GET vision-capability reads the cache and never probes', async () => {
    const providerId = await seedDefaultProvider();
    mockReadVisionCapabilityDetail.mockResolvedValue({
      vision: false,
      probedAt: '2026-08-01T00:00:00.000Z',
      probeError: 'chat HTTP 415: image_url',
    });

    const res = await app.inject({
      method: 'GET', url: '/api/admin/llm-usecases/chat/vision-capability',
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(mockReadVisionCapabilityDetail).toHaveBeenCalledWith(providerId, 'qwen2.5vl');
    expect(mockRefreshVisionCapability).not.toHaveBeenCalled();
  });

  /**
   * The route answers from the value `refreshVisionCapability` returned rather
   * than re-reading the row it just wrote. A re-read is a second round-trip
   * that a concurrent background refresh of the same key could win, handing
   * the admin a verdict their click did not produce.
   */
  it('POST reprobe-vision answers from the refresh result, without a follow-up read', async () => {
    await seedDefaultProvider();
    mockRefreshVisionCapability.mockResolvedValue({
      vision: true,
      probedAt: '2026-08-02T10:00:00.000Z',
      probeError: null,
    });
    // Would answer `false` if the route re-read instead of using the result.
    mockReadVisionCapabilityDetail.mockResolvedValue({
      vision: false,
      probedAt: '2026-07-01T00:00:00.000Z',
      probeError: 'stale',
    });

    const res = await app.inject({
      method: 'POST', url: '/api/admin/llm-usecases/chat/reprobe-vision',
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.json()).toMatchObject({
      vision: true,
      probedAt: '2026-08-02T10:00:00.000Z',
      probeError: null,
    });
    expect(mockReadVisionCapabilityDetail).not.toHaveBeenCalled();
  });
});

describe.skipIf(!dbAvailable)('GET /api/llm/usecase-default', () => {
  it('returns the resolved chat default for any authenticated user (#355)', async () => {
    const p = await app.inject({
      method: 'POST',
      url: '/api/admin/llm-providers',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'Chat Provider',
        baseUrl: 'http://a/v1',
        authType: 'none',
        verifySsl: true,
        defaultModel: 'gpt-4o',
      }),
    });
    const providerId: string = p.json().id;
    await app.inject({
      method: 'POST',
      url: `/api/admin/llm-providers/${providerId}/set-default`,
      headers: { authorization: `Bearer ${adminToken}` },
    });

    // Even a non-admin token should be able to read the default — this route
    // is auth-gated but not admin-gated.
    const userResult = await query<{ id: string }>(
      `INSERT INTO users (username, password_hash, role)
       VALUES ('chat_default_user', 'fakehash', 'user') RETURNING id`,
    );
    const userId = userResult.rows[0]!.id;
    await query('INSERT INTO user_settings (user_id) VALUES ($1)', [userId]);
    const userToken = await generateAccessToken({
      sub: userId,
      username: 'chat_default_user',
      role: 'user',
    });

    const r = await app.inject({
      method: 'GET',
      url: '/api/llm/usecase-default?usecase=chat',
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      usecase: 'chat',
      providerId,
      providerName: 'Chat Provider',
      model: 'gpt-4o',
    });
  });

  it('rejects an invalid usecase with 400', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/llm/usecase-default?usecase=bogus',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(r.statusCode).toBe(400);
  });

  it('returns 401 without auth', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/llm/usecase-default?usecase=chat',
    });
    expect(r.statusCode).toBe(401);
  });

  it('surfaces 404 with a specific message when no provider is configured', async () => {
    // No provider has been created — resolveUsecase('chat') should reject.
    const r = await app.inject({
      method: 'GET',
      url: '/api/llm/usecase-default?usecase=chat',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(r.statusCode).toBe(404);
    expect(r.json().error).toMatch(/Settings → AI Models/);
  });

  describe('GET /llm/usecase-default vision field (#1154)', () => {
    it('returns the cached capability verdict', async () => {
      // First set up a provider
      const p = await app.inject({
        method: 'POST',
        url: '/api/admin/llm-providers',
        headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
        payload: JSON.stringify({
          name: 'Vision Provider',
          baseUrl: 'http://vision/v1',
          authType: 'none',
          verifySsl: true,
          defaultModel: 'vision-model',
        }),
      });
      const providerId: string = p.json().id;
      await app.inject({
        method: 'POST',
        url: `/api/admin/llm-providers/${providerId}/set-default`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      mockGetVisionCapability.mockResolvedValue(true);
      const res = await app.inject({
        method: 'GET',
        url: '/api/llm/usecase-default?usecase=chat',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().vision).toBe(true);
    });

    it('passes null through rather than coercing it to false', async () => {
      // First set up a provider
      const p = await app.inject({
        method: 'POST',
        url: '/api/admin/llm-providers',
        headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
        payload: JSON.stringify({
          name: 'Null Provider',
          baseUrl: 'http://null/v1',
          authType: 'none',
          verifySsl: true,
          defaultModel: 'null-model',
        }),
      });
      const providerId: string = p.json().id;
      await app.inject({
        method: 'POST',
        url: `/api/admin/llm-providers/${providerId}/set-default`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      mockGetVisionCapability.mockResolvedValue(null);
      const res = await app.inject({
        method: 'GET',
        url: '/api/llm/usecase-default?usecase=chat',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.json().vision).toBeNull();
    });

    it('validates the response against UsecaseDefaultSchema', async () => {
      // First set up a provider
      const p = await app.inject({
        method: 'POST',
        url: '/api/admin/llm-providers',
        headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
        payload: JSON.stringify({
          name: 'Validation Provider',
          baseUrl: 'http://validate/v1',
          authType: 'none',
          verifySsl: true,
          defaultModel: 'validate-model',
        }),
      });
      const providerId: string = p.json().id;
      await app.inject({
        method: 'POST',
        url: `/api/admin/llm-providers/${providerId}/set-default`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      mockGetVisionCapability.mockResolvedValue(false);
      const res = await app.inject({
        method: 'GET',
        url: '/api/llm/usecase-default?usecase=chat',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(() => UsecaseDefaultSchema.parse(res.json())).not.toThrow();
    });

    /**
     * `getVisionCapability` schedules a real chat-completion probe on a cache
     * miss. Asking it about `embedding` would fire one at an embeddings
     * endpoint and cache a meaningless verdict — and this route is reachable
     * by any authenticated user with any use case in the query string.
     */
    it.each(['summary', 'quality', 'auto_tag', 'embedding'])(
      'does not consult the capability store for usecase=%s',
      async (usecase) => {
        const p = await app.inject({
          method: 'POST',
          url: '/api/admin/llm-providers',
          headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
          payload: JSON.stringify({
            name: 'Non-chat Provider',
            baseUrl: 'http://nonchat/v1',
            authType: 'none',
            verifySsl: true,
            defaultModel: 'bge-m3',
          }),
        });
        await app.inject({
          method: 'POST',
          url: `/api/admin/llm-providers/${p.json().id}/set-default`,
          headers: { authorization: `Bearer ${adminToken}` },
        });

        mockGetVisionCapability.mockClear().mockResolvedValue(true);
        const res = await app.inject({
          method: 'GET',
          url: `/api/llm/usecase-default?usecase=${usecase}`,
          headers: { authorization: `Bearer ${adminToken}` },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json().vision).toBeNull();
        expect(mockGetVisionCapability).not.toHaveBeenCalled();
      },
    );

    it('does not return the provider-not-configured 404 if schema validation fails', async () => {
      // Set up a provider so resolveUsecase succeeds
      const p = await app.inject({
        method: 'POST',
        url: '/api/admin/llm-providers',
        headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
        payload: JSON.stringify({
          name: 'Schema Test Provider',
          baseUrl: 'http://schema-test/v1',
          authType: 'none',
          verifySsl: true,
          defaultModel: 'schema-model',
        }),
      });
      const providerId: string = p.json().id;
      await app.inject({
        method: 'POST',
        url: `/api/admin/llm-providers/${providerId}/set-default`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

      // Mock getVisionCapability to return an invalid value that will fail schema validation.
      // This simulates a bug in the getter, not a missing provider.
      mockGetVisionCapability.mockResolvedValue('not-a-boolean');

      // The error should propagate as a 500 (schema validation error), not as the
      // provider-not-configured 404 message.
      const res = await app.inject({
        method: 'GET',
        url: '/api/llm/usecase-default?usecase=chat',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      // Schema validation error triggers a 500, not the 404 "Configure one in Settings → AI Models"
      expect(res.statusCode).not.toBe(404);
      expect(res.json().error).not.toMatch(/Settings → AI Models/);
    });
  });
});
