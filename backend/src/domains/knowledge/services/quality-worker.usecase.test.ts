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
import { getQualityStatus, processBatch } from './quality-worker.js';

const dbAvailable = await isDbAvailable();

/**
 * Issue #214 — quality worker picks up a runtime admin_settings change without
 * restart. Mirror of `summary-worker.usecase.test.ts`.
 */
const providerSpy = vi.fn(async function* (..._args: unknown[]) {
  yield {
    content: `## Overall Quality Score: 72/100
## Completeness: 70/100
## Clarity: 75/100
## Structure: 70/100
## Accuracy: 72/100
## Readability: 73/100
## Summary
Pretty ok article.`,
    done: false,
  };
  yield { content: '', done: true };
});

vi.mock('../../llm/services/llm-provider.js', () => ({
  providerStreamChatForUsecase: (...args: unknown[]) => providerSpy(...args),
}));

vi.mock('../../llm/services/ollama-service.js', () => ({
  getSystemPrompt: vi.fn().mockReturnValue('You are a quality analyzer.'),
}));

vi.mock('../../../core/utils/sanitize-llm-input.js', () => ({
  sanitizeLlmInput: vi
    .fn()
    .mockImplementation((input: string) => ({ sanitized: input, wasSanitized: false })),
}));

vi.mock('../../../core/services/content-converter.js', () => ({
  htmlToMarkdown: vi.fn().mockImplementation((html: string) => html),
}));

describe.skipIf(!dbAvailable)('quality-worker — per-use-case assignment (issue #214)', () => {
  const testSpaceKey = 'TEST';
  let savedEnv: Record<string, string | undefined>;

  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    __resetUsecaseEnvSeedingForTests();
    providerSpy.mockClear();

    savedEnv = {
      SUMMARY_MODEL: process.env.SUMMARY_MODEL,
      QUALITY_MODEL: process.env.QUALITY_MODEL,
      DEFAULT_LLM_MODEL: process.env.DEFAULT_LLM_MODEL,
    };
    delete process.env.SUMMARY_MODEL;
    delete process.env.QUALITY_MODEL;
    delete process.env.DEFAULT_LLM_MODEL;

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
    // Initial admin config: quality uses model A.
    await upsertUsecaseLlmAssignments({
      quality: { provider: 'ollama', model: 'model-A' },
    });
    expect((await getUsecaseLlmAssignment('quality')).model).toBe('model-A');

    const content =
      'This is a sufficiently long article body that exceeds the fifty character minimum threshold for quality analysis processing.';
    await query(
      `INSERT INTO pages (confluence_id, space_key, title, body_text, body_html, quality_status)
       VALUES ('q1', $1, 'Page One', $2, $3, 'pending')`,
      [testSpaceKey, content, `<p>${content}</p>`],
    );

    const first = await processBatch();
    expect(first).toBe(1);
    expect(providerSpy).toHaveBeenCalledTimes(1);
    expect(providerSpy.mock.calls[0]?.[1]).toBe('model-A');

    // --- Admin live-edits the DB; next batch must use model B.
    await upsertUsecaseLlmAssignments({
      quality: { provider: 'ollama', model: 'model-B' },
    });
    expect((await getUsecaseLlmAssignment('quality')).model).toBe('model-B');

    await query(
      `INSERT INTO pages (confluence_id, space_key, title, body_text, body_html, quality_status)
       VALUES ('q2', $1, 'Page Two', $2, $3, 'pending')`,
      [testSpaceKey, content, `<p>${content}</p>`],
    );

    const second = await processBatch();
    expect(second).toBe(1);
    expect(providerSpy).toHaveBeenCalledTimes(2);
    expect(providerSpy.mock.calls[1]?.[1]).toBe('model-B');
  });

  it('getQualityStatus reports the resolved model', async () => {
    await upsertUsecaseLlmAssignments({
      quality: { provider: 'ollama', model: 'configured-model' },
    });

    const status = await getQualityStatus();
    expect(status.model).toBe('configured-model');
  });

  it('falls back to hardcoded qwen3:4b when nothing is configured', async () => {
    // Fresh DB, no env, no admin_settings — the resolver returns '' and the
    // worker's resolveQualityAssignment wrapper substitutes the hardcoded
    // default to preserve the prior behavior.
    const content =
      'This is a sufficiently long article body that exceeds the fifty character minimum threshold for quality analysis processing.';
    await query(
      `INSERT INTO pages (confluence_id, space_key, title, body_text, body_html, quality_status)
       VALUES ('q3', $1, 'Page Three', $2, $3, 'pending')`,
      [testSpaceKey, content, `<p>${content}</p>`],
    );

    const processed = await processBatch();
    expect(processed).toBe(1);

    expect(providerSpy).toHaveBeenCalledTimes(1);
    expect(providerSpy.mock.calls[0]?.[1]).toBe('qwen3:4b');
  });
});
