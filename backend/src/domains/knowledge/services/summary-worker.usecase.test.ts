import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import {
  setupTestDb,
  truncateAllTables,
  teardownTestDb,
  isDbAvailable,
} from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import {
  __resetUsecaseEnvSeedingForTests,
  getUsecaseLlmAssignment,
  upsertUsecaseLlmAssignments,
} from '../../../core/services/admin-settings-service.js';
import { getSummaryStatus, runSummaryBatch } from './summary-worker.js';

const dbAvailable = await isDbAvailable();

/**
 * Issue #214 — worker picks up a runtime admin_settings change without restart.
 *
 * Mocks the provider-level stream chat so the test never hits a real LLM.
 * Uses a spy so we can assert which model was passed to the provider on each
 * batch.
 */
const providerSpy = vi.fn(async function* (..._args: unknown[]) {
  yield { content: 'mocked summary content that is long enough to persist.', done: false };
  yield { content: '', done: true };
});

vi.mock('../../llm/services/llm-provider.js', () => ({
  providerStreamChatForUsecase: (...args: unknown[]) => providerSpy(...args),
}));

// getSystemPrompt and sanitizeLlmInput are imported by summary-worker.ts; stub
// to avoid unrelated behavior during the test.
vi.mock('../../llm/services/ollama-service.js', () => ({
  getSystemPrompt: vi.fn().mockReturnValue('You are a summary model.'),
}));

vi.mock('../../../core/utils/sanitize-llm-input.js', () => ({
  sanitizeLlmInput: vi
    .fn()
    .mockImplementation((input: string) => ({ sanitized: input, wasSanitized: false })),
}));

describe.skipIf(!dbAvailable)('summary-worker — per-use-case assignment (issue #214)', () => {
  const testSpaceKey = 'TEST';
  let savedEnv: Record<string, string | undefined>;

  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    __resetUsecaseEnvSeedingForTests();
    providerSpy.mockClear();

    // Clear env vars so the DB is the only source of truth during the test.
    savedEnv = {
      SUMMARY_MODEL: process.env.SUMMARY_MODEL,
      QUALITY_MODEL: process.env.QUALITY_MODEL,
      DEFAULT_LLM_MODEL: process.env.DEFAULT_LLM_MODEL,
    };
    delete process.env.SUMMARY_MODEL;
    delete process.env.QUALITY_MODEL;
    delete process.env.DEFAULT_LLM_MODEL;

    // Re-seed system roles (truncateAllTables clears them).
    await query(
      `INSERT INTO roles (name, display_name, is_system, permissions) VALUES
        ('system_admin', 'System Administrator', TRUE, ARRAY['read','comment','edit','delete','manage','admin']),
        ('space_admin', 'Space Administrator', TRUE, ARRAY['read','comment','edit','delete','manage']),
        ('editor', 'Editor', TRUE, ARRAY['read','comment','edit','delete']),
        ('commenter', 'Commenter', TRUE, ARRAY['read','comment']),
        ('viewer', 'Viewer', TRUE, ARRAY['read'])
       ON CONFLICT (name) DO NOTHING`,
    );

    await query(
      "INSERT INTO spaces (space_key, space_name) VALUES ($1, 'Test Space')",
      [testSpaceKey],
    );
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  it('runtime DB change takes effect without worker restart', async () => {
    // --- Initial admin config: use model A
    await upsertUsecaseLlmAssignments({
      summary: { provider: 'ollama', model: 'model-A' },
    });

    // Sanity check: resolver returns model A.
    const a = await getUsecaseLlmAssignment('summary');
    expect(a.model).toBe('model-A');

    // Seed a page that needs summarization.
    const longContent = 'A'.repeat(200);
    await query(
      `INSERT INTO pages (confluence_id, space_key, title, body_text, summary_status)
       VALUES ('p1', $1, 'Page One', $2, 'pending')`,
      [testSpaceKey, longContent],
    );

    const first = await runSummaryBatch();
    expect(first.processed).toBe(1);
    expect(first.errors).toBe(0);

    // Provider should have been called with model-A (arg 1).
    expect(providerSpy).toHaveBeenCalledTimes(1);
    expect(providerSpy.mock.calls[0]?.[1]).toBe('model-A');

    // --- Admin updates the DB live (simulates Settings UI PUT) — no restart.
    await upsertUsecaseLlmAssignments({
      summary: { provider: 'ollama', model: 'model-B' },
    });

    const b = await getUsecaseLlmAssignment('summary');
    expect(b.model).toBe('model-B');

    // Another page — resume processing with the new model.
    await query(
      `INSERT INTO pages (confluence_id, space_key, title, body_text, summary_status)
       VALUES ('p2', $1, 'Page Two', $2, 'pending')`,
      [testSpaceKey, longContent],
    );

    const second = await runSummaryBatch();
    expect(second.processed).toBe(1);
    expect(second.errors).toBe(0);

    // Second batch must have used model-B — no cache, no restart.
    expect(providerSpy).toHaveBeenCalledTimes(2);
    expect(providerSpy.mock.calls[1]?.[1]).toBe('model-B');
  });

  it('getSummaryStatus reports the resolved model from admin settings', async () => {
    await upsertUsecaseLlmAssignments({
      summary: { provider: 'openai', model: 'gpt-4o-mini' },
    });
    // Shared openai settings so the resolver's provider resolution is well-defined.
    await query(
      `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
       VALUES ('llm_provider', 'openai', NOW()), ('openai_model', 'gpt-4o', NOW())
       ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value`,
    );

    const status = await getSummaryStatus();
    expect(status.model).toBe('gpt-4o-mini');
  });

  it('runSummaryBatch honors an explicit model argument but keeps the resolved provider', async () => {
    // Admin configures summary to use openai, but caller passes an override
    // model — the provider should still be 'openai' (not re-resolved to shared).
    await upsertUsecaseLlmAssignments({
      summary: { provider: 'openai', model: 'gpt-4o-mini' },
    });

    const longContent = 'B'.repeat(200);
    await query(
      `INSERT INTO pages (confluence_id, space_key, title, body_text, summary_status)
       VALUES ('p3', $1, 'Page Three', $2, 'pending')`,
      [testSpaceKey, longContent],
    );

    const res = await runSummaryBatch('explicit-override-model');
    expect(res.processed).toBe(1);

    expect(providerSpy).toHaveBeenCalledTimes(1);
    // arg 0 = provider, arg 1 = model
    expect(providerSpy.mock.calls[0]?.[0]).toBe('openai');
    expect(providerSpy.mock.calls[0]?.[1]).toBe('explicit-override-model');
  });
});
