import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../../test-db-helper.js';
import { query } from '../../postgres.js';

const dbAvailable = await isDbAvailable();

/**
 * Tests focus on what migration 073 *itself adds* to either deployment:
 *   - the 3 P0f columns (prompt_hash, prompt_injection_detected, sanitized)
 *   - the 4 partial indexes
 *
 * The base table shape (action / model / provider / input_tokens / etc.)
 * is owned by whichever migration created the table first. In a CE-only
 * deployment that's migration 073 itself (CREATE TABLE IF NOT EXISTS).
 * In a `compendiq-ee` merged build, EE's `060_llm_audit_log.sql` ran
 * earlier and the CREATE TABLE here is a no-op — so EE's stricter
 * NOT-NULL constraints on `action`/`model`/`provider` apply. Tests must
 * not pin nullability/defaults of those columns or they'll diverge
 * between deployments.
 */
async function isEeExtendedSchema(): Promise<boolean> {
  // EE 060 adds plaintext columns that CE 073 does not. Their presence
  // is the canonical signal that the table was created by EE's earlier
  // migration with stricter NOT-NULL constraints on action/model/provider.
  const r = await query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name='llm_audit_log' AND column_name='input_text'`,
  );
  return r.rows.length > 0;
}

describe.skipIf(!dbAvailable)('Migration 073 — llm_audit_log + P0f columns (Compendiq/compendiq-ee#115)', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => { await truncateAllTables(); });

  it('creates the llm_audit_log table', async () => {
    const tables = await query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename='llm_audit_log'`,
    );
    expect(tables.rows).toHaveLength(1);
  });

  it('declares the P0f delta columns with correct nullability + defaults', async () => {
    // Migration 073 ALTER TABLEs to add three P0f columns regardless of
    // which migration originally created the table. Pin those exactly;
    // skip the base-shape columns since they vary CE-only vs EE merged.
    const cols = await query<{
      column_name: string;
      is_nullable: 'YES' | 'NO';
      column_default: string | null;
    }>(
      `SELECT column_name, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_name='llm_audit_log'
          AND column_name IN ('prompt_hash','prompt_injection_detected','sanitized')`,
    );
    const byName = Object.fromEntries(cols.rows.map((r) => [r.column_name, r]));

    expect(byName.prompt_hash?.is_nullable).toBe('YES');
    expect(byName.prompt_injection_detected?.is_nullable).toBe('NO');
    expect(byName.sanitized?.is_nullable).toBe('NO');
    expect(byName.prompt_injection_detected?.column_default).toMatch(/false/i);
    expect(byName.sanitized?.column_default).toMatch(/false/i);
  });

  it('declares the documented indexes', async () => {
    const idx = await query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename='llm_audit_log' ORDER BY indexname`,
    );
    const names = idx.rows.map((r) => r.indexname);
    expect(names).toEqual(
      expect.arrayContaining([
        'idx_llm_audit_log_created_at',
        'idx_llm_audit_log_user_id',
        'idx_llm_audit_log_pii',
        'idx_llm_audit_log_action',
      ]),
    );
  });

  it('user_id FK uses ON DELETE SET NULL', async () => {
    const fk = await query<{ delete_rule: string }>(
      `SELECT rc.delete_rule
         FROM information_schema.referential_constraints rc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_name = rc.constraint_name
        WHERE kcu.table_name = 'llm_audit_log'
          AND kcu.column_name = 'user_id'`,
    );
    expect(fk.rows[0]?.delete_rule).toBe('SET NULL');
  });

  it('booleans default to FALSE on minimal insert (deployment-aware)', async () => {
    // EE 060 makes action/model/provider/input_messages NOT NULL with no
    // default. Provide them when running against the EE-extended schema;
    // CE-only deployments accept DEFAULT VALUES.
    if (await isEeExtendedSchema()) {
      await query(
        `INSERT INTO llm_audit_log (action, model, provider, input_messages)
         VALUES ('test', 'm', 'p', '[]'::jsonb)`,
      );
    } else {
      await query(`INSERT INTO llm_audit_log DEFAULT VALUES`);
    }
    const r = await query<{
      prompt_injection_detected: boolean;
      sanitized: boolean;
      user_id: string | null;
      input_tokens: number;
      status: string;
    }>(
      `SELECT prompt_injection_detected, sanitized, user_id, input_tokens, status
         FROM llm_audit_log ORDER BY id DESC LIMIT 1`,
    );
    expect(r.rows[0]).toMatchObject({
      prompt_injection_detected: false,
      sanitized: false,
      user_id: null,
      input_tokens: 0,
      status: 'success',
    });
  });

  it('survives a hard delete of the referenced user (SET NULL)', async () => {
    const u = await query<{ id: string }>(
      `INSERT INTO users (username, password_hash, role) VALUES ('audit-u1','h','user') RETURNING id`,
    );
    const uid = u.rows[0]!.id;
    if (await isEeExtendedSchema()) {
      await query(
        `INSERT INTO llm_audit_log (user_id, action, model, provider, input_messages, prompt_hash)
         VALUES ($1, 'test', 'm', 'p', '[]'::jsonb, $2)`,
        [uid, 'b'.repeat(64)],
      );
    } else {
      await query(
        `INSERT INTO llm_audit_log (user_id, prompt_hash) VALUES ($1, $2)`,
        [uid, 'b'.repeat(64)],
      );
    }
    await query(`DELETE FROM users WHERE id = $1`, [uid]);
    const r = await query<{ user_id: string | null }>(
      `SELECT user_id FROM llm_audit_log ORDER BY id DESC LIMIT 1`,
    );
    expect(r.rows[0]?.user_id).toBeNull();
  });

  it('ALTER TABLE ADD COLUMN IF NOT EXISTS is idempotent on rerun', async () => {
    // Simulate the EE-already-created table case by manually re-running
    // the ALTER. Should not throw.
    await query(
      `ALTER TABLE llm_audit_log
         ADD COLUMN IF NOT EXISTS prompt_hash TEXT,
         ADD COLUMN IF NOT EXISTS prompt_injection_detected BOOLEAN NOT NULL DEFAULT FALSE,
         ADD COLUMN IF NOT EXISTS sanitized BOOLEAN NOT NULL DEFAULT FALSE`,
    );
    const cols = await query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name='llm_audit_log'
          AND column_name IN ('prompt_hash','prompt_injection_detected','sanitized')`,
    );
    expect(cols.rows).toHaveLength(3);
  });
});
