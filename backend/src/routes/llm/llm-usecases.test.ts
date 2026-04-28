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

import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';
import { buildApp } from '../../app.js';
import { generateAccessToken } from '../../core/plugins/auth.js';

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
});
