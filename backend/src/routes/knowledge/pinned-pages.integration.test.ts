/**
 * Integration tests for the pinned-articles routes against a REAL PostgreSQL
 * (port 5433, per `test-db-helper.ts`).
 *
 * #1130 removed the 8-pin cap, and the job of this file is to *demonstrate*
 * that through the route itself: the app is built, the real handler in
 * `pinned-pages.ts` runs, and every statement it issues reaches the test
 * database. Until #1180 this file executed a pasted copy of the route's INSERT
 * instead, which only ever proved that Postgres accepts 25 rows — never in
 * doubt, since the cap was always application-level. That version would have
 * passed unchanged had the handler reintroduced a count guard, or had the route
 * been deleted outright, and the copy could drift from the real statement
 * silently. Nothing here may restate the route's SQL: the route is the thing
 * under test.
 *
 * `pinned-pages.test.ts` covers the same endpoints with `core/db/postgres.js`
 * mocked, so it can assert the *shape* of a statement but can never hold nine
 * real rows. The two files are complements, not duplicates.
 *
 * Only `fastify.authenticate` is stubbed — the sole boundary this route has.
 * RBAC is real: the fixture pages are standalone and `shared` (migration 029's
 * default), so `userCanAccessPage` admits them through its genuine
 * standalone-visibility branch rather than an admin bypass.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import Fastify, { type FastifyRequest } from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';

import {
  setupTestDb,
  truncateAllTables,
  teardownTestDb,
  isDbAvailable,
} from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';
import { pinnedPagesRoutes } from './pinned-pages.js';

const dbAvailable = await isDbAvailable();

let userId: string;

async function makeUser(): Promise<string> {
  const res = await query<{ id: string }>(
    `INSERT INTO users (username, password_hash, role) VALUES ($1, 'x', 'user') RETURNING id`,
    [`pinner-${Math.floor(performance.now() * 1000)}`],
  );
  return res.rows[0]!.id;
}

async function makePage(n: number): Promise<number> {
  const res = await query<{ id: number }>(
    `INSERT INTO pages (confluence_id, space_key, title, body_html, body_text, version,
                        source, embedding_dirty, embedding_status, last_synced)
     VALUES (NULL, 'HOME', $1, '<p>x</p>', 'x', 1, 'standalone', FALSE, 'not_embedded', NOW())
     RETURNING id`,
    [`Page ${n}`],
  );
  return res.rows[0]!.id;
}

/** Rows actually persisted for a user — read independently of the GET route. */
async function pinnedRowCount(uid: string): Promise<number> {
  const res = await query<{ count: string }>(
    'SELECT COUNT(*) AS count FROM pinned_pages WHERE user_id = $1',
    [uid],
  );
  return Number(res.rows[0]!.count);
}

describe.skipIf(!dbAvailable)('pinned pages, unbounded (#1130) [integration]', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    await setupTestDb();

    app = Fastify({ logger: false });
    await app.register(sensible);
    app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
      if (error instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed' });
      }
      return reply.status(error.statusCode ?? 500).send({ error: error.message });
    });
    // The only stub in the file. `x-test-user` lets a case act as a second
    // account without rebuilding the app; everything else runs for real.
    app.decorate('authenticate', async (request: FastifyRequest) => {
      request.userId = (request.headers['x-test-user'] as string | undefined) ?? userId;
    });
    app.decorate('requireAdmin', async (request: FastifyRequest) => {
      request.userId = userId;
    });
    app.decorate('redis', {});
    await app.register(pinnedPagesRoutes, { prefix: '/api' });
    await app.ready();
  });

  beforeEach(async () => {
    await truncateAllTables();
    userId = await makeUser();
  });

  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  /** Drive the real endpoint, optionally as another account. */
  function pin(pageId: number, as: string = userId) {
    return app.inject({
      method: 'POST',
      url: `/api/pages/${pageId}/pin`,
      headers: { 'x-test-user': as },
    });
  }

  function listPinned(as: string = userId) {
    return app.inject({
      method: 'GET',
      url: '/api/pages/pinned',
      headers: { 'x-test-user': as },
    });
  }

  // The headline behaviour of #1130, executed through the handler that used to
  // refuse it. The ninth call is the one the old `MAX_PINS = 8` guard rejected
  // with `400 Maximum of 8 pinned articles allowed`, so it is asserted by
  // itself: put any count guard back in the route and this line goes red.
  it('accepts a ninth pin — and far more — through POST /api/pages/:id/pin', async () => {
    const pageIds: number[] = [];
    for (let i = 0; i < 25; i++) pageIds.push(await makePage(i));

    const statuses: number[] = [];
    for (const id of pageIds) {
      statuses.push((await pin(id)).statusCode);
    }

    expect(statuses[8]).toBe(200);
    expect(statuses).toEqual(Array(25).fill(200));
    expect(await pinnedRowCount(userId)).toBe(25);

    // The list endpoint hands back all 25 too — the cap left no residue there.
    const listed = JSON.parse((await listPinned()).body);
    expect(listed.total).toBe(25);
    expect(listed.items).toHaveLength(25);
  });

  // The route's `COALESCE(MAX(pin_order), 0) + 1` subquery, run over real rows
  // rather than described. Its ceiling is whatever the sequence reaches.
  it('gives each new pin the next pin_order with no ceiling', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await pin(await makePage(i))).statusCode).toBe(200);
    }

    const res = await query<{ pin_order: number }>(
      'SELECT pin_order FROM pinned_pages WHERE user_id = $1 ORDER BY pin_order ASC',
      [userId],
    );
    expect(res.rows.map((r) => r.pin_order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('is idempotent when the same page is pinned twice', async () => {
    const pageId = await makePage(1);

    expect((await pin(pageId)).statusCode).toBe(200);
    // Second call short-circuits on the already-pinned fast path.
    expect((await pin(pageId)).statusCode).toBe(200);

    expect(await pinnedRowCount(userId)).toBe(1);
  });

  // With the count guard gone, ON CONFLICT is the only thing standing between
  // two simultaneous pins of the same page and a unique violation: the
  // already-pinned SELECT is a fast path, not a lock, so requests fired
  // together can all read "not pinned" and all reach the INSERT. How far they
  // actually interleave is the scheduler's to decide, so what is asserted is
  // the contract that has to hold either way — every caller gets a 200 and
  // exactly one row lands. A handler that let a duplicate INSERT through
  // unguarded would surface the unique violation here as a 500.
  it('absorbs simultaneous pins of the same page instead of raising a unique violation', async () => {
    const pageId = await makePage(1);

    const responses = await Promise.all(Array.from({ length: 8 }, () => pin(pageId)));

    expect(responses.map((r) => r.statusCode)).toEqual(Array(8).fill(200));
    expect(await pinnedRowCount(userId)).toBe(1);
  });

  it("keeps each user's pins to themselves", async () => {
    const other = await makeUser();
    const mine = await makePage(1);
    const theirs = await makePage(2);

    expect((await pin(mine)).statusCode).toBe(200);
    expect((await pin(theirs, other)).statusCode).toBe(200);

    const myList = JSON.parse((await listPinned()).body);
    expect(myList.items.map((i: { id: string }) => i.id)).toEqual([String(mine)]);

    const theirList = JSON.parse((await listPinned(other)).body);
    expect(theirList.items.map((i: { id: string }) => i.id)).toEqual([String(theirs)]);

    expect(await pinnedRowCount(userId)).toBe(1);
    expect(await pinnedRowCount(other)).toBe(1);
  });

  // The excerpt is truncated by Postgres, not in JS: the row count is
  // unbounded now, and `body_text` is a TOASTed full-article column.
  it('returns a 200-character excerpt without shipping the whole body', async () => {
    const pageId = await makePage(1);
    await query('UPDATE pages SET body_text = $2 WHERE id = $1', [pageId, 'A'.repeat(5000)]);
    await pin(pageId);

    const body = JSON.parse((await listPinned()).body);
    expect(body.items[0].excerpt).toHaveLength(200);
  });
});
