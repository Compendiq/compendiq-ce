import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

// Short-circuit the DNS lookups the SSRF guard performs while the app boots —
// `admin-embedding-locks.test.ts`'s recipe, and the reason this file can build
// the REAL app without reaching the network.
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

/**
 * #1115 P2 — that the image-index routes are actually MOUNTED (review r3).
 *
 * `llm-image-index.test.ts` registers the plugin onto a Fastify instance it
 * builds itself, which is right for testing the payload and the admin gate and
 * structurally blind to the one line in `app.ts` that puts those routes on the
 * server. Deleting that line left the whole suite green while every request
 * the Embeddings-tab card makes 404s — the backend twin of the dead-import gap
 * `EmbeddingTab.test.tsx` closed on the frontend.
 *
 * So: the real `buildApp()`, and a status code that is anything but 404. It
 * deliberately asserts nothing about the payload; that belongs next door.
 */

const dbAvailable = await isDbAvailable();

let app: FastifyInstance;
let adminToken: string;

async function createAdminAndLogin(username: string): Promise<string> {
  const result = await query<{ id: string }>(
    `INSERT INTO users (username, password_hash, role)
     VALUES ($1, 'fakehash', 'admin') RETURNING id`,
    [username],
  );
  const userId = result.rows[0]!.id;
  await query('INSERT INTO user_settings (user_id) VALUES ($1)', [userId]);
  return generateAccessToken({ sub: userId, username, role: 'admin' });
}

async function createMemberAndLogin(username: string): Promise<string> {
  const result = await query<{ id: string }>(
    `INSERT INTO users (username, password_hash, role)
     VALUES ($1, 'fakehash', 'member') RETURNING id`,
    [username],
  );
  const userId = result.rows[0]!.id;
  await query('INSERT INTO user_settings (user_id) VALUES ($1)', [userId]);
  return generateAccessToken({ sub: userId, username, role: 'member' });
}

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
  adminToken = await createAdminAndLogin('image_index_admin');
});

describe.skipIf(!dbAvailable)('the image-index routes on the real app (#1115 P2)', () => {
  it('serves GET /api/admin/embedding/image-index to an admin', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/admin/embedding/image-index',
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(r.statusCode).toBe(200);
    // The leg is unassigned on a fresh instance — the card's "assign it" state,
    // and proof the handler ran rather than a router miss answering 200.
    expect(r.json().assigned).toBe(false);
  });

  it('serves both actions to an admin', async () => {
    for (const url of [
      '/api/admin/embedding/image-index/process',
      '/api/admin/embedding/image-index/rescan',
    ]) {
      const r = await app.inject({
        method: 'POST',
        url,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(r.statusCode, url).toBe(200);
    }
  });

  it('gates all three behind requireAdmin on the mounted app', async () => {
    const memberToken = await createMemberAndLogin('image_index_member');
    const calls: Array<[string, string]> = [
      ['GET', '/api/admin/embedding/image-index'],
      ['POST', '/api/admin/embedding/image-index/process'],
      ['POST', '/api/admin/embedding/image-index/rescan'],
    ];
    for (const [method, url] of calls) {
      const r = await app.inject({
        method: method as 'GET' | 'POST',
        url,
        headers: { authorization: `Bearer ${memberToken}` },
      });
      expect(r.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it('answers 401 without a token — never 404', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/admin/embedding/image-index' });
    expect(r.statusCode).toBe(401);
  });
});
