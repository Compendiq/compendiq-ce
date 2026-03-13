import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../test-db-helper.js';
import { query } from '../../core/db/postgres.js';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('Verification system (DB)', () => {
  let userId: string;
  let otherUserId: string;
  let confluenceId: string;

  beforeAll(async () => {
    await setupTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();

    // Create test users
    const userResult = await query<{ id: string }>(
      "INSERT INTO users (username, password_hash) VALUES ('verify_user', 'hash') RETURNING id",
    );
    userId = userResult.rows[0].id;

    const otherUserResult = await query<{ id: string }>(
      "INSERT INTO users (username, password_hash) VALUES ('owner_user', 'hash') RETURNING id",
    );
    otherUserId = otherUserResult.rows[0].id;

    // Create a test page
    confluenceId = 'test-page-1';
    await query(
      `INSERT INTO cached_pages
         (confluence_id, space_key, title, version, embedding_dirty, embedding_status)
       VALUES ($1, 'TEST', 'Test Page', 1, FALSE, 'not_embedded')`,
      [confluenceId],
    );
  });

  it('should add verification columns via migration', async () => {
    const result = await query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'cached_pages'
         AND column_name IN ('owner_id', 'review_interval_days', 'next_review_at', 'verified_by', 'verified_at')
       ORDER BY column_name`,
    );
    const cols = result.rows.map((r) => r.column_name);
    expect(cols).toContain('owner_id');
    expect(cols).toContain('review_interval_days');
    expect(cols).toContain('next_review_at');
    expect(cols).toContain('verified_by');
    expect(cols).toContain('verified_at');
  });

  it('should default review_interval_days to 90', async () => {
    const result = await query<{ review_interval_days: number }>(
      'SELECT review_interval_days FROM cached_pages WHERE confluence_id = $1',
      [confluenceId],
    );
    expect(result.rows[0].review_interval_days).toBe(90);
  });

  it('should verify a page and compute next_review_at', async () => {
    // Verify the page
    await query(
      `UPDATE cached_pages SET
        verified_by = $1,
        verified_at = NOW(),
        next_review_at = NOW() + (review_interval_days || ' days')::INTERVAL
       WHERE confluence_id = $2`,
      [userId, confluenceId],
    );

    const result = await query<{
      verified_by: string;
      verified_at: Date;
      next_review_at: Date;
      review_interval_days: number;
    }>(
      'SELECT verified_by, verified_at, next_review_at, review_interval_days FROM cached_pages WHERE confluence_id = $1',
      [confluenceId],
    );

    const row = result.rows[0];
    expect(row.verified_by).toBe(userId);
    expect(row.verified_at).toBeInstanceOf(Date);
    expect(row.next_review_at).toBeInstanceOf(Date);

    // next_review_at should be approximately 90 days after verified_at
    const diffMs = row.next_review_at.getTime() - row.verified_at.getTime();
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeCloseTo(90, 0);
  });

  it('should assign an owner', async () => {
    await query(
      'UPDATE cached_pages SET owner_id = $1 WHERE confluence_id = $2',
      [otherUserId, confluenceId],
    );

    const result = await query<{ owner_id: string }>(
      'SELECT owner_id FROM cached_pages WHERE confluence_id = $1',
      [confluenceId],
    );
    expect(result.rows[0].owner_id).toBe(otherUserId);
  });

  it('should set owner_id to NULL when owner user is deleted', async () => {
    await query(
      'UPDATE cached_pages SET owner_id = $1 WHERE confluence_id = $2',
      [otherUserId, confluenceId],
    );

    // Delete the owner user
    await query('DELETE FROM users WHERE id = $1', [otherUserId]);

    const result = await query<{ owner_id: string | null }>(
      'SELECT owner_id FROM cached_pages WHERE confluence_id = $1',
      [confluenceId],
    );
    expect(result.rows[0].owner_id).toBeNull();
  });

  it('should set verified_by to NULL when verifier user is deleted', async () => {
    await query(
      `UPDATE cached_pages SET verified_by = $1, verified_at = NOW(),
        next_review_at = NOW() + INTERVAL '90 days'
       WHERE confluence_id = $2`,
      [userId, confluenceId],
    );

    await query('DELETE FROM users WHERE id = $1', [userId]);

    const result = await query<{ verified_by: string | null }>(
      'SELECT verified_by FROM cached_pages WHERE confluence_id = $1',
      [confluenceId],
    );
    expect(result.rows[0].verified_by).toBeNull();
  });

  it('should update review_interval_days and recalculate next_review_at', async () => {
    // First verify the page
    await query(
      `UPDATE cached_pages SET
        verified_by = $1,
        verified_at = NOW(),
        next_review_at = NOW() + INTERVAL '90 days'
       WHERE confluence_id = $2`,
      [userId, confluenceId],
    );

    // Update interval to 30 days
    await query(
      `UPDATE cached_pages SET
        review_interval_days = 30,
        next_review_at = CASE
          WHEN verified_at IS NOT NULL THEN verified_at + INTERVAL '30 days'
          ELSE next_review_at
        END
       WHERE confluence_id = $1`,
      [confluenceId],
    );

    const result = await query<{
      review_interval_days: number;
      verified_at: Date;
      next_review_at: Date;
    }>(
      'SELECT review_interval_days, verified_at, next_review_at FROM cached_pages WHERE confluence_id = $1',
      [confluenceId],
    );

    expect(result.rows[0].review_interval_days).toBe(30);
    const diffMs = result.rows[0].next_review_at.getTime() - result.rows[0].verified_at.getTime();
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeCloseTo(30, 0);
  });

  it('should compute verification-health stats correctly', async () => {
    // Create additional pages with different staleness states
    // Page 2: fresh (next_review_at > NOW() + 14 days)
    await query(
      `INSERT INTO cached_pages
         (confluence_id, space_key, title, version, embedding_dirty, embedding_status,
          verified_by, verified_at, next_review_at)
       VALUES ('page-fresh', 'TEST', 'Fresh Page', 1, FALSE, 'not_embedded',
               $1, NOW(), NOW() + INTERVAL '30 days')`,
      [userId],
    );

    // Page 3: aging (next_review_at between NOW() and NOW() + 14 days)
    await query(
      `INSERT INTO cached_pages
         (confluence_id, space_key, title, version, embedding_dirty, embedding_status,
          verified_by, verified_at, next_review_at)
       VALUES ('page-aging', 'TEST', 'Aging Page', 1, FALSE, 'not_embedded',
               $1, NOW() - INTERVAL '80 days', NOW() + INTERVAL '5 days')`,
      [userId],
    );

    // Page 4: overdue (next_review_at < NOW())
    await query(
      `INSERT INTO cached_pages
         (confluence_id, space_key, title, version, embedding_dirty, embedding_status,
          verified_by, verified_at, next_review_at)
       VALUES ('page-overdue', 'TEST', 'Overdue Page', 1, FALSE, 'not_embedded',
               $1, NOW() - INTERVAL '100 days', NOW() - INTERVAL '10 days')`,
      [userId],
    );

    // Page 1 (from beforeEach) is unverified (next_review_at IS NULL)

    const result = await query<{
      fresh: string;
      aging: string;
      overdue: string;
      unverified: string;
      total: string;
    }>(
      `SELECT
        COUNT(*) FILTER (WHERE next_review_at > NOW() + INTERVAL '14 days') AS fresh,
        COUNT(*) FILTER (WHERE next_review_at BETWEEN NOW() AND NOW() + INTERVAL '14 days') AS aging,
        COUNT(*) FILTER (WHERE next_review_at < NOW()) AS overdue,
        COUNT(*) FILTER (WHERE next_review_at IS NULL) AS unverified,
        COUNT(*) AS total
       FROM cached_pages`,
    );

    const row = result.rows[0];
    expect(parseInt(row.fresh, 10)).toBe(1);
    expect(parseInt(row.aging, 10)).toBe(1);
    expect(parseInt(row.overdue, 10)).toBe(1);
    expect(parseInt(row.unverified, 10)).toBe(1);
    expect(parseInt(row.total, 10)).toBe(4);
  });

  it('should create partial indexes for verification queries', async () => {
    const result = await query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE tablename = 'cached_pages'
         AND indexname IN ('pages_next_review_idx', 'pages_owner_idx')
       ORDER BY indexname`,
    );
    const indexNames = result.rows.map((r) => r.indexname);
    expect(indexNames).toContain('pages_next_review_idx');
    expect(indexNames).toContain('pages_owner_idx');
  });
});
