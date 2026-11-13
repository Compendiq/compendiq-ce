import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { createClient, type RedisClientType } from 'redis';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { workerDatabaseName, workerIdFromEnv } from '../../test-worker-isolation.js';
import authPlugin, { generateAccessToken } from '../../core/plugins/auth.js';
import { setRedisClient } from '../../core/services/redis-cache.js';
import { contentAnalyticsRoutes } from './content-analytics.js';
import { pagesCrudRoutes } from './pages-crud.js';
import { insertUser, insertLocalSpace, insertStandalonePage } from './pages.test-helpers.js';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('Content Analytics (DB)', () => {
  let userId: string;
  let pageId: number;

  beforeAll(async () => {
    await setupTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();

    // Create a test user
    const userResult = await query<{ id: string }>(
      "INSERT INTO users (username, password_hash) VALUES ('analytics_user', 'hash') RETURNING id",
    );
    userId = userResult.rows[0].id;

    // Create a test page (pages requires space_key, title, confluence_id)
    const pageResult = await query<{ id: number }>(
      `INSERT INTO pages (confluence_id, space_key, title, body_text, last_modified_at)
       VALUES ('conf-1', 'DEV', 'Test Article', 'Some content here', NOW())
       RETURNING id`,
    );
    pageId = pageResult.rows[0].id;
  });

  // ── article_feedback table tests ─────────────────────────────────────────

  it('should create article_feedback table with migrations', async () => {
    const result = await query<{ exists: boolean }>(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'article_feedback'
      ) AS exists`,
    );
    expect(result.rows[0].exists).toBe(true);
  });

  it('should insert feedback for a page', async () => {
    await query(
      `INSERT INTO article_feedback (page_id, user_id, is_helpful, comment)
       VALUES ($1, $2, TRUE, 'Very useful article')`,
      [pageId, userId],
    );

    const result = await query<{
      is_helpful: boolean;
      comment: string;
    }>(
      'SELECT is_helpful, comment FROM article_feedback WHERE page_id = $1 AND user_id = $2',
      [pageId, userId],
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].is_helpful).toBe(true);
    expect(result.rows[0].comment).toBe('Very useful article');
  });

  it('should enforce unique constraint on (page_id, user_id)', async () => {
    await query(
      `INSERT INTO article_feedback (page_id, user_id, is_helpful)
       VALUES ($1, $2, TRUE)`,
      [pageId, userId],
    );

    // Second insert with same page_id + user_id should fail
    await expect(
      query(
        `INSERT INTO article_feedback (page_id, user_id, is_helpful)
         VALUES ($1, $2, FALSE)`,
        [pageId, userId],
      ),
    ).rejects.toThrow(/unique/i);
  });

  it('should support upsert for feedback changes', async () => {
    // Initial vote: helpful
    await query(
      `INSERT INTO article_feedback (page_id, user_id, is_helpful, comment)
       VALUES ($1, $2, TRUE, 'good')
       ON CONFLICT (page_id, user_id)
       DO UPDATE SET is_helpful = EXCLUDED.is_helpful,
                     comment    = EXCLUDED.comment,
                     updated_at = NOW()`,
      [pageId, userId],
    );

    // Change vote: not helpful
    await query(
      `INSERT INTO article_feedback (page_id, user_id, is_helpful, comment)
       VALUES ($1, $2, FALSE, 'outdated')
       ON CONFLICT (page_id, user_id)
       DO UPDATE SET is_helpful = EXCLUDED.is_helpful,
                     comment    = EXCLUDED.comment,
                     updated_at = NOW()`,
      [pageId, userId],
    );

    const result = await query<{ is_helpful: boolean; comment: string }>(
      'SELECT is_helpful, comment FROM article_feedback WHERE page_id = $1 AND user_id = $2',
      [pageId, userId],
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].is_helpful).toBe(false);
    expect(result.rows[0].comment).toBe('outdated');
  });

  it('should aggregate feedback counts per page', async () => {
    // Create a second user
    const user2 = await query<{ id: string }>(
      "INSERT INTO users (username, password_hash) VALUES ('user2', 'hash') RETURNING id",
    );
    const user2Id = user2.rows[0].id;

    // Two helpful, one not
    await query(
      'INSERT INTO article_feedback (page_id, user_id, is_helpful) VALUES ($1, $2, TRUE)',
      [pageId, userId],
    );
    await query(
      'INSERT INTO article_feedback (page_id, user_id, is_helpful) VALUES ($1, $2, FALSE)',
      [pageId, user2Id],
    );

    const result = await query<{
      helpful_count: string;
      not_helpful_count: string;
      total_count: string;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE is_helpful = TRUE)  AS helpful_count,
         COUNT(*) FILTER (WHERE is_helpful = FALSE) AS not_helpful_count,
         COUNT(*)                                    AS total_count
       FROM article_feedback WHERE page_id = $1`,
      [pageId],
    );

    expect(parseInt(result.rows[0].helpful_count, 10)).toBe(1);
    expect(parseInt(result.rows[0].not_helpful_count, 10)).toBe(1);
    expect(parseInt(result.rows[0].total_count, 10)).toBe(2);
  });

  it('should cascade delete feedback when page is deleted', async () => {
    await query(
      'INSERT INTO article_feedback (page_id, user_id, is_helpful) VALUES ($1, $2, TRUE)',
      [pageId, userId],
    );

    await query('DELETE FROM pages WHERE id = $1', [pageId]);

    const result = await query<{ count: string }>(
      'SELECT COUNT(*) as count FROM article_feedback WHERE page_id = $1',
      [pageId],
    );
    expect(parseInt(result.rows[0].count, 10)).toBe(0);
  });

  it('should cascade delete feedback when user is deleted', async () => {
    await query(
      'INSERT INTO article_feedback (page_id, user_id, is_helpful) VALUES ($1, $2, TRUE)',
      [pageId, userId],
    );

    await query('DELETE FROM users WHERE id = $1', [userId]);

    const result = await query<{ count: string }>(
      'SELECT COUNT(*) as count FROM article_feedback WHERE user_id = $1',
      [userId],
    );
    expect(parseInt(result.rows[0].count, 10)).toBe(0);
  });

  // ── page_views table tests ──────────────────────────────────────────────

  it('should create page_views table with migrations', async () => {
    const result = await query<{ exists: boolean }>(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'page_views'
      ) AS exists`,
    );
    expect(result.rows[0].exists).toBe(true);
  });

  it('should record page views', async () => {
    await query(
      'INSERT INTO page_views (page_id, user_id, session_id) VALUES ($1, $2, $3)',
      [pageId, userId, 'sess-abc'],
    );

    const result = await query<{ page_id: number; session_id: string }>(
      'SELECT page_id, session_id FROM page_views WHERE page_id = $1',
      [pageId],
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].session_id).toBe('sess-abc');
  });

  it('should allow multiple views from same user (different sessions)', async () => {
    await query(
      'INSERT INTO page_views (page_id, user_id, session_id) VALUES ($1, $2, $3)',
      [pageId, userId, 'sess-1'],
    );
    await query(
      'INSERT INTO page_views (page_id, user_id, session_id) VALUES ($1, $2, $3)',
      [pageId, userId, 'sess-2'],
    );

    const result = await query<{ count: string }>(
      'SELECT COUNT(*) as count FROM page_views WHERE page_id = $1',
      [pageId],
    );
    expect(parseInt(result.rows[0].count, 10)).toBe(2);
  });

  it('should support trending article aggregation', async () => {
    // Create a second page
    const page2 = await query<{ id: number }>(
      `INSERT INTO pages (confluence_id, space_key, title)
       VALUES ('conf-2', 'DEV', 'Second Article')
       RETURNING id`,
    );
    const page2Id = page2.rows[0].id;

    // Page 1 gets 3 views, page 2 gets 1 view
    for (let i = 0; i < 3; i++) {
      await query(
        'INSERT INTO page_views (page_id, user_id) VALUES ($1, $2)',
        [pageId, userId],
      );
    }
    await query(
      'INSERT INTO page_views (page_id, user_id) VALUES ($1, $2)',
      [page2Id, userId],
    );

    const result = await query<{
      page_id: number;
      view_count: string;
      title: string;
    }>(
      `SELECT pv.page_id, COUNT(*) AS view_count, cp.title
       FROM page_views pv
       JOIN pages cp ON cp.id = pv.page_id
       WHERE pv.viewed_at >= NOW() - INTERVAL '7 days'
       GROUP BY pv.page_id, cp.title
       ORDER BY COUNT(*) DESC`,
    );

    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].title).toBe('Test Article');
    expect(parseInt(result.rows[0].view_count, 10)).toBe(3);
    expect(result.rows[1].title).toBe('Second Article');
    expect(parseInt(result.rows[1].view_count, 10)).toBe(1);
  });

  it('should cascade delete views when page is deleted', async () => {
    await query(
      'INSERT INTO page_views (page_id, user_id) VALUES ($1, $2)',
      [pageId, userId],
    );

    await query('DELETE FROM pages WHERE id = $1', [pageId]);

    const result = await query<{ count: string }>(
      'SELECT COUNT(*) as count FROM page_views WHERE page_id = $1',
      [pageId],
    );
    expect(parseInt(result.rows[0].count, 10)).toBe(0);
  });

  it('should have indexes on page_views', async () => {
    const result = await query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE tablename = 'page_views'
       AND indexname IN ('idx_page_views_page', 'idx_page_views_user')`,
    );
    expect(result.rows).toHaveLength(2);
  });

  // ── content-quality dashboard query test ─────────────────────────────────

  it('should join pages with feedback and views for content quality dashboard', async () => {
    // Add feedback
    await query(
      'INSERT INTO article_feedback (page_id, user_id, is_helpful) VALUES ($1, $2, FALSE)',
      [pageId, userId],
    );

    // Add views
    await query(
      'INSERT INTO page_views (page_id, user_id) VALUES ($1, $2)',
      [pageId, userId],
    );

    const result = await query<{
      page_id: number;
      title: string;
      helpful_count: string;
      not_helpful_count: string;
      view_count: string;
    }>(
      `SELECT
         cp.id AS page_id,
         cp.title,
         COALESCE(fb.helpful_count, 0)     AS helpful_count,
         COALESCE(fb.not_helpful_count, 0)  AS not_helpful_count,
         COALESCE(pv.view_count, 0)         AS view_count
       FROM pages cp
       LEFT JOIN (
         SELECT page_id,
                COUNT(*) FILTER (WHERE is_helpful = TRUE)  AS helpful_count,
                COUNT(*) FILTER (WHERE is_helpful = FALSE) AS not_helpful_count
         FROM article_feedback GROUP BY page_id
       ) fb ON fb.page_id = cp.id
       LEFT JOIN (
         SELECT page_id, COUNT(*) AS view_count
         FROM page_views
         WHERE viewed_at >= NOW() - INTERVAL '30 days'
         GROUP BY page_id
       ) pv ON pv.page_id = cp.id
       WHERE cp.id = $1`,
      [pageId],
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].title).toBe('Test Article');
    expect(parseInt(result.rows[0].not_helpful_count as string, 10)).toBe(1);
    expect(parseInt(result.rows[0].view_count as string, 10)).toBe(1);
  });
});

describe('Content Analytics report trash eligibility (#1744)', () => {
  const spaceKey = 'ANALYTICS1744';
  const targetTitle = 'Report target #1744';
  const controlTitle = 'Private live control #1744';
  const quietTitle = 'Quiet live control #1744';
  const reports = [
    { name: 'trending', url: '/api/analytics/trending', arrayKey: 'articles' },
    { name: 'content-quality', url: '/api/analytics/content-quality', arrayKey: 'pages' },
  ] as const;
  type Report = (typeof reports)[number];
  type ReportPage = { pageId: number };
  interface ViewRow {
    id: number; page_id: number; user_id: string; session_id: string; viewed_at: Date;
  }
  interface FeedbackRow {
    id: number; page_id: number; user_id: string; is_helpful: boolean;
    comment: string; created_at: Date; updated_at: Date;
  }
  interface ActivitySnapshot {
    views: ViewRow[];
    feedback: FeedbackRow[];
  }

  let app: FastifyInstance | undefined;
  let redis: RedisClientType | undefined;
  let ownerId: string;
  let adminToken: string;
  let ownerToken: string;
  let targetId: number;
  let controlId: number;
  let quietId: number;
  let historicalActivity: ActivitySnapshot;

  beforeAll(async () => {
    // Missing infrastructure is not an eligibility regression or a passing skip.
    expect(dbAvailable, 'Real PostgreSQL is required for #1744').toBe(true);
    expect(await isRedisAvailable(), 'Real Redis is required for #1744').toBe(true);
    const workerId = workerIdFromEnv();
    const expectedDatabase = workerDatabaseName(workerId, process.env.TEST_DATABASE_NAMESPACE);
    expect(new URL(process.env.REDIS_URL!).pathname).toBe(`/${workerId}`);
    expect(new URL(process.env.POSTGRES_URL!).pathname).toBe(`/${expectedDatabase}`);
    // Do not print credential-bearing URLs even on an assertion failure.
    expect(process.env.POSTGRES_TEST_URL === process.env.POSTGRES_URL).toBe(true);
    await setupTestDb();
    const active = await query<{ database: string }>('SELECT current_database() AS database');
    expect(active.rows).toEqual([{ database: expectedDatabase }]);

    redis = createClient({
      url: process.env.REDIS_URL,
      socket: { reconnectStrategy: false, connectTimeout: 1_000 },
    }) as RedisClientType;
    await redis.connect();
    setRedisClient(redis);
    app = Fastify({ logger: false });
    app.decorate('redis', redis);
    await app.register(sensible);
    await app.register(authPlugin);
    await app.register(contentAnalyticsRoutes, { prefix: '/api' });
    await app.register(pagesCrudRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      setRedisClient(null);
      try {
        if (redis?.isOpen) await redis.quit();
      } finally {
        await teardownTestDb();
      }
    }
  });

  beforeEach(async () => {
    await truncateAllTables();
    const empty = await query<{ pages: number; views: number; feedback: number }>(
      `SELECT (SELECT COUNT(*)::int FROM pages) AS pages,
              (SELECT COUNT(*)::int FROM page_views) AS views,
              (SELECT COUNT(*)::int FROM article_feedback) AS feedback`,
    );
    expect(empty.rows).toEqual([{ pages: 0, views: 0, feedback: 0 }]);

    const suffix = randomUUID();
    const adminName = `analytics-admin-${suffix}`;
    const ownerName = `analytics-owner-${suffix}`;
    const controlOwnerName = `analytics-control-${suffix}`;
    const adminId = await insertUser(adminName);
    ownerId = await insertUser(ownerName);
    const controlOwnerId = await insertUser(controlOwnerName);
    await query('UPDATE users SET role = $1 WHERE id = $2', ['admin', adminId]);
    adminToken = await generateAccessToken({ sub: adminId, username: adminName, role: 'admin' });
    ownerToken = await generateAccessToken({ sub: ownerId, username: ownerName, role: 'user' });
    const controlToken = await generateAccessToken({
      sub: controlOwnerId, username: controlOwnerName, role: 'user',
    });

    await insertLocalSpace(spaceKey, ownerId);
    targetId = await insertStandalonePage(targetTitle, 'shared', ownerId, spaceKey);
    controlId = await insertStandalonePage(controlTitle, 'private', controlOwnerId, spaceKey);
    quietId = await insertStandalonePage(quietTitle, 'shared', ownerId, spaceKey);
    await query(
      `UPDATE pages
          SET last_modified_at = CASE WHEN id = $1 THEN NOW() - INTERVAL '90 days' ELSE NOW() END
        WHERE id = ANY($2::int[])`,
      [controlId, [targetId, controlId, quietId]],
    );
    await expectPageStates(false);

    for (const [token, sessionId] of [
      [ownerToken, `owner-first-${suffix}`],
      [ownerToken, `owner-second-${suffix}`],
      [adminToken, `admin-${suffix}`],
    ]) {
      const view = await app!.inject({
        method: 'POST', url: `/api/pages/${targetId}/view`,
        headers: { authorization: `Bearer ${token}` }, payload: { sessionId },
      });
      expect(view.statusCode).toBe(201);
      expect(view.json()).toEqual({ recorded: true });
    }
    const feedback = await app!.inject({
      method: 'POST', url: `/api/pages/${targetId}/feedback`,
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { isHelpful: false, comment: 'Needs revision #1744' },
    });
    expect(feedback.statusCode).toBe(201);
    const feedbackId = feedback.json<{ id: number }>().id;
    expect(feedbackId).toEqual(expect.any(Number));

    // This fourth persisted view must not enter either report's time window.
    await query(
      `INSERT INTO page_views (page_id, user_id, session_id, viewed_at)
       VALUES ($1, $2, $3, NOW() - INTERVAL '31 days')`,
      [targetId, ownerId, `old-${suffix}`],
    );
    const controlView = await app!.inject({
      method: 'POST', url: `/api/pages/${controlId}/view`,
      headers: { authorization: `Bearer ${controlToken}` },
      payload: { sessionId: `control-${suffix}` },
    });
    expect(controlView.statusCode).toBe(201);
    expect(controlView.json()).toEqual({ recorded: true });

    historicalActivity = await readActivity();
    expect(historicalActivity.views).toHaveLength(4);
    expect(historicalActivity.feedback).toHaveLength(1);
    expect(historicalActivity.feedback[0]).toMatchObject({
      id: feedbackId, page_id: targetId, user_id: ownerId,
      is_helpful: false, comment: 'Needs revision #1744',
    });
  });

  async function readActivity(): Promise<ActivitySnapshot> {
    const [views, feedback] = await Promise.all([
      query<ViewRow>(
        `SELECT id, page_id, user_id, session_id, viewed_at
           FROM page_views WHERE page_id = $1 ORDER BY id`,
        [targetId],
      ),
      query<FeedbackRow>(
        `SELECT id, page_id, user_id, is_helpful, comment, created_at, updated_at
           FROM article_feedback WHERE page_id = $1 ORDER BY id`,
        [targetId],
      ),
    ]);
    return { views: views.rows, feedback: feedback.rows };
  }

  async function expectPageStates(targetTrashed: boolean) {
    // Whole-relation assertions exclude unseen seeded pages from the ranking proof.
    const pages = await query<{ id: number; deleted_at: Date | null }>(
      'SELECT id, deleted_at FROM pages ORDER BY id',
    );
    expect(pages.rows.map((page) => page.id)).toEqual(
      [targetId, controlId, quietId].sort((a, b) => a - b),
    );
    for (const page of pages.rows) {
      if (page.id === targetId && targetTrashed) {
        expect(page.deleted_at).toBeInstanceOf(Date);
      } else {
        expect(page.deleted_at).toBeNull();
      }
    }
  }

  async function readReport(report: Report, limit = 100): Promise<ReportPage[]> {
    const response = await app!.inject({
      method: 'GET', url: `${report.url}?limit=${limit}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      articles?: ReportPage[]; pages?: ReportPage[]; periodDays?: number;
    }>();
    if (report.name === 'trending') expect(body.periodDays).toBe(7);
    const items = body[report.arrayKey];
    expect(Array.isArray(items)).toBe(true);
    return items!;
  }

  async function expectLiveReport(report: Report): Promise<ReportPage[]> {
    const items = await readReport(report);
    const target = {
      pageId: targetId, title: targetTitle, spaceKey, confluenceId: null, viewCount: 3,
    };
    const control = {
      pageId: controlId, title: controlTitle, spaceKey, confluenceId: null, viewCount: 1,
    };
    const expected = report.name === 'trending'
      ? [{ ...target, uniqueViewers: 2 }, { ...control, uniqueViewers: 1 }]
      : [
          { ...target, helpful: 0, notHelpful: 1, totalFeedback: 1 },
          { ...control, helpful: 0, notHelpful: 0, totalFeedback: 0 },
          {
            pageId: quietId, title: quietTitle, spaceKey, confluenceId: null,
            viewCount: 0, helpful: 0, notHelpful: 0, totalFeedback: 0,
          },
        ];
    expect(items.map((item) => item.pageId)).toEqual(expected.map((item) => item.pageId));
    expect(items).toMatchObject(expected);
    return items;
  }

  async function trashTarget() {
    const response = await app!.inject({
      method: 'DELETE', url: `/api/pages/${targetId}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ message: 'Page moved to trash' });
    await expectPageStates(true);
    expect(await readActivity()).toEqual(historicalActivity);
  }

  it.each(reports)('$name excludes trashed pages while preserving live articles', async (report) => {
    const initial = await expectLiveReport(report);
    await trashTarget();

    const items = await readReport(report);
    expect(items.map((item) => item.pageId)).not.toContain(targetId);
    expect(items).toEqual(initial.filter((item) => item.pageId !== targetId));
  });

  it.each(reports)('$name filters trash before applying limit', async (report) => {
    await expectLiveReport(report);
    const initial = await readReport(report, 1);
    expect(initial.map((item) => item.pageId)).toEqual([targetId]);
    await trashTarget();

    const items = await readReport(report, 1);
    expect(items.map((item) => item.pageId)).toEqual([controlId]);
  });

  // Independent preservation controls: these should already pass before the SQL fix.
  it.each(reports)('$name reuses historical activity when a page is restored', async (report) => {
    const initial = await expectLiveReport(report);
    await trashTarget();
    const restore = await app!.inject({
      method: 'POST', url: `/api/pages/${targetId}/restore`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(restore.statusCode).toBe(200);
    expect(restore.json()).toEqual({ id: targetId, title: targetTitle, restored: true });
    await expectPageStates(false);
    expect(await readActivity()).toEqual(historicalActivity);
    expect(await expectLiveReport(report)).toEqual(initial);
  });

  it.each(reports)('$name rejects unauthenticated callers', async (report) => {
    const response = await app!.inject({ method: 'GET', url: report.url });
    expect(response.statusCode).toBe(401);
    expect(response.json()).not.toHaveProperty(report.arrayKey);
    expect(response.body).not.toContain(targetTitle);
    expect(response.body).not.toContain(controlTitle);
    expect(response.body).not.toContain(quietTitle);
  });

  it.each(reports)('$name rejects authenticated non-admin callers', async (report) => {
    const response = await app!.inject({
      method: 'GET', url: report.url,
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ message: 'Admin access required' });
    expect(response.json()).not.toHaveProperty(report.arrayKey);
    expect(response.body).not.toContain(targetTitle);
    expect(response.body).not.toContain(controlTitle);
    expect(response.body).not.toContain(quietTitle);
  });
});
