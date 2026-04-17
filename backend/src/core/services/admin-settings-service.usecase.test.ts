import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import {
  setupTestDb,
  truncateAllTables,
  teardownTestDb,
  isDbAvailable,
} from '../../test-db-helper.js';
import { query } from '../db/postgres.js';
import {
  getUsecaseLlmAssignment,
  upsertUsecaseLlmAssignments,
  getAllUsecaseAssignments,
  __resetUsecaseEnvSeedingForTests,
} from './admin-settings-service.js';

const dbAvailable = await isDbAvailable();

/**
 * Real-PostgreSQL integration tests for the per-use-case LLM resolver.
 * Pins down the fallback order from plan §2 / issue #214.
 */
describe.skipIf(!dbAvailable)('admin-settings-service — per-use-case LLM resolver', () => {
  // Preserve the test-runner env so we can freely mutate and restore.
  let savedEnv: Record<string, string | undefined>;

  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    __resetUsecaseEnvSeedingForTests();
    savedEnv = {
      SUMMARY_MODEL: process.env.SUMMARY_MODEL,
      QUALITY_MODEL: process.env.QUALITY_MODEL,
      DEFAULT_LLM_MODEL: process.env.DEFAULT_LLM_MODEL,
    };
    delete process.env.SUMMARY_MODEL;
    delete process.env.QUALITY_MODEL;
    delete process.env.DEFAULT_LLM_MODEL;
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

  // -------------------------------------------------------------------------
  // Fallback order — one test per rung of the ladder.
  // -------------------------------------------------------------------------

  describe('fallback order', () => {
    it('rung 1 — usecase row wins when both usecase + shared are set', async () => {
      // shared default: openai / gpt-4o-mini
      await insertSetting('llm_provider', 'openai');
      await insertSetting('openai_model', 'gpt-4o-mini');
      // usecase override: ollama / qwen3:4b
      await insertSetting('llm_usecase_summary_provider', 'ollama');
      await insertSetting('llm_usecase_summary_model', 'qwen3:4b');

      const result = await getUsecaseLlmAssignment('summary');

      expect(result.provider).toBe('ollama');
      expect(result.model).toBe('qwen3:4b');
      expect(result.source).toEqual({ provider: 'usecase', model: 'usecase' });
    });

    it('rung 2 — shared default fills when usecase row is absent', async () => {
      await insertSetting('llm_provider', 'openai');
      await insertSetting('openai_model', 'gpt-4o');

      const result = await getUsecaseLlmAssignment('chat');

      expect(result.provider).toBe('openai');
      expect(result.model).toBe('gpt-4o');
      expect(result.source).toEqual({ provider: 'shared', model: 'shared' });
    });

    it('rung 3a — env bootstrap (SUMMARY_MODEL) when DB has neither shared nor usecase model', async () => {
      process.env.SUMMARY_MODEL = 'llama3:8b';

      const result = await getUsecaseLlmAssignment('summary');

      // Provider falls back to default ollama; model comes from env.
      expect(result.provider).toBe('ollama');
      expect(result.model).toBe('llama3:8b');
      expect(result.source.model).toBe('env');
    });

    it('rung 3b — env bootstrap (QUALITY_MODEL) only applies to quality', async () => {
      process.env.QUALITY_MODEL = 'quality-model';

      const quality = await getUsecaseLlmAssignment('quality');
      expect(quality.model).toBe('quality-model');
      expect(quality.source.model).toBe('env');

      // Fresh resolver call for a different use case — QUALITY_MODEL must NOT leak.
      const chat = await getUsecaseLlmAssignment('chat');
      expect(chat.model).toBe('');
      expect(chat.source.model).toBe('default');
    });

    it('rung 3c — DEFAULT_LLM_MODEL applies to all use cases when no specific env var set', async () => {
      process.env.DEFAULT_LLM_MODEL = 'default-fallback';

      for (const usecase of ['chat', 'summary', 'quality', 'auto_tag'] as const) {
        __resetUsecaseEnvSeedingForTests();
        await query(`DELETE FROM admin_settings WHERE setting_key LIKE 'llm_usecase_%'`);
        const r = await getUsecaseLlmAssignment(usecase);
        expect(r.model, `usecase=${usecase}`).toBe('default-fallback');
        expect(r.source.model).toBe('env');
      }
    });

    it('rung 3d — env bootstrap seeds the DB so subsequent calls read from DB', async () => {
      process.env.SUMMARY_MODEL = 'seed-me';

      // First call: reads from env.
      const first = await getUsecaseLlmAssignment('summary');
      expect(first.source.model).toBe('env');
      expect(first.model).toBe('seed-me');

      // After the first call, the DB row should now exist.
      const row = await query<{ setting_value: string }>(
        `SELECT setting_value FROM admin_settings WHERE setting_key = 'llm_usecase_summary_model'`,
      );
      expect(row.rows).toHaveLength(1);
      expect(row.rows[0]!.setting_value).toBe('seed-me');

      // Mutate env — DB row should now win even with a different env value.
      process.env.SUMMARY_MODEL = 'different-env-value';
      // Simulate a restart (seeded set is re-initialized per process).
      __resetUsecaseEnvSeedingForTests();
      const second = await getUsecaseLlmAssignment('summary');
      expect(second.model).toBe('seed-me');
      expect(second.source.model).toBe('usecase');
    });

    it('rung 4 — empty string when no DB, no env var, nothing set', async () => {
      const result = await getUsecaseLlmAssignment('auto_tag');

      expect(result.provider).toBe('ollama');
      expect(result.model).toBe('');
      expect(result.source).toEqual({ provider: 'default', model: 'default' });
    });
  });

  // -------------------------------------------------------------------------
  // Cross-field fallback — provider and model resolve independently.
  // -------------------------------------------------------------------------

  describe('independent provider/model resolution', () => {
    it('null provider override + set model override → provider comes from shared default', async () => {
      // Shared default provider = openai; no shared model for openai
      await insertSetting('llm_provider', 'openai');
      await insertSetting('openai_model', 'gpt-4o-shared');
      // Usecase override: only model, no provider row
      await insertSetting('llm_usecase_summary_model', 'custom-model');

      const result = await getUsecaseLlmAssignment('summary');

      expect(result.provider).toBe('openai'); // from shared
      expect(result.model).toBe('custom-model'); // from usecase
      expect(result.source).toEqual({ provider: 'shared', model: 'usecase' });
    });

    it('set provider override + no model override → model comes from shared for the override provider', async () => {
      // Shared: ollama / qwen3.5 — but also an openai_model row that will be picked when provider=openai.
      await insertSetting('llm_provider', 'ollama');
      await insertSetting('ollama_model', 'qwen3.5');
      await insertSetting('openai_model', 'gpt-4o-for-openai');
      // Usecase override: provider = openai, no model row.
      await insertSetting('llm_usecase_chat_provider', 'openai');

      const result = await getUsecaseLlmAssignment('chat');

      expect(result.provider).toBe('openai'); // from usecase
      expect(result.model).toBe('gpt-4o-for-openai'); // from shared openai_model
      expect(result.source).toEqual({ provider: 'usecase', model: 'shared' });
    });
  });

  // -------------------------------------------------------------------------
  // No in-process cache — DB changes visible without restart.
  // -------------------------------------------------------------------------

  describe('no in-process cache', () => {
    it('picks up a DB write on the very next call (no cache)', async () => {
      await insertSetting('llm_provider', 'ollama');
      await insertSetting('ollama_model', 'model-A');

      const first = await getUsecaseLlmAssignment('quality');
      expect(first.model).toBe('model-A');

      // Admin flips the shared model — without restarting the process.
      await query(
        `UPDATE admin_settings SET setting_value = 'model-B' WHERE setting_key = 'ollama_model'`,
      );

      const second = await getUsecaseLlmAssignment('quality');
      expect(second.model).toBe('model-B');
    });
  });

  // -------------------------------------------------------------------------
  // Upsert helper — batch upsert + null-delete semantics.
  // -------------------------------------------------------------------------

  describe('upsertUsecaseLlmAssignments', () => {
    it('upserts multiple use cases in a single transaction', async () => {
      await upsertUsecaseLlmAssignments({
        chat: { provider: 'openai', model: 'gpt-4o' },
        summary: { provider: 'ollama', model: 'qwen3:4b' },
      });

      const rows = await query<{ setting_key: string; setting_value: string }>(
        `SELECT setting_key, setting_value
           FROM admin_settings
          WHERE setting_key LIKE 'llm_usecase_%'
          ORDER BY setting_key`,
      );
      const map = Object.fromEntries(rows.rows.map((r) => [r.setting_key, r.setting_value]));
      expect(map['llm_usecase_chat_provider']).toBe('openai');
      expect(map['llm_usecase_chat_model']).toBe('gpt-4o');
      expect(map['llm_usecase_summary_provider']).toBe('ollama');
      expect(map['llm_usecase_summary_model']).toBe('qwen3:4b');
      // Keys we didn't set should not exist.
      expect(map['llm_usecase_quality_provider']).toBeUndefined();
      expect(map['llm_usecase_auto_tag_model']).toBeUndefined();
    });

    it('null deletes the DB row (revert to inherited default)', async () => {
      // Seed two overrides.
      await upsertUsecaseLlmAssignments({
        chat: { provider: 'openai', model: 'gpt-4o' },
      });

      // Clear the provider but leave the model untouched.
      await upsertUsecaseLlmAssignments({
        chat: { provider: null },
      });

      const rows = await query<{ setting_key: string }>(
        `SELECT setting_key
           FROM admin_settings
          WHERE setting_key IN ('llm_usecase_chat_provider', 'llm_usecase_chat_model')
          ORDER BY setting_key`,
      );
      expect(rows.rows.map((r) => r.setting_key)).toEqual(['llm_usecase_chat_model']);
    });

    it('empty string is treated the same as null (clears the row)', async () => {
      await upsertUsecaseLlmAssignments({
        quality: { provider: 'openai', model: 'gpt-4o' },
      });
      await upsertUsecaseLlmAssignments({
        quality: { model: '' },
      });

      const rows = await query(
        `SELECT setting_key FROM admin_settings WHERE setting_key = 'llm_usecase_quality_model'`,
      );
      expect(rows.rows).toHaveLength(0);
    });

    it('undefined fields leave existing DB rows untouched', async () => {
      await upsertUsecaseLlmAssignments({
        auto_tag: { provider: 'openai', model: 'gpt-4o' },
      });
      // Patch only the model — provider must remain.
      await upsertUsecaseLlmAssignments({
        auto_tag: { model: 'gpt-4o-mini' },
      });

      const rows = await query<{ setting_key: string; setting_value: string }>(
        `SELECT setting_key, setting_value
           FROM admin_settings
          WHERE setting_key LIKE 'llm_usecase_auto_tag_%'
          ORDER BY setting_key`,
      );
      const map = Object.fromEntries(rows.rows.map((r) => [r.setting_key, r.setting_value]));
      expect(map['llm_usecase_auto_tag_provider']).toBe('openai');
      expect(map['llm_usecase_auto_tag_model']).toBe('gpt-4o-mini');
    });
  });

  // -------------------------------------------------------------------------
  // getAllUsecaseAssignments — combined payload shape for the admin GET.
  // -------------------------------------------------------------------------

  describe('getAllUsecaseAssignments', () => {
    it('returns raw DB values + resolved values for each of the 4 use cases', async () => {
      await insertSetting('llm_provider', 'ollama');
      await insertSetting('ollama_model', 'qwen3.5');
      await insertSetting('llm_usecase_chat_provider', 'openai');
      await insertSetting('llm_usecase_chat_model', 'gpt-4o');
      await insertSetting('llm_usecase_summary_model', 'summary-custom');

      const all = await getAllUsecaseAssignments();

      // chat fully overridden
      expect(all.chat.provider).toBe('openai');
      expect(all.chat.model).toBe('gpt-4o');
      expect(all.chat.resolved).toEqual({ provider: 'openai', model: 'gpt-4o' });

      // summary: model override only, provider inherits
      expect(all.summary.provider).toBeNull();
      expect(all.summary.model).toBe('summary-custom');
      expect(all.summary.resolved).toEqual({ provider: 'ollama', model: 'summary-custom' });

      // quality: pure inherit
      expect(all.quality.provider).toBeNull();
      expect(all.quality.model).toBeNull();
      expect(all.quality.resolved).toEqual({ provider: 'ollama', model: 'qwen3.5' });

      // auto_tag: pure inherit
      expect(all.auto_tag.provider).toBeNull();
      expect(all.auto_tag.model).toBeNull();
      expect(all.auto_tag.resolved).toEqual({ provider: 'ollama', model: 'qwen3.5' });
    });
  });
});

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

async function insertSetting(key: string, value: string): Promise<void> {
  await query(
    `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (setting_key) DO UPDATE
       SET setting_value = EXCLUDED.setting_value, updated_at = NOW()`,
    [key, value],
  );
}
