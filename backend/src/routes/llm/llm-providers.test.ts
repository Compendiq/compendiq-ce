import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';
import { buildApp } from '../../app.js';
import { generateAccessToken } from '../../core/plugins/auth.js';

// The plan references a `createTestUserAndLogin` helper that does not exist
// in this repo. We inline the same behaviour here using `generateAccessToken`,
// mirroring the pattern used by `rate-limit.test.ts`.
async function createAdminAndLogin(): Promise<{ token: string; userId: string }> {
  const result = await query<{ id: string }>(
    `INSERT INTO users (username, password_hash, role)
     VALUES ('llm_provider_admin', 'fakehash', 'admin') RETURNING id`,
  );
  const userId = result.rows[0]!.id;
  await query('INSERT INTO user_settings (user_id) VALUES ($1)', [userId]);
  const token = await generateAccessToken({
    sub: userId,
    username: 'llm_provider_admin',
    role: 'admin',
  });
  return { token, userId };
}

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('GET /api/admin/llm-providers', () => {
  let app: FastifyInstance;
  let adminToken: string;

  beforeAll(async () => {
    await setupTestDb();
    app = await buildApp();
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    ({ token: adminToken } = await createAdminAndLogin());
  });

  it('returns [] when no providers', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/admin/llm-providers',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual([]);
  });

  it('never returns the plaintext apiKey', async () => {
    await query(
      `INSERT INTO llm_providers (name, base_url, api_key, auth_type, verify_ssl, is_default)
       VALUES ('X','http://x/v1','encrypted-sekret','bearer',true,true)`,
    );
    const r = await app.inject({
      method: 'GET',
      url: '/api/admin/llm-providers',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body[0]).toMatchObject({ name: 'X', hasApiKey: true });
    expect(JSON.stringify(body)).not.toContain('encrypted-sekret');
  });
});
