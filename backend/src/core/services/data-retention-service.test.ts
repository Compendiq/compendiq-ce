import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockPool = {
  query: vi.fn(),
};

vi.mock('../db/postgres.js', () => ({
  getPool: () => mockPool,
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// #264 — ADMIN_ACCESS_DENIED purge runs inside `runRetentionCleanup`; stub the
// getter to a known value so the mocked DELETE loop is deterministic.
vi.mock('./admin-settings-service.js', () => ({
  getAdminAccessDeniedRetentionDays: vi.fn().mockResolvedValue(90),
}));

import { runRetentionCleanup, startRetentionWorker, stopRetentionWorker, RETENTION_DEFAULTS } from './data-retention-service.js';

describe('data-retention-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    stopRetentionWorker();
    // Clean up env var overrides
    delete process.env.RETENTION_AUDIT_LOG_DAYS;
    delete process.env.RETENTION_SEARCH_ANALYTICS_DAYS;
    delete process.env.RETENTION_ERROR_LOG_DAYS;
    delete process.env.RETENTION_VERSIONS_MAX;
  });

  describe('RETENTION_DEFAULTS', () => {
    it('exports sensible default retention periods', () => {
      expect(RETENTION_DEFAULTS.audit_log).toBe(365);
      expect(RETENTION_DEFAULTS.search_analytics).toBe(90);
      expect(RETENTION_DEFAULTS.error_log).toBe(30);
      expect(RETENTION_DEFAULTS.page_versions).toBe(50);
    });
  });

  describe('runRetentionCleanup', () => {
    it('deletes old rows from time-based tables and excess page_versions', async () => {
      mockPool.query
        // audit_log
        .mockResolvedValueOnce({ rowCount: 10 })
        // search_analytics
        .mockResolvedValueOnce({ rowCount: 5 })
        // error_log
        .mockResolvedValueOnce({ rowCount: 3 })
        // ADMIN_ACCESS_DENIED targeted purge (#264) — short batch signals drained
        .mockResolvedValueOnce({ rowCount: 0 })
        // page_versions
        .mockResolvedValueOnce({ rowCount: 2 });

      const results = await runRetentionCleanup();

      expect(results.audit_log).toBe(10);
      expect(results.search_analytics).toBe(5);
      expect(results.error_log).toBe(3);
      expect(results.page_versions).toBe(2);
      expect(results.audit_log_admin_access_denied).toBe(0);
    });

    it('uses parameterized queries for time-based tables', async () => {
      mockPool.query.mockResolvedValue({ rowCount: 0 });

      await runRetentionCleanup();

      // 3 umbrella time-based + 1 ADMIN_ACCESS_DENIED targeted + 1 count-based = 5
      expect(mockPool.query).toHaveBeenCalledTimes(5);

      // Verify audit_log uses default 365 days
      const auditCall = mockPool.query.mock.calls[0];
      expect(auditCall[0]).toContain('DELETE FROM audit_log');
      expect(auditCall[1]).toEqual([365]);

      // Verify search_analytics uses default 90 days
      const searchCall = mockPool.query.mock.calls[1];
      expect(searchCall[0]).toContain('DELETE FROM search_analytics');
      expect(searchCall[1]).toEqual([90]);

      // Verify error_log uses default 30 days
      const errorCall = mockPool.query.mock.calls[2];
      expect(errorCall[0]).toContain('DELETE FROM error_log');
      expect(errorCall[1]).toEqual([30]);

      // #264 — ADMIN_ACCESS_DENIED purge uses the getter value (stubbed to 90)
      // and the 10_000 batch size. Narrower than the umbrella sweep.
      const deniedCall = mockPool.query.mock.calls[3];
      expect(deniedCall[0]).toContain(`action = 'ADMIN_ACCESS_DENIED'`);
      expect(deniedCall[0]).toContain('LIMIT $2');
      expect(deniedCall[1]).toEqual([90, 10_000]);
    });

    it('uses ROW_NUMBER for count-based page_versions cleanup', async () => {
      mockPool.query.mockResolvedValue({ rowCount: 0 });

      await runRetentionCleanup();

      // Now at index 4 (umbrella audit_log, search_analytics, error_log,
      // ADMIN_ACCESS_DENIED targeted, page_versions).
      const versionsCall = mockPool.query.mock.calls[4];
      expect(versionsCall[0]).toContain('ROW_NUMBER()');
      expect(versionsCall[0]).toContain('PARTITION BY page_id');
      expect(versionsCall[1]).toEqual([50]);
    });

    it('respects env var overrides', async () => {
      process.env.RETENTION_AUDIT_LOG_DAYS = '7';
      process.env.RETENTION_VERSIONS_MAX = '10';
      mockPool.query.mockResolvedValue({ rowCount: 0 });

      await runRetentionCleanup();

      // Audit log should use overridden value
      const auditCall = mockPool.query.mock.calls[0];
      expect(auditCall[1]).toEqual([7]);

      // page_versions should use overridden max (now at index 4)
      const versionsCall = mockPool.query.mock.calls[4];
      expect(versionsCall[1]).toEqual([10]);
    });

    it('handles query errors gracefully and returns 0 for failed tables', async () => {
      mockPool.query
        .mockRejectedValueOnce(new Error('table does not exist')) // audit_log
        .mockResolvedValueOnce({ rowCount: 5 })                    // search_analytics
        .mockResolvedValueOnce({ rowCount: 3 })                    // error_log
        .mockResolvedValueOnce({ rowCount: 0 })                    // ADMIN_ACCESS_DENIED (#264)
        .mockResolvedValueOnce({ rowCount: 0 });                   // page_versions

      const results = await runRetentionCleanup();

      expect(results.audit_log).toBe(0);
      expect(results.search_analytics).toBe(5);
      expect(results.error_log).toBe(3);
      expect(results.page_versions).toBe(0);
      expect(results.audit_log_admin_access_denied).toBe(0);
    });

    it('handles null rowCount gracefully', async () => {
      mockPool.query.mockResolvedValue({ rowCount: null });

      const results = await runRetentionCleanup();

      expect(results.audit_log).toBe(0);
      expect(results.search_analytics).toBe(0);
      expect(results.error_log).toBe(0);
      expect(results.page_versions).toBe(0);
      expect(results.audit_log_admin_access_denied).toBe(0);
    });

    // ─── #264 — ADMIN_ACCESS_DENIED targeted purge ────────────────────────
    it('reports rows deleted by the ADMIN_ACCESS_DENIED purge', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rowCount: 0 }) // audit_log
        .mockResolvedValueOnce({ rowCount: 0 }) // search_analytics
        .mockResolvedValueOnce({ rowCount: 0 }) // error_log
        .mockResolvedValueOnce({ rowCount: 42 }) // ADMIN_ACCESS_DENIED batch 1 (short — drained)
        .mockResolvedValueOnce({ rowCount: 0 }); // page_versions

      const results = await runRetentionCleanup();
      expect(results.audit_log_admin_access_denied).toBe(42);
    });

    it('loops the ADMIN_ACCESS_DENIED purge in 10_000-row batches until drained', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rowCount: 0 }) // audit_log
        .mockResolvedValueOnce({ rowCount: 0 }) // search_analytics
        .mockResolvedValueOnce({ rowCount: 0 }) // error_log
        .mockResolvedValueOnce({ rowCount: 10_000 }) // batch 1 full — loop again
        .mockResolvedValueOnce({ rowCount: 10_000 }) // batch 2 full — loop again
        .mockResolvedValueOnce({ rowCount: 1234 })  // batch 3 short — drained
        .mockResolvedValueOnce({ rowCount: 0 });    // page_versions

      const results = await runRetentionCleanup();
      expect(results.audit_log_admin_access_denied).toBe(21_234);
    });

    it('swallows errors inside the ADMIN_ACCESS_DENIED purge and reports 0', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rowCount: 0 }) // audit_log
        .mockResolvedValueOnce({ rowCount: 0 }) // search_analytics
        .mockResolvedValueOnce({ rowCount: 0 }) // error_log
        .mockRejectedValueOnce(new Error('lock timeout')) // ADMIN_ACCESS_DENIED
        .mockResolvedValueOnce({ rowCount: 0 }); // page_versions

      const results = await runRetentionCleanup();
      expect(results.audit_log_admin_access_denied).toBe(0);
      // Adjacent sweeps still complete.
      expect(results.page_versions).toBe(0);
    });
  });

  describe('worker lifecycle', () => {
    it('startRetentionWorker is idempotent (second call is no-op)', () => {
      vi.useFakeTimers();
      startRetentionWorker(1);
      startRetentionWorker(1); // second call should not create another interval
      vi.useRealTimers();
      stopRetentionWorker();
    });

    it('stopRetentionWorker clears the interval', () => {
      vi.useFakeTimers();
      startRetentionWorker(1);
      stopRetentionWorker();
      // Calling stop again should not throw
      stopRetentionWorker();
      vi.useRealTimers();
    });
  });
});
