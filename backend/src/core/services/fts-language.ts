import { FTS_LANGUAGES } from '@compendiq/contracts';
import { query } from '../db/postgres.js';
import { logger } from '../utils/logger.js';

/**
 * Allowed PostgreSQL text search configurations.
 *
 * Derived from the contracts enum rather than restated here, so the select in
 * Settings → AI Models → Retrieval, the `PUT /api/admin/settings` validation
 * and this reader can never offer, accept and honour three different lists.
 *
 * The membership check below is DEFENCE IN DEPTH and must stay: PostgreSQL has
 * no bind-parameter form for a `regconfig`, so the value this function returns
 * is INTERPOLATED into SQL by `rag-service.ts`, `routes/knowledge/search.ts`
 * and `routes/knowledge/pages-crud.ts`. The write path is already closed by
 * `UpdateAdminSettingsSchema`, but a row can also arrive from psql, a restored
 * dump or a future migration, and none of those pass through Zod.
 */
const ALLOWED_FTS_LANGUAGES: ReadonlySet<string> = new Set<string>(FTS_LANGUAGES);

/**
 * Returns the configured PostgreSQL text search configuration name.
 *
 * The `admin_settings.fts_language` row is the only source (#1114). There is
 * deliberately no `process.env.FTS_LANGUAGE` fallback: migration 049 seeds the
 * row on every instance, so the env var could never be reached and reading it
 * here only created a second, invisible source of truth that disagreed with
 * the Settings panel. `warnIfFtsLanguageEnvSet` reports a leftover value at
 * startup instead.
 */
export async function getFtsLanguage(): Promise<string> {
  const r = await query<{ setting_value: string }>(
    `SELECT setting_value FROM admin_settings WHERE setting_key='fts_language'`,
  );
  const lang = r.rows[0]?.setting_value ?? 'simple';
  if (!ALLOWED_FTS_LANGUAGES.has(lang)) {
    return 'simple';
  }
  return lang;
}

/**
 * Startup notice for the retired `FTS_LANGUAGE` environment variable (#1114).
 *
 * It is a WARN rather than an INFO because a set value is very likely a
 * *deliberate* attempt to index a non-English corpus in its own language —
 * one that has silently done nothing on every migrated instance.
 */
export function warnIfFtsLanguageEnvSet(): void {
  if (!process.env.FTS_LANGUAGE) return;
  logger.warn(
    { envVar: 'FTS_LANGUAGE', setting: 'fts_language' },
    'FTS_LANGUAGE is set but ignored — the keyword-index language is configured in Settings → AI Models → Retrieval (admin_settings.fts_language). It has had no effect since migration 049 seeded that row.',
  );
}

export { ALLOWED_FTS_LANGUAGES };
