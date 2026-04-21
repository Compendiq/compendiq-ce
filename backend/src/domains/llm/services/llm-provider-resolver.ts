import { query } from '../../../core/db/postgres.js';
import { decryptPat } from '../../../core/utils/crypto.js';
import { invalidateDispatcher, invalidateBreaker, type ProviderConfig } from './openai-compatible-client.js';
import { getProviderCacheVersion, onProviderCacheBump } from './cache-bus.js';
import type { LlmUsecase } from '@compendiq/contracts';

interface ResolveRow {
  usecase_provider_id: string | null;
  usecase_model: string | null;
  provider_id: string;
  provider_name: string;
  provider_base_url: string;
  provider_api_key: string | null;
  provider_auth_type: 'bearer' | 'none';
  provider_verify_ssl: boolean;
  provider_default_model: string | null;
  provider_is_default: boolean;
}

interface Resolved {
  config: ProviderConfig & { id: string; name: string; defaultModel: string | null };
  model: string;
}

// In-memory cache of provider configs keyed by id, invalidated by version bump.
const configCache = new Map<string, { version: number; cfg: ProviderConfig & { id: string; name: string; defaultModel: string | null } }>();

onProviderCacheBump(() => {
  // Also close any pooled undici dispatchers for those providers (they'll be
  // re-created on the next resolveUsecase/listProviders call) and drop their
  // per-provider circuit breakers so stale failure state doesn't carry over
  // against the new configuration.
  for (const entry of configCache.values()) {
    invalidateDispatcher(entry.cfg.providerId);
    invalidateBreaker(entry.cfg.providerId);
  }
  configCache.clear();
});

function decryptSafe(s: string | null): string | null {
  if (!s) return null;
  try { return decryptPat(s); } catch { return null; }
}

export async function resolveUsecase(usecase: LlmUsecase): Promise<Resolved> {
  // One round-trip: pull the use-case row + the default provider + the chosen
  // provider (if any) in a single query using a CTE.
  const sql = `
    WITH assignment AS (
      SELECT provider_id, model FROM llm_usecase_assignments WHERE usecase=$1
    ),
    target AS (
      SELECT p.*
      FROM llm_providers p
      WHERE p.id = (SELECT provider_id FROM assignment)
      UNION ALL
      SELECT p.*
      FROM llm_providers p
      WHERE p.is_default
        AND NOT EXISTS (SELECT 1 FROM assignment WHERE provider_id IS NOT NULL)
      LIMIT 1
    )
    SELECT
      a.provider_id AS usecase_provider_id,
      a.model       AS usecase_model,
      t.id          AS provider_id,
      t.name        AS provider_name,
      t.base_url    AS provider_base_url,
      t.api_key     AS provider_api_key,
      t.auth_type   AS provider_auth_type,
      t.verify_ssl  AS provider_verify_ssl,
      t.default_model AS provider_default_model,
      t.is_default  AS provider_is_default
    FROM target t
    LEFT JOIN assignment a ON TRUE
  `;
  const r = await query<ResolveRow>(sql, [usecase]);
  const row = r.rows[0];
  if (!row) throw new Error('No default provider configured — set one in Settings → LLM.');

  const cacheKey = row.provider_id;
  let cached = configCache.get(cacheKey);
  if (!cached || cached.version !== getProviderCacheVersion()) {
    cached = {
      version: getProviderCacheVersion(),
      cfg: {
        providerId: row.provider_id,
        id: row.provider_id,
        name: row.provider_name,
        baseUrl: row.provider_base_url,
        apiKey: decryptSafe(row.provider_api_key),
        authType: row.provider_auth_type,
        verifySsl: row.provider_verify_ssl,
        defaultModel: row.provider_default_model,
      },
    };
    configCache.set(cacheKey, cached);
  }

  const model = row.usecase_model ?? cached.cfg.defaultModel ?? '';
  return { config: cached.cfg, model };
}
