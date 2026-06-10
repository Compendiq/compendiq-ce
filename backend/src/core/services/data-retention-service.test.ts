import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockPool = {
  query: vi.fn(),
};

vi.mock('../db/postgres.js', () => ({
  getPool: () => mockPool,
  query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// #264 — ADMIN_ACCESS_DENIED purge runs inside `runRetentionCleanup`; stub the
// getter to a known value so the mocked DELETE loop is deterministic.
vi.mock('./admin-settings-service.js', () => ({
  getAdminAccessDeniedRetentionDays: vi.fn().mockResolvedValue(90),
}));

// #307 Finding #4: retention heartbeat test spy on audit-service emissions.
vi.mock('./audit-service.js', () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

import {
  runRetentionCleanup,
  startRetentionWorker,
  stopRetentionWorker,
  RETENTION_DEFAULTS,
  STANDALONE_TRASH_RETENTION_DAYS,
} from './data-retention-service.js';
import { logAuditEvent as mockLogAuditEvent } from './audit-service.js';

// pool.query call order inside runRetentionCleanup (pending_sync_versions is
// absent: its retention-days getter is not mocked above, so that sweep skips
// before touching the pool):
//   [0] audit_log  [1] search_analytics  [2] error_log
//   [3..] ADMIN_ACCESS_DENIED batches (#264)
//   [next] standalone trash purge (UX review)
//   [last] page_versions

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

    it('keeps the standalone trash window at the 30 days the Trash UI promises', () => {
      expect(STANDALONE_TRASH_RETENTION_DAYS).toBe(30);
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
        // standalone trash purge
        .mockResolvedValueOnce({ rowCount: 4 })
        // page_versions
        .mockResolvedValueOnce({ rowCount: 2 });

      const results = await runRetentionCleanup();

      expect(results.audit_log).toBe(10);
      expect(results.search_analytics).toBe(5);
      expect(results.error_log).toBe(3);
      expect(results.page_versions).toBe(2);
      expect(results.audit_log_admin_access_denied).toBe(0);
      expect(results.pages_standalone_trash).toBe(4);
    });

    it('uses parameterized queries for time-based tables', async () => {
      mockPool.query.mockResolvedValue({ rowCount: 0 });

      await runRetentionCleanup();

      // 3 umbrella time-based + 1 ADMIN_ACCESS_DENIED targeted
      // + 1 standalone trash purge + 1 count-based = 6
      expect(mockPool.query).toHaveBeenCalledTimes(6);

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

      // Standalone trash purge is source-scoped and parameterized on the
      // 30-day window — never touches Confluence-synced rows.
      const trashCall = mockPool.query.mock.calls[4];
      expect(trashCall[0]).toContain('DELETE FROM pages');
      expect(trashCall[0]).toContain(`source = 'standalone'`);
      expect(trashCall[1]).toEqual([STANDALONE_TRASH_RETENTION_DAYS]);
    });

    it('uses ROW_NUMBER for count-based page_versions cleanup', async () => {
      mockPool.query.mockResolvedValue({ rowCount: 0 });

      await runRetentionCleanup();

      // Now at index 5 (umbrella audit_log, search_analytics, error_log,
      // ADMIN_ACCESS_DENIED targeted, standalone trash purge, page_versions).
      const versionsCall = mockPool.query.mock.calls[5];
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

      // page_versions should use overridden max (now at index 5)
      const versionsCall = mockPool.query.mock.calls[5];
      expect(versionsCall[1]).toEqual([10]);
    });

    it('handles query errors gracefully and returns 0 for failed tables', async () => {
      mockPool.query
        .mockRejectedValueOnce(new Error('table does not exist')) // audit_log
        .mockResolvedValueOnce({ rowCount: 5 })                    // search_analytics
        .mockResolvedValueOnce({ rowCount: 3 })                    // error_log
        .mockResolvedValueOnce({ rowCount: 0 })                    // ADMIN_ACCESS_DENIED (#264)
        .mockResolvedValueOnce({ rowCount: 0 })                    // standalone trash purge
        .mockResolvedValueOnce({ rowCount: 0 });                   // page_versions

      const results = await runRetentionCleanup();

      expect(results.audit_log).toBe(0);
      expect(results.search_analytics).toBe(5);
      expect(results.error_log).toBe(3);
      expect(results.page_versions).toBe(0);
      expect(results.audit_log_admin_access_denied).toBe(0);
      expect(results.pages_standalone_trash).toBe(0);
    });

    it('handles null rowCount gracefully', async () => {
      mockPool.query.mockResolvedValue({ rowCount: null });

      const results = await runRetentionCleanup();

      expect(results.audit_log).toBe(0);
      expect(results.search_analytics).toBe(0);
      expect(results.error_log).toBe(0);
      expect(results.page_versions).toBe(0);
      expect(results.audit_log_admin_access_denied).toBe(0);
      expect(results.pages_standalone_trash).toBe(0);
    });

    // ─── #264 — ADMIN_ACCESS_DENIED targeted purge ────────────────────────
    it('reports rows deleted by the ADMIN_ACCESS_DENIED purge', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rowCount: 0 }) // audit_log
        .mockResolvedValueOnce({ rowCount: 0 }) // search_analytics
        .mockResolvedValueOnce({ rowCount: 0 }) // error_log
        .mockResolvedValueOnce({ rowCount: 42 }) // ADMIN_ACCESS_DENIED batch 1 (short — drained)
        .mockResolvedValueOnce({ rowCount: 0 }) // standalone trash purge
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
        .mockResolvedValueOnce({ rowCount: 0 })     // standalone trash purge
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
        .mockResolvedValueOnce({ rowCount: 7 }) // standalone trash purge
        .mockResolvedValueOnce({ rowCount: 0 }); // page_versions

      const results = await runRetentionCleanup();
      expect(results.audit_log_admin_access_denied).toBe(0);
      // Adjacent sweeps still complete.
      expect(results.pages_standalone_trash).toBe(7);
      expect(results.page_versions).toBe(0);
    });

    // ─── Standalone trash purge (UX review) ──────────────────────────────
    it('swallows errors inside the standalone trash purge and reports 0', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rowCount: 0 }) // audit_log
        .mockResolvedValueOnce({ rowCount: 0 }) // search_analytics
        .mockResolvedValueOnce({ rowCount: 0 }) // error_log
        .mockResolvedValueOnce({ rowCount: 0 }) // ADMIN_ACCESS_DENIED drained
        .mockRejectedValueOnce(new Error('lock timeout')) // standalone trash purge
        .mockResolvedValueOnce({ rowCount: 2 }); // page_versions

      const results = await runRetentionCleanup();
      expect(results.pages_standalone_trash).toBe(0);
      // Adjacent sweeps still complete.
      expect(results.page_versions).toBe(2);
    });

    // ─── #307 Finding #4 — zero-row heartbeat attestation ────────────────
    it('emits RETENTION_PRUNED for each umbrella table even when zero rows are pruned', async () => {
      mockPool.query.mockResolvedValue({ rowCount: 0 });

      await runRetentionCleanup();

      const actions = (mockLogAuditEvent as ReturnType<typeof vi.fn>).mock.calls.map(
        (call) => call[1], // second arg is the action string
      );
      // Compliance requires a heartbeat per cycle. The three umbrella
      // time-based tables + page_versions + audit_log_admin_access_denied
      // all emit RETENTION_PRUNED so the auditor can tell "ran, nothing
      // matched" from "job didn't run".
      expect(actions.filter((a) => a === 'RETENTION_PRUNED').length).toBeGreaterThanOrEqual(3);

      // Each emission includes rows_pruned: 0 in metadata when nothing was pruned.
      const zeroCalls = (mockLogAuditEvent as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call) => call[1] === 'RETENTION_PRUNED' && (call[4] as Record<string, unknown>).rows_pruned === 0,
      );
      expect(zeroCalls.length).toBeGreaterThanOrEqual(3);

      // The standalone trash purge emits its own heartbeat too.
      const trashCall = (mockLogAuditEvent as ReturnType<typeof vi.fn>).mock.calls.find(
        (call) => call[1] === 'RETENTION_PRUNED' && (call[3] as string) === 'pages_standalone_trash',
      );
      expect(trashCall).toBeDefined();
      expect((trashCall![4] as Record<string, unknown>).rows_pruned).toBe(0);
      expect((trashCall![4] as Record<string, unknown>).retention_days).toBe(
        STANDALONE_TRASH_RETENTION_DAYS,
      );
    });

    it('emits RETENTION_PRUNED with the actual non-zero rows_pruned value when rows are removed', async () => {
      mockPool.query
        .mockResolvedValueOnce({ rowCount: 10 }) // audit_log
        .mockResolvedValueOnce({ rowCount: 5 })  // search_analytics
        .mockResolvedValueOnce({ rowCount: 3 })  // error_log
        .mockResolvedValueOnce({ rowCount: 0 })  // ADMIN_ACCESS_DENIED drained
        .mockResolvedValueOnce({ rowCount: 0 })  // standalone trash purge
        .mockResolvedValueOnce({ rowCount: 2 }); // page_versions

      await runRetentionCleanup();

      const auditLogCall = (mockLogAuditEvent as ReturnType<typeof vi.fn>).mock.calls.find(
        (call) => call[1] === 'RETENTION_PRUNED' && (call[3] as string) === 'audit_log',
      );
      expect(auditLogCall).toBeDefined();
      expect((auditLogCall![4] as Record<string, unknown>).rows_pruned).toBe(10);
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
