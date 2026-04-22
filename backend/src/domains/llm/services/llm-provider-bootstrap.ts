import { query } from '../../../core/db/postgres.js';
import { logger } from '../../../core/utils/logger.js';
import { encryptPat } from '../../../core/utils/crypto.js';
import { normalizeBaseUrl } from './llm-provider-service.js';
import { bumpProviderCacheVersion } from './cache-bus.js';

const DEPRECATED_VARS = [
  'OLLAMA_BASE_URL', 'OPENAI_BASE_URL', 'OPENAI_API_KEY', 'LLM_BEARER_TOKEN',
  'DEFAULT_LLM_MODEL', 'SUMMARY_MODEL', 'QUALITY_MODEL', 'EMBEDDING_MODEL',
];

export async function bootstrapLlmProviders(): Promise<void> {
  const count = await query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM llm_providers`);
  const isEmpty = count.rows[0]!.c === '0';

  if (isEmpty) {
    // Fresh install: seed from env.
    if (process.env.OLLAMA_BASE_URL) {
      await query(
        `INSERT INTO llm_providers (name, base_url, auth_type, verify_ssl, default_model)
         VALUES ($1,$2,'none',$3,$4)
         ON CONFLICT (name) DO NOTHING`,
        ['Ollama', normalizeBaseUrl(process.env.OLLAMA_BASE_URL),
         process.env.LLM_VERIFY_SSL !== 'false', process.env.DEFAULT_LLM_MODEL ?? null],
      );
    }
    if (process.env.OPENAI_BASE_URL || process.env.OPENAI_API_KEY) {
      const encryptedKey = process.env.OPENAI_API_KEY
        ? encryptPat(process.env.OPENAI_API_KEY) : null;
      await query(
        `INSERT INTO llm_providers (name, base_url, api_key, auth_type, verify_ssl, default_model)
         VALUES ($1,$2,$3,'bearer',$4,$5)
         ON CONFLICT (name) DO NOTHING`,
        ['OpenAI', normalizeBaseUrl(process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'),
         encryptedKey, process.env.LLM_VERIFY_SSL !== 'false', process.env.DEFAULT_LLM_MODEL ?? null],
      );
    }
  } else {
    // Existing install: rewrite the Ollama sentinel if env differs.
    if (process.env.OLLAMA_BASE_URL) {
      const expected = normalizeBaseUrl(process.env.OLLAMA_BASE_URL);
      await query(
        `UPDATE llm_providers SET base_url=$1, updated_at=NOW()
         WHERE name='Ollama' AND base_url='http://localhost:11434/v1' AND $1 <> 'http://localhost:11434/v1'`,
        [expected],
      );
    }
  }

  // Promote an oldest row to default if none is flagged.
  const hasDefault = await query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM llm_providers WHERE is_default`);
  if (hasDefault.rows[0]!.c === '0') {
    await query(
      `UPDATE llm_providers SET is_default=TRUE, updated_at=NOW()
       WHERE id = (SELECT id FROM llm_providers ORDER BY created_at ASC LIMIT 1)`,
    );
  }

  // Deprecation notices.
  for (const v of DEPRECATED_VARS) {
    if (process.env[v]) {
      logger.info({ envVar: v }, 'Deprecated LLM env var is set — it has no effect after migration 054. Configure providers in Settings → LLM.');
    }
  }

  bumpProviderCacheVersion();

  // Allowlist every configured provider URL with the ssrf-guard so client calls
  // from the resolver path aren't rejected.
  const { addAllowedBaseUrl } = await import('../../../core/utils/ssrf-guard.js');
  const rows = await query<{ base_url: string }>(`SELECT base_url FROM llm_providers`);
  for (const r of rows.rows) addAllowedBaseUrl(r.base_url);
}
