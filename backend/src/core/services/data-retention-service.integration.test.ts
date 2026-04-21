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
    expect(
      (await query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM audit_log`)).rows[0]!.c,
    ).toBe('1');

    // Tighten to 30d. Next call purges the 50-day-old row.
    await setRetentionDays(30);
    await runRetentionCleanup();
    expect(
      (await query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM audit_log`)).rows[0]!.c,
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
      `SELECT action FROM audit_log ORDER BY action`,
    );
    expect(remaining.rows.map((r) => r.action)).toEqual(['PAGE_CREATED']);
  });
});
