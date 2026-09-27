/**
 * Production-wire coverage for page-version restore errors. The route-only
 * suite uses a compact serializer, so this file exercises buildApp's real
 * error handler and the frontend-visible response contract.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => {
    const error = new Error('getaddrinfo ENOTFOUND (mocked)') as NodeJS.ErrnoException;
    error.code = 'ENOTFOUND';
    throw error;
  }),
}));

import { buildApp } from '../../app.js';
import { query } from '../../core/db/postgres.js';
import { generateAccessToken } from '../../core/plugins/auth.js';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';

const dbAvailable = await isDbAvailable();
const redisAvailable = dbAvailable ? await isRedisAvailable() : false;
const canRun = dbAvailable && redisAvailable;

let app: FastifyInstance;

beforeAll(async () => {
  if (!canRun) return;
  await setupTestDb();
  app = await buildApp();
  await app.ready();
}, 60_000);

beforeEach(async () => {
  if (!canRun) return;
  await truncateAllTables();
});

afterAll(async () => {
  if (!canRun) return;
  await app?.close();
  await teardownTestDb();
});

describe.skipIf(!canRun)('page version restore production error contract', () => {
  it('returns the actionable refresh message for a stale expected version', async () => {
    const username = 'restore-wire-owner';
    const user = await query<{ id: string }>(
      `INSERT INTO users (username, password_hash, role)
       VALUES ($1, 'fakehash', 'user')
       RETURNING id`,
      [username],
    );
    const userId = user.rows[0]!.id;
    await query('INSERT INTO user_settings (user_id) VALUES ($1)', [userId]);
    const token = await generateAccessToken({ sub: userId, username, role: 'user' });

    const page = await query<{ id: number }>(
      `INSERT INTO pages
         (source, title, body_storage, body_html, body_text, version, visibility,
          created_by_user_id, embedding_dirty, embedding_status)
       VALUES ('standalone', 'Concurrent edit', '<p>concurrent edit</p>',
               '<p>concurrent edit</p>', 'concurrent edit', 3, 'private', $1,
               FALSE, 'not_embedded')
       RETURNING id`,
      [userId],
    );
    const pageId = page.rows[0]!.id;
    await query(
      `INSERT INTO page_versions
         (page_id, version_number, title, body_html, body_text, synced_at)
       VALUES ($1, 1, 'Version one', '<p>version one</p>', 'version one', NOW())`,
      [pageId],
    );

    const response = await app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/versions/1/restore`,
      headers: { authorization: `Bearer ${token}` },
      payload: { version: 2 },
    });

    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({
      statusCode: 409,
      message: 'Page has been modified since you loaded it. Please refresh and try again.',
    });
  });
});
