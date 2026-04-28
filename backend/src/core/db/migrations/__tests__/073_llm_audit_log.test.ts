import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../../test-db-helper.js';
import { query } from '../../postgres.js';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('Migration 073 — llm_audit_log (Compendiq/compendiq-ee#115 P0f)', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => { await truncateAllTables(); });

  it('creates the llm_audit_log table', async () => {
    const tables = await query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename='llm_audit_log'`,
    );
    expect(tables.rows).toHaveLength(1);
  });

  it('declares the documented columns with correct nullability + defaults', async () => {
    const cols = await query<{
      column_name: string;
      data_type: string;
      is_nullable: 'YES' | 'NO';
      column_default: string | null;
    }>(
      `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_name='llm_audit_log'
        ORDER BY ordinal_position`,
    );
    const byName = Object.fromEntries(cols.rows.map((r) => [r.column_name, r]));

    expect(byName.id?.is_nullable).toBe('NO');
    expect(byName.user_id?.is_nullable).toBe('YES');
    expect(byName.provider_id?.is_nullable).toBe('YES');
    expect(byName.provider_name?.is_nullable).toBe('YES');
    expect(byName.model?.is_nullable).toBe('YES');
    expect(byName.usecase?.is_nullable).toBe('YES');
    expect(byName.prompt_hash?.is_nullable).toBe('NO');
    expect(byName.prompt_token_count?.is_nullable).toBe('YES');
    expect(byName.completion_token_count?.is_nullable).toBe('YES');
    expect(byName.prompt_injection_detected?.is_nullable).toBe('NO');
    expect(byName.sanitized?.is_nullable).toBe('NO');
    expect(byName.latency_ms?.is_nullable).toBe('YES');
    expect(byName.error?.is_nullable).toBe('YES');
    expect(byName.created_at?.is_nullable).toBe('NO');

    // Boolean defaults must be FALSE so the columns work for older callers
    // that don't pass the new flags.
    expect(byName.prompt_injection_detected?.column_default).toMatch(/false/i);
    expect(byName.sanitized?.column_default).toMatch(/false/i);
    expect(byName.created_at?.column_default).toMatch(/now\(\)/i);
  });

  it('declares all four documented indexes', async () => {
    const idx = await query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename='llm_audit_log' ORDER BY indexname`,
    );
    const names = idx.rows.map((r) => r.indexname);
    expect(names).toEqual(
      expect.arrayContaining([
        'idx_llm_audit_log_created_at',
        'idx_llm_audit_log_user_id',
        'idx_llm_audit_log_pii',
        'idx_llm_audit_log_usecase',
      ]),
    );
  });

  it('user_id FK uses ON DELETE SET NULL', async () => {
    // Verify the FK action — survival of historical rows is part of the
    // contract (mirrors `audit_log.user_id` from migration 062).
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

  it('provider_id FK uses ON DELETE SET NULL', async () => {
    const fk = await query<{ delete_rule: string }>(
      `SELECT rc.delete_rule
         FROM information_schema.referential_constraints rc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_name = rc.constraint_name
        WHERE kcu.table_name = 'llm_audit_log'
          AND kcu.column_name = 'provider_id'`,
    );
    expect(fk.rows[0]?.delete_rule).toBe('SET NULL');
  });

  it('accepts a minimal insert with only prompt_hash + booleans defaulting to FALSE', async () => {
    await query(
      `INSERT INTO llm_audit_log (prompt_hash) VALUES ($1)`,
      ['a'.repeat(64)],
    );
    const r = await query<{
      prompt_injection_detected: boolean;
      sanitized: boolean;
      user_id: string | null;
      provider_id: string | null;
    }>(
      `SELECT prompt_injection_detected, sanitized, user_id, provider_id
         FROM llm_audit_log ORDER BY id DESC LIMIT 1`,
    );
    expect(r.rows[0]).toMatchObject({
      prompt_injection_detected: false,
      sanitized: false,
      user_id: null,
      provider_id: null,
    });
  });

  it('survives a hard delete of the referenced user (SET NULL)', async () => {
    const u = await query<{ id: string }>(
      `INSERT INTO users (username, password_hash, role) VALUES ('audit-u1','h','user') RETURNING id`,
    );
    const uid = u.rows[0]!.id;
    await query(
      `INSERT INTO llm_audit_log (user_id, prompt_hash) VALUES ($1, $2)`,
      [uid, 'b'.repeat(64)],
    );
    await query(`DELETE FROM users WHERE id = $1`, [uid]);
    const r = await query<{ user_id: string | null }>(
      `SELECT user_id FROM llm_audit_log ORDER BY id DESC LIMIT 1`,
    );
    expect(r.rows[0]?.user_id).toBeNull();
  });
});
