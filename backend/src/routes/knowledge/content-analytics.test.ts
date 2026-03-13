import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../test-db-helper.js';
import { query } from '../../core/db/postgres.js';

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

    // Create a test page (cached_pages requires space_key, title, confluence_id)
    const pageResult = await query<{ id: number }>(
      `INSERT INTO cached_pages (confluence_id, space_key, title, body_text, last_modified_at)
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

    await query('DELETE FROM cached_pages WHERE id = $1', [pageId]);

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
      `INSERT INTO cached_pages (confluence_id, space_key, title)
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
       JOIN cached_pages cp ON cp.id = pv.page_id
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

    await query('DELETE FROM cached_pages WHERE id = $1', [pageId]);

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
       FROM cached_pages cp
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
