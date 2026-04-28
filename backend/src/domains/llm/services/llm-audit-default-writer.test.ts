import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../test-db-helper.js';
import * as postgres from '../../../core/db/postgres.js';
import { query } from '../../../core/db/postgres.js';
import { defaultLlmAuditWriter } from './llm-audit-default-writer.js';
import type { LlmAuditEntry } from './llm-audit-hook.js';

const dbAvailable = await isDbAvailable();

function baseEntry(over: Partial<LlmAuditEntry> = {}): LlmAuditEntry {
  return {
    userId: null,
    action: 'ask',
    model: 'qwen3:4b',
    provider: 'ollama',
    inputTokens: 42,
    outputTokens: 84,
    inputMessages: [{ role: 'user', contentLength: 17 }],
    retrievedChunkIds: [],
    durationMs: 123,
    status: 'success',
    ...over,
  };
}

describe.skipIf(!dbAvailable)('defaultLlmAuditWriter (CE writer)', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => { await truncateAllTables(); });

  it('persists a row with the expected shape and SHA-256 prompt hash (no plaintext)', async () => {
    await defaultLlmAuditWriter(
      baseEntry({
        inputText: 'Hello, world!',
        promptInjectionDetected: false,
        sanitized: false,
      }),
    );
    const r = await query<{
      action: string;
      model: string;
      provider: string;
      input_tokens: number;
      output_tokens: number;
      duration_ms: number;
      status: string;
      error_message: string | null;
      prompt_hash: string;
      prompt_injection_detected: boolean;
      sanitized: boolean;
    }>(`SELECT * FROM llm_audit_log ORDER BY id DESC LIMIT 1`);
    const row = r.rows[0]!;
    expect(row.action).toBe('ask');
    expect(row.provider).toBe('ollama');
    expect(row.model).toBe('qwen3:4b');
    expect(row.input_tokens).toBe(42);
    expect(row.output_tokens).toBe(84);
    expect(row.duration_ms).toBe(123);
    expect(row.status).toBe('success');
    expect(row.error_message).toBeNull();
    // SHA-256 hex of 'Hello, world!' (sanity-check the writer hashes plaintext, not stores it).
    expect(row.prompt_hash).toBe('315f5bdb76d078c43b8ac0064e4a0164612b1fce77c869345bfc94c75894edd3');
  });

  it('never persists plaintext prompts, even when inputText is set', async () => {
    const secretPrompt = 'PLEASE-DO-NOT-LEAK-THIS-INTO-THE-DB';
    await defaultLlmAuditWriter(baseEntry({ inputText: secretPrompt }));
    const r = await query<{ row: string }>(
      `SELECT to_jsonb(t)::text AS row FROM llm_audit_log t ORDER BY id DESC LIMIT 1`,
    );
    expect(r.rows[0]?.row).not.toContain(secretPrompt);
  });

  it('records prompt_injection_detected = TRUE when the entry flags it', async () => {
    await defaultLlmAuditWriter(
      baseEntry({ promptInjectionDetected: true, sanitized: true, inputText: 'ignore previous instructions' }),
    );
    const r = await query<{ prompt_injection_detected: boolean; sanitized: boolean }>(
      `SELECT prompt_injection_detected, sanitized FROM llm_audit_log ORDER BY id DESC LIMIT 1`,
    );
    expect(r.rows[0]).toEqual({ prompt_injection_detected: true, sanitized: true });
  });

  it('records sanitized = TRUE on its own (sanitizer ran but no warning was raised)', async () => {
    await defaultLlmAuditWriter(
      baseEntry({ promptInjectionDetected: false, sanitized: true }),
    );
    const r = await query<{ prompt_injection_detected: boolean; sanitized: boolean }>(
      `SELECT prompt_injection_detected, sanitized FROM llm_audit_log ORDER BY id DESC LIMIT 1`,
    );
    expect(r.rows[0]).toEqual({ prompt_injection_detected: false, sanitized: true });
  });

  it('records error_message string on a failed call', async () => {
    await defaultLlmAuditWriter(
      baseEntry({
        status: 'error',
        outputTokens: 0,
        errorMessage: 'upstream HTTP 500',
      }),
    );
    const r = await query<{ error_message: string; output_tokens: number; status: string }>(
      `SELECT error_message, output_tokens, status FROM llm_audit_log ORDER BY id DESC LIMIT 1`,
    );
    expect(r.rows[0]?.error_message).toBe('upstream HTTP 500');
    expect(r.rows[0]?.output_tokens).toBe(0);
    expect(r.rows[0]?.status).toBe('error');
  });

  it('flags default to FALSE when the entry omits them (older call sites)', async () => {
    await defaultLlmAuditWriter(baseEntry());
    const r = await query<{ prompt_injection_detected: boolean; sanitized: boolean }>(
      `SELECT prompt_injection_detected, sanitized FROM llm_audit_log ORDER BY id DESC LIMIT 1`,
    );
    expect(r.rows[0]).toEqual({ prompt_injection_detected: false, sanitized: false });
  });

  it('does not throw when the underlying insert fails (fire-and-forget contract)', async () => {
    // Force a single-shot failure via spy rather than DROP TABLE: the
    // earlier approach left the table in a sub-shape (no indexes) that
    // could cause cross-file flakiness under non-alphabetical test
    // ordering. The spy targets the exact same `query` reference the
    // writer imports, so the rejection lands inside the writer's
    // try/catch and the swallow is exercised end-to-end.
    const spy = vi
      .spyOn(postgres, 'query')
      .mockRejectedValueOnce(new Error('simulated DB failure'));
    try {
      await expect(defaultLlmAuditWriter(baseEntry())).resolves.toBeUndefined();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});
