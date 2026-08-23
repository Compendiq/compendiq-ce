/**
 * #1402 (phase 1/3) — per-user onboarding checklist state: real-Postgres
 * round-trip.
 *
 * The mocked-`query` tests in settings.test.ts cannot observe two things a
 * real request depends on:
 *   1. The GET SELECT actually reading `onboarding_state` off the row (a
 *      mocked test never executes the SQL string, so dropping the column
 *      from the SELECT leaves every mocked test green).
 *   2. The PUT merge operator (`onboarding_state || $n::jsonb`) actually
 *      surviving two sequential single-key patches end to end, including
 *      correct `$n` parameter-index alignment when mixed with other fields.
 *
 * Modelled on settings-pat-prompt.test.ts (#771) — buildApp() + real
 * Postgres + real JWT, per the repo rule that DB tests never mock the DB.
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

async function createUser(username: string): Promise<{ token: string; userId: string }> {
  const result = await query<{ id: string }>(
    `INSERT INTO users (username, password_hash, role)
     VALUES ($1, 'fakehash', 'user') RETURNING id`,
    [username],
  );
  const userId = result.rows[0]!.id;
  await query('INSERT INTO user_settings (user_id) VALUES ($1)', [userId]);
  const token = await generateAccessToken({ sub: userId, username, role: 'user' });
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

describe.skipIf(!dbAvailable)('Onboarding checklist state — real-Postgres round trip (#1402)', () => {
  it('two sequential single-key PUTs both survive in the next GET, with the other three flags defaulted', async () => {
    const { token } = await createUser('onboarding_merge_user');

    const putFirst = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { authorization: `Bearer ${token}` },
      payload: { onboardingState: { firstAiQueryMade: true } },
    });
    expect(putFirst.statusCode).toBe(200);

    const putSecond = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { authorization: `Bearer ${token}` },
      payload: { onboardingState: { shortcutsModalViewed: true } },
    });
    expect(putSecond.statusCode).toBe(200);

    const get = await app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json().onboardingState).toEqual({
      firstAiQueryMade: true,
      shortcutsModalViewed: true,
      pageCreatedOrEdited: false,
      dismissed: false,
      completedAt: null,
    });
  });

  it('a mixed PUT (theme + onboardingState + syncIntervalMin) keeps $n parameter indexes aligned', async () => {
    const { token, userId } = await createUser('onboarding_mixed_user');

    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        theme: 'polar-slate',
        onboardingState: { pageCreatedOrEdited: true },
        syncIntervalMin: 30,
      },
    });
    expect(put.statusCode).toBe(200);

    const row = await query<{
      theme: string;
      sync_interval_min: number;
      onboarding_state: Record<string, unknown>;
    }>(
      'SELECT theme, sync_interval_min, onboarding_state FROM user_settings WHERE user_id = $1',
      [userId],
    );
    expect(row.rows[0]!.theme).toBe('polar-slate');
    expect(row.rows[0]!.sync_interval_min).toBe(30);
    expect(row.rows[0]!.onboarding_state).toEqual({ pageCreatedOrEdited: true });

    const get = await app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: { authorization: `Bearer ${token}` },
    });
    const body = get.json();
    expect(body.theme).toBe('polar-slate');
    expect(body.syncIntervalMin).toBe(30);
    expect(body.onboardingState).toMatchObject({ pageCreatedOrEdited: true });
  });

  it('GET returns a fully-defaulted onboardingState for a row that predates any onboarding activity', async () => {
    const { token } = await createUser('onboarding_fresh_user');

    const get = await app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json().onboardingState).toEqual({
      firstAiQueryMade: false,
      shortcutsModalViewed: false,
      pageCreatedOrEdited: false,
      dismissed: false,
      completedAt: null,
    });
  });
});
