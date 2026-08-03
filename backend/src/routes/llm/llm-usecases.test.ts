import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
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
  it('returns 5 rows with resolved blocks', async () => {
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
    expect(Object.keys(body).sort()).toEqual(['auto_tag', 'chat', 'embedding', 'quality', 'summary']);
    expect(body.chat.resolved).toMatchObject({ providerId: id, model: 'mA' });
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
    expect(r.json().error).toMatch(/Settings → LLM/);
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
      // Schema validation error triggers a 500, not the 404 "Configure one in Settings → LLM"
      expect(res.statusCode).not.toBe(404);
      expect(res.json().error).not.toMatch(/Settings → LLM/);
    });
  });
});
