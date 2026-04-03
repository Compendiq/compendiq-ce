import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted to create mocks that are available in vi.mock factories
const { mockClientQuery, mockClientRelease } = vi.hoisted(() => ({
  mockClientQuery: vi.fn(),
  mockClientRelease: vi.fn(),
}));

vi.mock('../db/postgres.js', () => ({
  query: vi.fn(),
  getPool: vi.fn().mockReturnValue({
    connect: vi.fn().mockResolvedValue({
      query: (...args: unknown[]) => mockClientQuery(...args),
      release: mockClientRelease,
    }),
  }),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

vi.mock('../utils/crypto.js', () => ({
  encryptPat: vi.fn((val: string) => `encrypted:${val}`),
  decryptPat: vi.fn((val: string) => val.replace('encrypted:', '')),
}));

import { upsertSharedLlmSettings } from './admin-settings-service.js';

describe('upsertSharedLlmSettings - batch operations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClientQuery.mockResolvedValue({ rows: [] });
  });

  it('should batch upserts into a single INSERT...ON CONFLICT with unnest()', async () => {
    await upsertSharedLlmSettings({
      llmProvider: 'openai',
      ollamaModel: 'llama3',
      openaiModel: 'gpt-4',
    });

    // Expect: BEGIN, batch INSERT, COMMIT
    const calls = mockClientQuery.mock.calls.map((c) => String(c[0]));
    expect(calls[0]).toBe('BEGIN');

    // The unnest batch INSERT
    const insertCall = calls.find((sql) => sql.includes('unnest'));
    expect(insertCall).toBeDefined();
    expect(insertCall).toContain('INSERT INTO admin_settings');
    expect(insertCall).toContain('ON CONFLICT');

    // Verify the keys and values were passed as arrays
    const insertArgs = mockClientQuery.mock.calls.find(
      (c) => String(c[0]).includes('unnest'),
    );
    expect(insertArgs![1]).toEqual([
      ['llm_provider', 'ollama_model', 'openai_model'],
      ['openai', 'llama3', 'gpt-4'],
    ]);

    // No individual INSERT loops
    const individualInserts = calls.filter(
      (sql) => sql.includes('INSERT') && !sql.includes('unnest') && sql !== 'BEGIN',
    );
    expect(individualInserts).toHaveLength(0);

    expect(calls[calls.length - 1]).toBe('COMMIT');
  });

  it('should batch deletes into a single DELETE with ANY()', async () => {
    await upsertSharedLlmSettings({
      openaiBaseUrl: '',
      openaiApiKey: '',
      openaiModel: '',
    });

    const calls = mockClientQuery.mock.calls.map((c) => String(c[0]));

    // The batch DELETE with ANY()
    const deleteCall = calls.find((sql) => sql.includes('ANY'));
    expect(deleteCall).toBeDefined();
    expect(deleteCall).toContain('DELETE FROM admin_settings');
    expect(deleteCall).toContain('ANY($1::text[])');

    // Verify the keys were passed as a single array
    const deleteArgs = mockClientQuery.mock.calls.find(
      (c) => String(c[0]).includes('ANY'),
    );
    expect(deleteArgs![1]).toEqual([['openai_base_url', 'openai_api_key', 'openai_model']]);

    // No individual DELETE queries
    const individualDeletes = calls.filter(
      (sql) => sql.includes('DELETE') && !sql.includes('ANY'),
    );
    expect(individualDeletes).toHaveLength(0);
  });

  it('should handle mixed upserts and deletes in a single transaction', async () => {
    await upsertSharedLlmSettings({
      llmProvider: 'ollama',
      openaiBaseUrl: '',
      ollamaModel: 'llama3',
      openaiApiKey: null,
    });

    const calls = mockClientQuery.mock.calls.map((c) => String(c[0]));
    expect(calls[0]).toBe('BEGIN');

    // Should have both batch INSERT and batch DELETE
    expect(calls.some((sql) => sql.includes('unnest'))).toBe(true);
    expect(calls.some((sql) => sql.includes('ANY'))).toBe(true);

    expect(calls[calls.length - 1]).toBe('COMMIT');
  });

  it('should rollback on error', async () => {
    mockClientQuery
      .mockResolvedValueOnce({})  // BEGIN
      .mockRejectedValueOnce(new Error('DB error')); // INSERT fails

    await expect(
      upsertSharedLlmSettings({ llmProvider: 'ollama' }),
    ).rejects.toThrow('DB error');

    const calls = mockClientQuery.mock.calls.map((c) => String(c[0]));
    expect(calls).toContain('ROLLBACK');
    expect(mockClientRelease).toHaveBeenCalled();
  });
});
