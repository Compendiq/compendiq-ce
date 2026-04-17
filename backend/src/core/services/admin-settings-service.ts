import { query, getPool } from '../db/postgres.js';
import { decryptPat, encryptPat } from '../utils/crypto.js';
import { logger } from '../utils/logger.js';

export type SharedLlmProvider = 'ollama' | 'openai';

/**
 * LLM use cases that can be individually assigned a provider/model override.
 * Mirror of `LlmUsecaseSchema` in `@compendiq/contracts` (kept duplicated here
 * to avoid adding a runtime dep on contracts in the core service layer).
 * See issue #214.
 */
export type LlmUsecase = 'chat' | 'summary' | 'quality' | 'auto_tag';

/** Result of the use-case resolver — always fully resolved, never undefined. */
export interface UsecaseLlmAssignment {
  provider: SharedLlmProvider;
  /** May be '' when no model is configured anywhere (fresh install, no env var). */
  model: string;
  source: {
    provider: 'usecase' | 'shared' | 'default';
    model: 'usecase' | 'shared' | 'env' | 'default';
  };
}

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

async function getAdminSettingsMap(keys: readonly string[]): Promise<Record<string, string>> {
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

    const upsertRows: Array<{ key: string; value: string }> = [];
    const deleteKeys: string[] = [];

    if (updates.llmProvider !== undefined) {
      upsertRows.push({ key: 'llm_provider', value: updates.llmProvider });
    }
    if (updates.ollamaModel !== undefined) {
      upsertRows.push({ key: 'ollama_model', value: updates.ollamaModel });
    }
    if (updates.openaiBaseUrl !== undefined) {
      if (updates.openaiBaseUrl) {
        upsertRows.push({ key: 'openai_base_url', value: updates.openaiBaseUrl });
      } else {
        deleteKeys.push('openai_base_url');
      }
    }
    if (updates.openaiApiKey !== undefined) {
      if (updates.openaiApiKey) {
        upsertRows.push({ key: 'openai_api_key', value: encryptPat(updates.openaiApiKey) });
      } else {
        deleteKeys.push('openai_api_key');
      }
    }
    if (updates.openaiModel !== undefined) {
      if (updates.openaiModel) {
        upsertRows.push({ key: 'openai_model', value: updates.openaiModel });
      } else {
        deleteKeys.push('openai_model');
      }
    }
    if (updates.embeddingModel !== undefined) {
      if (updates.embeddingModel) {
        upsertRows.push({ key: 'embedding_model', value: updates.embeddingModel });
      } else {
        deleteKeys.push('embedding_model');
      }
    }
    if (updates.ftsLanguage !== undefined) {
      if (updates.ftsLanguage) {
        upsertRows.push({ key: 'fts_language', value: updates.ftsLanguage });
      } else {
        deleteKeys.push('fts_language');
      }
    }

    // Batch upsert: single INSERT...ON CONFLICT using unnest() (#73)
    if (upsertRows.length > 0) {
      const keys = upsertRows.map((r) => r.key);
      const values = upsertRows.map((r) => r.value);
      await client.query(
        `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
         SELECT key, value, NOW()
         FROM unnest($1::text[], $2::text[]) AS t(key, value)
         ON CONFLICT (setting_key) DO UPDATE
         SET setting_value = EXCLUDED.setting_value, updated_at = NOW()`,
        [keys, values],
      );
    }

    // Batch delete: single DELETE with ANY() (#80)
    if (deleteKeys.length > 0) {
      await client.query(
        `DELETE FROM admin_settings WHERE setting_key = ANY($1::text[])`,
        [deleteKeys],
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

// ---------------------------------------------------------------------------
// Per-use-case LLM provider/model resolver (issue #214)
// ---------------------------------------------------------------------------

const USECASES: readonly LlmUsecase[] = ['chat', 'summary', 'quality', 'auto_tag'];

function usecaseProviderKey(usecase: LlmUsecase): string {
  return `llm_usecase_${usecase}_provider`;
}

function usecaseModelKey(usecase: LlmUsecase): string {
  return `llm_usecase_${usecase}_model`;
}

/**
 * Env-var bootstrap precedence for the model field per use case.
 * Each entry is consulted in order; the first truthy value wins.
 *
 * The comment in the plan calls this out explicitly: `SUMMARY_MODEL` for
 * summary, `QUALITY_MODEL` for quality, `DEFAULT_LLM_MODEL` as catch-all.
 */
function envBootstrapModelFor(usecase: LlmUsecase): string {
  const specific =
    usecase === 'summary'
      ? process.env.SUMMARY_MODEL
      : usecase === 'quality'
        ? process.env.QUALITY_MODEL
        : undefined;
  return specific || process.env.DEFAULT_LLM_MODEL || '';
}

/**
 * Set of use-case keys that have already been seeded from env during this
 * process lifetime. Prevents redundant writes on every resolver call.
 * Module-scoped — survives for the life of the Node process, resets on restart.
 */
const seededFromEnv = new Set<string>();

/** Test-only hook — allows the unit tests to simulate a fresh process. */
export function __resetUsecaseEnvSeedingForTests(): void {
  seededFromEnv.clear();
}

/**
 * One-shot write of an env bootstrap value into `admin_settings` using the
 * same `unnest()` upsert pattern as `upsertSharedLlmSettings`. Written with
 * `ON CONFLICT DO NOTHING` so a racing admin write never clobbers the
 * DB-backed value. Failures are logged and swallowed so a seeding error
 * cannot break the actual resolver call.
 */
async function seedUsecaseModelFromEnv(key: string, value: string): Promise<void> {
  if (seededFromEnv.has(key)) return;
  seededFromEnv.add(key);
  try {
    await query(
      `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
       SELECT k, v, NOW()
       FROM unnest($1::text[], $2::text[]) AS t(k, v)
       ON CONFLICT (setting_key) DO NOTHING`,
      [[key], [value]],
    );
    logger.info(
      { key, source: 'env' },
      'Seeded use-case LLM model from env var into admin_settings',
    );
  } catch (err) {
    // Unseed on failure so we can retry on the next call.
    seededFromEnv.delete(key);
    logger.warn(
      { err, key },
      'Failed to seed use-case LLM model from env var; resolver will fall back',
    );
  }
}

/**
 * Resolve the `{provider, model}` pair for a given LLM use case.
 *
 * Fallback order (per field, independent):
 *   Provider: usecase row → shared `llm_provider` → 'ollama'
 *   Model:    usecase row → shared model matching the resolved provider
 *             (`ollama_model` or `openai_model`) → env bootstrap
 *             (SUMMARY_MODEL / QUALITY_MODEL / DEFAULT_LLM_MODEL) → ''
 *
 * **No in-process cache** — each call hits `admin_settings`. This is a hard
 * requirement for the "changes take effect without restart" acceptance
 * criterion (see plan §2, "Caching strategy").
 */
export async function getUsecaseLlmAssignment(
  usecase: LlmUsecase,
): Promise<UsecaseLlmAssignment> {
  const pKey = usecaseProviderKey(usecase);
  const mKey = usecaseModelKey(usecase);

  // One round-trip: fetch shared defaults + this use case's overrides.
  const settings = await getAdminSettingsMap([
    pKey,
    mKey,
    'llm_provider',
    'ollama_model',
    'openai_model',
  ]);

  // --- Provider ---
  let provider: SharedLlmProvider;
  let providerSource: UsecaseLlmAssignment['source']['provider'];
  const rawUsecaseProvider = settings[pKey];
  if (rawUsecaseProvider === 'ollama' || rawUsecaseProvider === 'openai') {
    provider = rawUsecaseProvider;
    providerSource = 'usecase';
  } else if (settings['llm_provider'] === 'openai') {
    provider = 'openai';
    providerSource = 'shared';
  } else if (settings['llm_provider'] === 'ollama') {
    provider = 'ollama';
    providerSource = 'shared';
  } else {
    provider = 'ollama';
    providerSource = 'default';
  }

  // --- Model ---
  let model = '';
  let modelSource: UsecaseLlmAssignment['source']['model'] = 'default';

  const rawUsecaseModel = settings[mKey];
  if (rawUsecaseModel && rawUsecaseModel.length > 0) {
    model = rawUsecaseModel;
    modelSource = 'usecase';
  } else {
    // Shared default for the resolved provider.
    const sharedModel =
      provider === 'openai' ? settings['openai_model'] : settings['ollama_model'];
    if (sharedModel && sharedModel.length > 0) {
      model = sharedModel;
      modelSource = 'shared';
    } else {
      // Env bootstrap — and seed it into the DB so next time the shared-fallback
      // / usecase row wins and this branch stays cold.
      const envValue = envBootstrapModelFor(usecase);
      if (envValue) {
        model = envValue;
        modelSource = 'env';
        // Fire-and-wait (awaited) but non-fatal — we only seed once per process
        // per key so the cost is a single write on first access.
        await seedUsecaseModelFromEnv(mKey, envValue);
      }
      // else: model stays '' with source 'default'.
    }
  }

  return {
    provider,
    model,
    source: { provider: providerSource, model: modelSource },
  };
}

/**
 * Batch upsert for use-case assignments.
 *
 * Semantics per field:
 *   - `undefined` → leave the DB row untouched
 *   - `null`      → delete the DB row (revert to inherited default)
 *   - string/enum → upsert the DB row
 *
 * Reuses the same single-transaction `unnest()` upsert + `ANY()` delete pattern
 * as `upsertSharedLlmSettings`.
 */
export async function upsertUsecaseLlmAssignments(
  updates: Partial<
    Record<LlmUsecase, { provider?: SharedLlmProvider | null; model?: string | null }>
  >,
): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');

    const upsertRows: Array<{ key: string; value: string }> = [];
    const deleteKeys: string[] = [];

    for (const usecase of USECASES) {
      const patch = updates[usecase];
      if (!patch) continue;

      if (patch.provider !== undefined) {
        if (patch.provider === null) {
          deleteKeys.push(usecaseProviderKey(usecase));
        } else {
          upsertRows.push({ key: usecaseProviderKey(usecase), value: patch.provider });
        }
      }
      if (patch.model !== undefined) {
        if (patch.model === null || patch.model === '') {
          deleteKeys.push(usecaseModelKey(usecase));
        } else {
          upsertRows.push({ key: usecaseModelKey(usecase), value: patch.model });
        }
      }
    }

    if (upsertRows.length > 0) {
      const keys = upsertRows.map((r) => r.key);
      const values = upsertRows.map((r) => r.value);
      await client.query(
        `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
         SELECT key, value, NOW()
         FROM unnest($1::text[], $2::text[]) AS t(key, value)
         ON CONFLICT (setting_key) DO UPDATE
         SET setting_value = EXCLUDED.setting_value, updated_at = NOW()`,
        [keys, values],
      );
    }

    if (deleteKeys.length > 0) {
      await client.query(
        `DELETE FROM admin_settings WHERE setting_key = ANY($1::text[])`,
        [deleteKeys],
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

/**
 * Shape returned by `getAllUsecaseAssignments` — matches the payload expected
 * by the admin GET route (raw DB values + resolved values for each use case).
 */
export interface UsecaseAssignmentRow {
  /** Raw DB override or `null` if inheriting. */
  provider: SharedLlmProvider | null;
  /** Raw DB override or `null` if inheriting. */
  model: string | null;
  /** Fully resolved values (what the resolver returns right now). */
  resolved: {
    provider: SharedLlmProvider;
    model: string;
  };
}

/**
 * Fetch raw-DB and resolved values for all four use cases. One combined query
 * for all 8 keys (plus shared defaults) — used by `GET /admin/settings`.
 */
export async function getAllUsecaseAssignments(): Promise<
  Record<LlmUsecase, UsecaseAssignmentRow>
> {
  // Collect resolved values first (each call is its own query but resolver is
  // small and the admin settings page is not hot-path).
  const resolved = await Promise.all(
    USECASES.map((u) => getUsecaseLlmAssignment(u)),
  );

  // Then read raw DB values in a single query.
  const rawKeys = USECASES.flatMap((u) => [usecaseProviderKey(u), usecaseModelKey(u)]);
  const raw = await getAdminSettingsMap(rawKeys);

  const out = {} as Record<LlmUsecase, UsecaseAssignmentRow>;
  USECASES.forEach((usecase, idx) => {
    const rawProvider = raw[usecaseProviderKey(usecase)];
    const rawModel = raw[usecaseModelKey(usecase)];
    // `resolved[idx]` always exists because USECASES and `resolved` are
    // built together from the same array. Assert to appease the
    // noUncheckedIndexedAccess lint.
    const r = resolved[idx] as UsecaseLlmAssignment;
    out[usecase] = {
      provider:
        rawProvider === 'ollama' || rawProvider === 'openai' ? rawProvider : null,
      model: rawModel && rawModel.length > 0 ? rawModel : null,
      resolved: {
        provider: r.provider,
        model: r.model,
      },
    };
  });
  return out;
}
