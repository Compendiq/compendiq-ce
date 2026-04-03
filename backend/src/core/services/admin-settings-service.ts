import { query, getPool } from '../db/postgres.js';
import { decryptPat, encryptPat } from '../utils/crypto.js';

export type SharedLlmProvider = 'ollama' | 'openai';

export interface SharedLlmSettings {
  llmProvider: SharedLlmProvider;
  ollamaModel: string;
  openaiBaseUrl: string | null;
  hasOpenaiApiKey: boolean;
  openaiModel: string | null;
  embeddingModel: string;
  embeddingDimensions: number;
  ftsLanguage: string;
}

const DEFAULTS: SharedLlmSettings = {
  llmProvider: 'ollama',
  ollamaModel: 'qwen3.5',
  openaiBaseUrl: null,
  hasOpenaiApiKey: false,
  openaiModel: null,
  embeddingModel: process.env.EMBEDDING_MODEL ?? 'bge-m3',
  embeddingDimensions: parseInt(process.env.EMBEDDING_DIMENSIONS ?? '1024', 10),
  ftsLanguage: process.env.FTS_LANGUAGE ?? 'simple',
};

const LLM_SETTING_KEYS = [
  'llm_provider',
  'ollama_model',
  'openai_base_url',
  'openai_api_key',
  'openai_model',
  'embedding_model',
  'embedding_dimensions',
  'fts_language',
] as const;

type AdminSettingKey = (typeof LLM_SETTING_KEYS)[number];

async function getAdminSettingsMap(keys: readonly AdminSettingKey[]): Promise<Record<string, string>> {
  const result = await query<{ setting_key: string; setting_value: string }>(
    `SELECT setting_key, setting_value
     FROM admin_settings
     WHERE setting_key = ANY($1::text[])`,
    [keys],
  );

  const map: Record<string, string> = {};
  for (const row of result.rows) {
    map[row.setting_key] = row.setting_value;
  }
  return map;
}

export async function getSharedLlmSettings(): Promise<SharedLlmSettings> {
  const settings = await getAdminSettingsMap(LLM_SETTING_KEYS);
  const encryptedOpenaiApiKey = settings['openai_api_key'] ?? null;

  return {
    llmProvider: settings['llm_provider'] === 'openai' ? 'openai' : DEFAULTS.llmProvider,
    ollamaModel: settings['ollama_model'] ?? DEFAULTS.ollamaModel,
    openaiBaseUrl: settings['openai_base_url'] ?? DEFAULTS.openaiBaseUrl,
    hasOpenaiApiKey: !!encryptedOpenaiApiKey,
    openaiModel: settings['openai_model'] ?? DEFAULTS.openaiModel,
    embeddingModel: settings['embedding_model'] ?? DEFAULTS.embeddingModel,
    embeddingDimensions: settings['embedding_dimensions'] ? parseInt(settings['embedding_dimensions'], 10) : DEFAULTS.embeddingDimensions,
    ftsLanguage: settings['fts_language'] ?? DEFAULTS.ftsLanguage,
  };
}

export async function getSharedOpenaiApiKey(): Promise<string | null> {
  const settings = await getAdminSettingsMap(['openai_api_key'] as const satisfies readonly AdminSettingKey[]);
  const encrypted = settings['openai_api_key'] ?? null;
  if (!encrypted) return null;
  try {
    return decryptPat(encrypted);
  } catch {
    return null;
  }
}

export async function upsertSharedLlmSettings(
  updates: Partial<Pick<SharedLlmSettings & { openaiApiKey: string | null }, 'llmProvider' | 'ollamaModel' | 'openaiBaseUrl' | 'openaiApiKey' | 'openaiModel' | 'embeddingModel' | 'ftsLanguage'>>,
): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');

    const rows: Array<{ key: string; value: string }> = [];

    if (updates.llmProvider !== undefined) {
      rows.push({ key: 'llm_provider', value: updates.llmProvider });
    }
    if (updates.ollamaModel !== undefined) {
      rows.push({ key: 'ollama_model', value: updates.ollamaModel });
    }
    if (updates.openaiBaseUrl !== undefined) {
      if (updates.openaiBaseUrl) {
        rows.push({ key: 'openai_base_url', value: updates.openaiBaseUrl });
      } else {
        await client.query(`DELETE FROM admin_settings WHERE setting_key = 'openai_base_url'`);
      }
    }
    if (updates.openaiApiKey !== undefined) {
      if (updates.openaiApiKey) {
        rows.push({ key: 'openai_api_key', value: encryptPat(updates.openaiApiKey) });
      } else {
        await client.query(`DELETE FROM admin_settings WHERE setting_key = 'openai_api_key'`);
      }
    }
    if (updates.openaiModel !== undefined) {
      if (updates.openaiModel) {
        rows.push({ key: 'openai_model', value: updates.openaiModel });
      } else {
        await client.query(`DELETE FROM admin_settings WHERE setting_key = 'openai_model'`);
      }
    }
    if (updates.embeddingModel !== undefined) {
      if (updates.embeddingModel) {
        rows.push({ key: 'embedding_model', value: updates.embeddingModel });
      } else {
        await client.query(`DELETE FROM admin_settings WHERE setting_key = 'embedding_model'`);
      }
    }
    if (updates.ftsLanguage !== undefined) {
      if (updates.ftsLanguage) {
        rows.push({ key: 'fts_language', value: updates.ftsLanguage });
      } else {
        await client.query(`DELETE FROM admin_settings WHERE setting_key = 'fts_language'`);
      }
    }

    for (const row of rows) {
      await client.query(
        `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (setting_key) DO UPDATE SET setting_value = $2, updated_at = NOW()`,
        [row.key, row.value],
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
