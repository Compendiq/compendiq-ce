import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';

import {
  setupTestDb,
  truncateAllTables,
  teardownTestDb,
  isDbAvailable,
} from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';

/**
 * Real-DB integration tests for removing the 8-pin cap (#1130).
 *
 * The route tests in `pinned-pages.test.ts` mock `core/db/postgres.js`
 * wholesale, so they can only assert the *text* of the SQL — they can never
 * show that a ninth pin actually lands, which is the entire point of the
 * change. These run the route's own statements against the test Postgres
 * (port 5433) so the behaviour is demonstrated rather than described.
 */

const dbAvailable = await isDbAvailable();

/** Verbatim copy of the INSERT in `pinned-pages.ts`. */
const PIN_SQL = `INSERT INTO pinned_pages (user_id, page_id, pin_order, pinned_at)
       SELECT $1, $2, COALESCE((SELECT MAX(pin_order) FROM pinned_pages WHERE user_id = $1), 0) + 1, NOW()
       ON CONFLICT (user_id, page_id) DO NOTHING`;

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
     VALUES ($1, 'HOME', $2, '<p>x</p>', 'x', 1, 'standalone', FALSE, 'not_embedded', NOW())
     RETURNING id`,
    [`standalone-pin-${n}`, `Page ${n}`],
  );
  return res.rows[0]!.id;
}

async function pin(pageId: number): Promise<number> {
  const res = await query(PIN_SQL, [userId, pageId]);
  return res.rowCount ?? 0;
}

describe.skipIf(!dbAvailable)('pinned pages, unbounded (#1130) [integration]', () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    userId = await makeUser();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  // The headline behaviour of #1130, executed rather than string-matched.
  it('accepts far more than the old cap of eight', async () => {
    const pageIds: number[] = [];
    for (let i = 0; i < 25; i++) pageIds.push(await makePage(i));

    for (const id of pageIds) {
      expect(await pin(id)).toBe(1);
    }

    const count = await query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM pinned_pages WHERE user_id = $1',
      [userId],
    );
    expect(Number(count.rows[0]!.count)).toBe(25);
  });

  // With the count guard gone, ON CONFLICT is the only thing standing between
  // two simultaneous pins of the same page and a unique violation. A rowCount
  // of 0 therefore means "someone else got there first", which is success.
  it('absorbs a duplicate pin instead of raising a unique violation', async () => {
    const pageId = await makePage(1);

    expect(await pin(pageId)).toBe(1);
    expect(await pin(pageId)).toBe(0);

    const count = await query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM pinned_pages WHERE user_id = $1',
      [userId],
    );
    expect(Number(count.rows[0]!.count)).toBe(1);
  });

  it('survives concurrent pins of the same page', async () => {
    const pageId = await makePage(1);

    const results = await Promise.all([pin(pageId), pin(pageId), pin(pageId)]);

    // Exactly one insert wins; the rest are absorbed, none throw.
    expect(results.filter((n) => n === 1)).toHaveLength(1);
    const count = await query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM pinned_pages WHERE user_id = $1',
      [userId],
    );
    expect(Number(count.rows[0]!.count)).toBe(1);
  });

  it('keeps each user\'s pins to themselves', async () => {
    const other = await makeUser();
    const pageId = await makePage(1);

    await pin(pageId);
    await query(PIN_SQL, [other, pageId]);

    const mine = await query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM pinned_pages WHERE user_id = $1',
      [userId],
    );
    expect(Number(mine.rows[0]!.count)).toBe(1);
  });

  // The excerpt is truncated by Postgres, not in JS: the row count is
  // unbounded now, and `body_text` is a TOASTed full-article column.
  it('returns a 200-character excerpt without shipping the whole body', async () => {
    const pageId = await makePage(1);
    await query('UPDATE pages SET body_text = $2 WHERE id = $1', [pageId, 'A'.repeat(5000)]);
    await pin(pageId);

    const res = await query<{ body_text: string }>(
      `SELECT substring(cp.body_text, 1, 200) AS body_text
         FROM pinned_pages pp JOIN pages cp ON cp.id = pp.page_id
        WHERE pp.user_id = $1`,
      [userId],
    );
    expect(res.rows[0]!.body_text).toHaveLength(200);
  });
});
