import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';

import {
  setupTestDb,
  truncateAllTables,
  teardownTestDb,
  isDbAvailable,
} from '../../test-db-helper.js';
import { query } from '../db/postgres.js';
import { runRetentionCleanup } from './data-retention-service.js';

/**
 * Real-DB integration tests for the #264 targeted ADMIN_ACCESS_DENIED retention
 * sweep inside `runRetentionCleanup`. These tests intentionally run against
 * the test Postgres instance (port 5433) — the mocked-unit tests in
 * `data-retention-service.test.ts` cover behaviour at the query layer; the
 * tests below cover the contract the purge has with real `audit_log` data.
 *
 * Plan §9 RED #4–#7.
 */

async function setRetentionDays(days: number): Promise<void> {
  await query(
    `INSERT INTO admin_settings (setting_key, setting_value)
     VALUES ($1, $2)
     ON CONFLICT (setting_key) DO UPDATE SET setting_value = $2`,
    ['admin_access_denied_retention_days', String(days)],
  );
}

async function insertDeniedRow(resourceId: string, ageDays: number): Promise<void> {
  await query(
    `INSERT INTO audit_log (user_id, action, resource_type, resource_id, metadata, created_at)
     VALUES (NULL, 'ADMIN_ACCESS_DENIED', 'route', $1, '{}'::jsonb, NOW() - ($2::text || ' days')::interval)`,
    [resourceId, String(ageDays)],
  );
}

// ── pending_sync_versions fixtures (#744) ──────────────────────────────

async function setPendingSyncRetentionDays(days: number): Promise<void> {
  await query(
    `INSERT INTO admin_settings (setting_key, setting_value)
     VALUES ($1, $2)
     ON CONFLICT (setting_key) DO UPDATE SET setting_value = $2`,
    ['pending_sync_versions_retention_days', String(days)],
  );
}

/** Seed a space + page flagged with a pending conflict; returns the page id. */
async function insertConflictPage(confluenceId: string): Promise<number> {
  await query(
    `INSERT INTO spaces (space_key, space_name) VALUES ('RET', 'RET')
     ON CONFLICT (space_key) DO NOTHING`,
  );
  const r = await query<{ id: number }>(
    `INSERT INTO pages
       (confluence_id, source, space_key, title,
        body_storage, body_html, body_text,
        version, last_synced, conflict_pending, conflict_detected_at)
     VALUES ($1, 'confluence', 'RET', 'Retention Test Page',
             'b', 'b', 'b', 1, NOW(), TRUE, NOW())
     RETURNING id`,
    [confluenceId],
  );
  return r.rows[0]!.id;
}

async function insertPendingVersion(pageId: number, ageDays: number): Promise<void> {
  await query(
    `INSERT INTO pending_sync_versions
       (page_id, confluence_version, body_storage, body_html, body_text, sync_run_id, detected_at)
     VALUES ($1, 2, 's', 'h', 't', gen_random_uuid(), NOW() - ($2::text || ' days')::interval)`,
    [pageId, String(ageDays)],
  );
}

const dbAvailable = await isDbAvailable();

beforeAll(async () => {
  if (!dbAvailable) return;
  await setupTestDb();
}, 30_000);

beforeEach(async () => {
  if (!dbAvailable) return;
  await truncateAllTables();
});

afterAll(async () => {
  if (!dbAvailable) return;
  await teardownTestDb();
});

describe.skipIf(!dbAvailable)('ADMIN_ACCESS_DENIED retention purge (#264)', () => {
  // RED #4
  it('purges ADMIN_ACCESS_DENIED rows older than the configured retention', async () => {
    await setRetentionDays(30);
    await insertDeniedRow('GET /x', 35);
    await insertDeniedRow('GET /y', 35);
    await insertDeniedRow('GET /z', 5);

    await runRetentionCleanup();

    const r = await query<{ resource_id: string }>(
      `SELECT resource_id FROM audit_log WHERE action = 'ADMIN_ACCESS_DENIED' ORDER BY resource_id`,
    );
    expect(r.rows.map((row) => row.resource_id)).toEqual(['GET /z']);
  });

  // RED #5
  it('does not purge ADMIN_ACCESS_DENIED rows younger than retention', async () => {
    await setRetentionDays(90);
    await insertDeniedRow('GET /a', 30);

    await runRetentionCleanup();

    const r = await query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM audit_log WHERE action = 'ADMIN_ACCESS_DENIED'`,
    );
    expect(r.rows[0]!.c).toBe('1');
  });

  // RED #6 — scoped-by-action isolation
  it('does not touch rows with other audit actions regardless of age', async () => {
    await setRetentionDays(30);

    // An ADMIN_ACTION (successful admin) row that is 35 days old. The umbrella
    // audit_log sweep (RETENTION_DEFAULTS.audit_log = 365) does not cull it
    // either, so we assert it survives the full `runRetentionCleanup`.
    // Uses NULL user_id because audit_log.user_id FK references users(id)
    // with no user seeded; NULL is accepted.
    await query(
      `INSERT INTO audit_log (user_id, action, resource_type, resource_id, metadata, created_at)
       VALUES (NULL, 'ADMIN_ACTION', 'admin_settings', NULL, '{}'::jsonb, NOW() - INTERVAL '35 days')`,
    );
    // Also a LOGIN_FAILED row of the same age — another non-denied action.
    await query(
      `INSERT INTO audit_log (user_id, action, resource_type, resource_id, metadata, created_at)
       VALUES (NULL, 'LOGIN_FAILED', 'auth', NULL, '{}'::jsonb, NOW() - INTERVAL '35 days')`,
    );

    await runRetentionCleanup();

    const counts = await query<{ action: string; c: string }>(
      `SELECT action, COUNT(*)::text AS c FROM audit_log GROUP BY action ORDER BY action`,
    );
    const map = Object.fromEntries(counts.rows.map((r) => [r.action, r.c]));
    expect(map['ADMIN_ACTION']).toBe('1');
    expect(map['LOGIN_FAILED']).toBe('1');
    expect(map['ADMIN_ACCESS_DENIED']).toBeUndefined();
  });

  // RED #7 — setting-change propagation. Getter is not cached, so next tick
  // honours the new value.
  it('picks up a setting change on the next retention tick', async () => {
    // Lenient 100d — a 50-day-old row survives.
    await setRetentionDays(100);
    await insertDeniedRow('GET /q', 50);

    await runRetentionCleanup();
    // Exclude RETENTION_PRUNED (#307 Finding #4): each prune branch now emits
    // a heartbeat RETENTION_PRUNED row even on a zero-row sweep. The assertion
    // is about the target (ADMIN_ACCESS_DENIED) data, not the audit-of-prune
    // meta-events written by the cycle itself.
    expect(
      (await query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM audit_log WHERE action <> 'RETENTION_PRUNED'`,
      )).rows[0]!.c,
    ).toBe('1');

    // Tighten to 30d. Next call purges the 50-day-old row.
    await setRetentionDays(30);
    await runRetentionCleanup();
    expect(
      (await query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM audit_log WHERE action <> 'RETENTION_PRUNED'`,
      )).rows[0]!.c,
    ).toBe('0');
  });

  // Bonus: the targeted sweep is scoped only to ADMIN_ACCESS_DENIED, even
  // when the admin-configured window is shorter than the umbrella audit_log
  // window. A 100-day-old row of another action type must survive the
  // targeted sweep (365d umbrella wouldn't touch it either). This guards the
  // "don't broaden audit_log retention for other action types" requirement.
  it('leaves other audit actions alone even when a tighter window is configured', async () => {
    await setRetentionDays(7); // absurdly short — would catch anything if not action-scoped
    await insertDeniedRow('GET /drop-me', 30); // will be purged (30d > 7d)
    await query(
      `INSERT INTO audit_log (user_id, action, resource_type, resource_id, metadata, created_at)
       VALUES (NULL, 'PAGE_CREATED', 'page', 'p-1', '{}'::jsonb, NOW() - INTERVAL '30 days')`,
    );

    await runRetentionCleanup();

    const remaining = await query<{ action: string }>(
      // Exclude RETENTION_PRUNED (#307) — the prune cycle writes a
      // self-attestation row; this test is about untouched actions.
      `SELECT action FROM audit_log WHERE action <> 'RETENTION_PRUNED' ORDER BY action`,
    );
    expect(remaining.rows.map((r) => r.action)).toEqual(['PAGE_CREATED']);
  });
});

describe.skipIf(!dbAvailable)('pending_sync_versions retention rows_pruned count (#744)', () => {
  // Regression: the sweep used `WITH deleted AS (DELETE … RETURNING page_id)
  // SELECT DISTINCT page_id FROM deleted` and read `result.rowCount`, which
  // for a CTE query reflects the outer SELECT DISTINCT — i.e. the number of
  // DISTINCT PAGES, not deleted rows. Deleting 5 pending versions across 2
  // pages reported rows_pruned = 2.
  it('reports the number of deleted rows, not distinct pages', async () => {
    await setPendingSyncRetentionDays(7);
    const pageA = await insertConflictPage('ret-744-a');
    const pageB = await insertConflictPage('ret-744-b');

    // 5 stale rows across 2 distinct pages.
    await insertPendingVersion(pageA, 30);
    await insertPendingVersion(pageA, 31);
    await insertPendingVersion(pageA, 32);
    await insertPendingVersion(pageB, 30);
    await insertPendingVersion(pageB, 31);

    const results = await runRetentionCleanup();

    // True deleted-row count — the buggy CTE rowCount reported 2 (pages).
    expect(results['pending_sync_versions']).toBe(5);

    // The compliance heartbeat must carry the same true row count.
    const audit = await query<{ metadata: { rows_pruned: number } }>(
      `SELECT metadata FROM audit_log
        WHERE action = 'RETENTION_PRUNED' AND resource_id = 'pending_sync_versions'`,
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.metadata.rows_pruned).toBe(5);

    // All stale rows are actually gone.
    const left = await query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM pending_sync_versions`,
    );
    expect(left.rows[0]!.c).toBe('0');

    // conflict_pending recompute still runs for every affected page.
    const flags = await query<{ conflict_pending: boolean; conflict_detected_at: Date | null }>(
      `SELECT conflict_pending, conflict_detected_at FROM pages WHERE id = ANY($1::int[])`,
      [[pageA, pageB]],
    );
    expect(flags.rows).toHaveLength(2);
    for (const row of flags.rows) {
      expect(row.conflict_pending).toBe(false);
      expect(row.conflict_detected_at).toBeNull();
    }
  });

  it('keeps conflict_pending TRUE when a fresh pending version survives the sweep', async () => {
    await setPendingSyncRetentionDays(7);
    const pageId = await insertConflictPage('ret-744-c');

    await insertPendingVersion(pageId, 30); // pruned
    await insertPendingVersion(pageId, 1);  // survives

    const results = await runRetentionCleanup();

    expect(results['pending_sync_versions']).toBe(1);

    const flags = await query<{ conflict_pending: boolean }>(
      `SELECT conflict_pending FROM pages WHERE id = $1`,
      [pageId],
    );
    expect(flags.rows[0]!.conflict_pending).toBe(true);

    const left = await query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM pending_sync_versions WHERE page_id = $1`,
      [pageId],
    );
    expect(left.rows[0]!.c).toBe('1');
  });
});
