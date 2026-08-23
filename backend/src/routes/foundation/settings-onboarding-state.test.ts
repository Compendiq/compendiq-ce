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

// #1402 (review, external round): unlike createUser above, this leaves NO
// user_settings row behind — Phase 2 fires onboardingState PUTs from
// background events (first AI question, shortcuts modal, page created/edited)
// that can land before the user's first GET /settings has ever run, so the
// row-ensure GET relies on cannot be assumed here.
async function createUserWithoutSettingsRow(username: string): Promise<{ token: string; userId: string }> {
  const result = await query<{ id: string }>(
    `INSERT INTO users (username, password_hash, role)
     VALUES ($1, 'fakehash', 'user') RETURNING id`,
    [username],
  );
  const userId = result.rows[0]!.id;
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

  it('PUT onboardingState for a user with no pre-existing user_settings row does not silently drop the patch (#1402 review, external round)', async () => {
    const { token, userId } = await createUserWithoutSettingsRow('onboarding_no_row_user');

    const preCheck = await query('SELECT 1 FROM user_settings WHERE user_id = $1', [userId]);
    expect(preCheck.rows).toHaveLength(0);

    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { authorization: `Bearer ${token}` },
      payload: { onboardingState: { dismissed: true } },
    });
    expect(put.statusCode).toBe(200);

    const row = await query<{ onboarding_state: Record<string, unknown> }>(
      'SELECT onboarding_state FROM user_settings WHERE user_id = $1',
      [userId],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]!.onboarding_state).toEqual({ dismissed: true });

    const get = await app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(get.json().onboardingState).toMatchObject({ dismissed: true });
  });

  // #1402 (review r1): the row-ensure INSERT added for the no-pre-existing-row
  // case above unconditionally targets user_settings.user_id -> users(id).
  // auth.ts caches liveness for USER_SECURITY_CACHE_TTL_MS (30s), so a PUT
  // arriving inside that window for a user hard-deleted moments earlier still
  // passes auth, reaches this route, and the INSERT violates the FK — a 500,
  // where the pre-#1402 route (no row-ensure) returned a 200 no-op. This must
  // stay a 200 no-op, not a regression into a logged 500.
  it('PUT for a user deleted after auth caches them as live does not 500 on the FK violation (#1402 review r1)', async () => {
    const { token, userId } = await createUser('onboarding_deleted_user');

    // Warm the #737 cached-liveness check (USER_SECURITY_CACHE_TTL_MS = 30s)
    // so the PUT below is authenticated from cache, not a fresh DB lookup.
    const warmGet = await app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(warmGet.statusCode).toBe(200);

    // CASCADE removes the user_settings row created above (createUser inserts
    // one directly), reproducing the "row genuinely gone, cache still says
    // live" window the reviewer's probe exercises.
    await query('DELETE FROM users WHERE id = $1', [userId]);

    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { authorization: `Bearer ${token}` },
      payload: { onboardingState: { dismissed: true } },
    });

    expect(put.statusCode).toBe(200);

    const row = await query('SELECT 1 FROM user_settings WHERE user_id = $1', [userId]);
    expect(row.rows).toHaveLength(0);
  });

  // #1402 (review, external round): GET's row-ensure INSERT (fired when the
  // SELECT finds no row) hit the exact same FK race as PUT's — a user hard-
  // deleted inside auth's #737 cached-liveness window — but, unlike PUT's,
  // had no try/catch for code 23503. This must degrade to the same
  // fully-defaulted 200 response PUT's tolerant path returns, not an
  // uncaught 500.
  it('GET for a user deleted after auth caches them as live does not 500 on the FK violation', async () => {
    const { token, userId } = await createUserWithoutSettingsRow('onboarding_get_deleted_user');

    // Warm the cached-liveness check with a GET that still finds the user
    // live (no user_settings row yet, so this itself exercises the
    // row-ensure INSERT's happy path and leaves a row behind).
    const warmGet = await app.inject({
      method: 'GET',
      url: '/api/settings',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(warmGet.statusCode).toBe(200);

    // Delete the row-ensure's own row plus the user, then delete the user
    // again to reproduce "row genuinely gone, cache still says live" for the
    // SELECT-finds-nothing branch.
    await query('DELETE FROM user_settings WHERE user_id = $1', [userId]);
    await query('DELETE FROM users WHERE id = $1', [userId]);

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

    const row = await query('SELECT 1 FROM user_settings WHERE user_id = $1', [userId]);
    expect(row.rows).toHaveLength(0);
  });
});
