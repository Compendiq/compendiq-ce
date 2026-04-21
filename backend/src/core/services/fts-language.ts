import { query } from '../db/postgres.js';

/**
 * Allowed PostgreSQL text search configurations.
 * Used to validate the fts_language admin setting before interpolating into SQL.
 */
const ALLOWED_FTS_LANGUAGES = new Set([
  'simple', 'english', 'german', 'french', 'spanish', 'italian',
  'portuguese', 'dutch', 'swedish', 'norwegian', 'danish', 'finnish',
  'hungarian', 'turkish', 'russian', 'arabic', 'romanian',
]);

/**
 * Returns the configured PostgreSQL text search configuration name.
 * Validated against an allowlist to prevent SQL injection (regconfig names
 * are interpolated into queries since PostgreSQL does not support parameterized regconfig).
 */
export async function getFtsLanguage(): Promise<string> {
  const r = await query<{ setting_value: string }>(
    `SELECT setting_value FROM admin_settings WHERE setting_key='fts_language'`,
  );
  const lang = r.rows[0]?.setting_value ?? process.env.FTS_LANGUAGE ?? 'simple';
  if (!ALLOWED_FTS_LANGUAGES.has(lang)) {
    return 'simple';
  }
  return lang;
}

export { ALLOWED_FTS_LANGUAGES };
