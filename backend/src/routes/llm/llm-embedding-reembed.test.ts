import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

// Short-circuit DNS lookups performed by the SSRF guard — mirrors the pattern
// in llm-providers.test.ts. The guard swallows DNS errors silently, so a fake
// ENOTFOUND is safe here and prevents real DNS resolution from hanging.
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

async function createAdminAndLogin(): Promise<{ token: string; userId: string }> {
  const result = await query<{ id: string }>(
    `INSERT INTO users (username, password_hash, role)
     VALUES ('llm_reembed_admin', 'fakehash', 'admin') RETURNING id`,
  );
  const userId = result.rows[0]!.id;
  await query('INSERT INTO user_settings (user_id) VALUES ($1)', [userId]);
  const token = await generateAccessToken({
    sub: userId,
    username: 'llm_reembed_admin',
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

describe.skipIf(!dbAvailable)('POST /api/admin/embedding/reembed', () => {
  it('returns jobId and pageCount', async () => {
    // Seed one page so pageCount is observably non-zero.
    await query(
      `INSERT INTO pages (confluence_id, space_key, title, body_text, body_html)
       VALUES ('p1', $1, 'Reembed Test Page', 'hello', '<p>hello</p>')`,
      ['SPACE1'],
    );

    const r = await app.inject({
      method: 'POST',
      url: '/api/admin/embedding/reembed',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.jobId).toMatch(/^reembed-/);
    expect(typeof body.pageCount).toBe('number');
    expect(body.pageCount).toBe(1);
  });

  it('returns 0 pageCount when pages table is empty', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/admin/embedding/reembed',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.jobId).toMatch(/^reembed-/);
    expect(body.pageCount).toBe(0);
  });

  it('returns 401 without auth', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/admin/embedding/reembed',
    });
    expect(r.statusCode).toBe(401);
  });

  it('returns 403 when caller is not an admin', async () => {
    const userResult = await query<{ id: string }>(
      `INSERT INTO users (username, password_hash, role)
       VALUES ('reembed_member', 'fakehash', 'member') RETURNING id`,
    );
    const memberId = userResult.rows[0]!.id;
    await query('INSERT INTO user_settings (user_id) VALUES ($1)', [memberId]);
    const memberToken = await generateAccessToken({
      sub: memberId,
      username: 'reembed_member',
      role: 'member',
    });
    const r = await app.inject({
      method: 'POST',
      url: '/api/admin/embedding/reembed',
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(r.statusCode).toBe(403);
  });
});
