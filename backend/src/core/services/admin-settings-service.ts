import { query } from '../db/postgres.js';
import { decryptPat, encryptPat } from '../utils/crypto.js';

export type SharedLlmProvider = 'ollama' | 'openai';

export interface SharedLlmSettings {
  llmProvider: SharedLlmProvider;
  ollamaModel: string;
  openaiBaseUrl: string | null;
  hasOpenaiApiKey: boolean;
  openaiApiKey: string | null;
  openaiModel: string | null;
}

const DEFAULTS: SharedLlmSettings = {
  llmProvider: 'ollama',
  ollamaModel: 'qwen3.5',
  openaiBaseUrl: null,
  hasOpenaiApiKey: false,
  openaiApiKey: null,
  openaiModel: null,
};

const LLM_SETTING_KEYS = [
  'llm_provider',
  'ollama_model',
  'openai_base_url',
  'openai_api_key',
  'openai_model',
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

  let openaiApiKey: string | null = null;
  if (encryptedOpenaiApiKey) {
    try {
      openaiApiKey = decryptPat(encryptedOpenaiApiKey);
    } catch {
      openaiApiKey = null;
    }
  }

  return {
    llmProvider: settings['llm_provider'] === 'openai' ? 'openai' : DEFAULTS.llmProvider,
    ollamaModel: settings['ollama_model'] ?? DEFAULTS.ollamaModel,
    openaiBaseUrl: settings['openai_base_url'] ?? DEFAULTS.openaiBaseUrl,
    hasOpenaiApiKey: !!encryptedOpenaiApiKey,
    openaiApiKey,
    openaiModel: settings['openai_model'] ?? DEFAULTS.openaiModel,
  };
}

export async function upsertSharedLlmSettings(
  updates: Partial<Pick<SharedLlmSettings, 'llmProvider' | 'ollamaModel' | 'openaiBaseUrl' | 'openaiApiKey' | 'openaiModel'>>,
): Promise<void> {
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
      await query(`DELETE FROM admin_settings WHERE setting_key = 'openai_base_url'`);
    }
  }
  if (updates.openaiApiKey !== undefined) {
    if (updates.openaiApiKey) {
      rows.push({ key: 'openai_api_key', value: encryptPat(updates.openaiApiKey) });
    } else {
      await query(`DELETE FROM admin_settings WHERE setting_key = 'openai_api_key'`);
    }
  }
  if (updates.openaiModel !== undefined) {
    if (updates.openaiModel) {
      rows.push({ key: 'openai_model', value: updates.openaiModel });
    } else {
      await query(`DELETE FROM admin_settings WHERE setting_key = 'openai_model'`);
    }
  }

  for (const row of rows) {
    await query(
      `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (setting_key) DO UPDATE SET setting_value = $2, updated_at = NOW()`,
      [row.key, row.value],
    );
  }
}
