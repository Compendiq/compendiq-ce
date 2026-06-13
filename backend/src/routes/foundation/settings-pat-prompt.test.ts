/**
 * #771 — Confluence-PAT onboarding prompt: real-Postgres round-trip.
 *
 * Covers the full loop the dismissible banner depends on:
 *   GET  /api/settings → confluencePatPromptDismissed (derived boolean)
 *   PUT  /api/settings { confluencePatPromptDismissed } → sets/clears the
 *        server-side timestamp in user_settings.confluence_pat_prompt_dismissed_at
 *
 * Uses buildApp() + real Postgres + real JWTs (admin AND non-admin) per the
 * repo rule: DB tests never mock the DB.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

// Short-circuit DNS lookups performed by the SSRF guard (no real network in tests).
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

async function createUser(username: string, role: 'admin' | 'user'): Promise<{ token: string; userId: string }> {
  const result = await query<{ id: string }>(
    `INSERT INTO users (username, password_hash, role)
     VALUES ($1, 'fakehash', $2) RETURNING id`,
    [username, role],
  );
  const userId = result.rows[0]!.id;
  await query('INSERT INTO user_settings (user_id) VALUES ($1)', [userId]);
  const token = await generateAccessToken({ sub: userId, username, role });
  return { token, userId };
}

const dbAvailable = await isDbAvailable();

let app: FastifyInstance;

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
});

describe.skipIf(!dbAvailable)('Confluence PAT prompt dismissal (#771)', () => {
  it('GET /api/settings returns confluencePatPromptDismissed=false for a fresh user', async () => {
    const { token } = await createUser('pat_prompt_fresh', 'user');

    const res = await app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hasConfluencePat).toBe(false);
    expect(body.confluencePatPromptDismissed).toBe(false);
  });

  it('GET /api/settings returns confluencePatPromptDismissed=false when the row is auto-created', async () => {
    // No user_settings row — GET creates the default row on first fetch.
    const result = await query<{ id: string }>(
      `INSERT INTO users (username, password_hash, role)
       VALUES ('pat_prompt_norow', 'fakehash', 'user') RETURNING id`,
    );
    const token = await generateAccessToken({
      sub: result.rows[0]!.id, username: 'pat_prompt_norow', role: 'user',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().confluencePatPromptDismissed).toBe(false);
  });

  it('PUT { confluencePatPromptDismissed: true } sets the timestamp and round-trips via GET', async () => {
    const { token, userId } = await createUser('pat_prompt_dismiss', 'user');

    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { authorization: `Bearer ${token}` },
      payload: { confluencePatPromptDismissed: true },
    });
    expect(put.statusCode).toBe(200);

    // Timestamp is set server-side…
    const row = await query<{ confluence_pat_prompt_dismissed_at: Date | null }>(
      'SELECT confluence_pat_prompt_dismissed_at FROM user_settings WHERE user_id = $1',
      [userId],
    );
    expect(row.rows[0]!.confluence_pat_prompt_dismissed_at).toBeInstanceOf(Date);

    // …and only the derived boolean is exposed.
    const get = await app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: { authorization: `Bearer ${token}` },
    });
    const body = get.json();
    expect(body.confluencePatPromptDismissed).toBe(true);
    expect(JSON.stringify(body)).not.toContain('confluence_pat_prompt_dismissed_at');
  });

  it('PUT { confluencePatPromptDismissed: false } clears the dismissal', async () => {
    const { token, userId } = await createUser('pat_prompt_clear', 'user');
    await query(
      'UPDATE user_settings SET confluence_pat_prompt_dismissed_at = NOW() WHERE user_id = $1',
      [userId],
    );

    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { authorization: `Bearer ${token}` },
      payload: { confluencePatPromptDismissed: false },
    });
    expect(put.statusCode).toBe(200);

    const get = await app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(get.json().confluencePatPromptDismissed).toBe(false);
  });

  it('works for admin users too', async () => {
    const { token } = await createUser('pat_prompt_admin', 'admin');

    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { authorization: `Bearer ${token}` },
      payload: { confluencePatPromptDismissed: true },
    });
    expect(put.statusCode).toBe(200);

    const get = await app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(get.json().confluencePatPromptDismissed).toBe(true);
  });

  it('requires authentication', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { confluencePatPromptDismissed: true },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects non-boolean values', async () => {
    const { token } = await createUser('pat_prompt_invalid', 'user');

    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { authorization: `Bearer ${token}` },
      payload: { confluencePatPromptDismissed: 'yes' },
    });
    expect(res.statusCode).toBe(400);
  });
});
