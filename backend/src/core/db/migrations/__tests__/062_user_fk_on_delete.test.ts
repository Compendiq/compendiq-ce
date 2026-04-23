import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  setupTestDb,
  teardownTestDb,
  isDbAvailable,
} from '../../../../test-db-helper.js';
import { query } from '../../postgres.js';

const dbAvailable = await isDbAvailable();

/**
 * Regression guard for PR #311 Finding #1.
 *
 * Migration 062 converts the three FKs to `users(id)` that previously used
 * the PostgreSQL default (NO ACTION) — blocking DELETE of any user who had
 * ever logged in, hit an error, or resolved a comment — to ON DELETE SET
 * NULL so the historical row survives with a null pointer.
 */
describe.skipIf(!dbAvailable)('migration 062 — user FK ON DELETE SET NULL', () => {
  beforeAll(async () => {
    await setupTestDb();
  });
  afterAll(async () => {
    await teardownTestDb();
  });

  async function fkDeleteRule(
    table: string,
    constraint: string,
  ): Promise<string> {
    // confdeltype is a single char: 'a' = NO ACTION, 'n' = SET NULL,
    // 'd' = SET DEFAULT, 'c' = CASCADE, 'r' = RESTRICT.
    const res = await query<{ confdeltype: string }>(
      `SELECT c.confdeltype
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
        WHERE t.relname = $1 AND c.conname = $2`,
      [table, constraint],
    );
    expect(res.rows).toHaveLength(1);
    return res.rows[0]!.confdeltype;
  }

  it('audit_log.user_id FK is ON DELETE SET NULL', async () => {
    expect(await fkDeleteRule('audit_log', 'audit_log_user_id_fkey')).toBe('n');
  });

  it('error_log.user_id FK is ON DELETE SET NULL', async () => {
    expect(await fkDeleteRule('error_log', 'error_log_user_id_fkey')).toBe('n');
  });

  it('comments.resolved_by FK is ON DELETE SET NULL', async () => {
    expect(
      await fkDeleteRule('comments', 'comments_resolved_by_fkey'),
    ).toBe('n');
  });
});
