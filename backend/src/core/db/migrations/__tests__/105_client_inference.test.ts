import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../../../../test-db-helper.js';
import { query } from '../../postgres.js';

const dbAvailable = await isDbAvailable();
const migrationSql = await readFile(new URL('../105_client_inference.sql', import.meta.url), 'utf8');

describe.skipIf(!dbAvailable)('Migration 105 — client inference (#1418)', () => {
  beforeAll(async () => setupTestDb());
  afterAll(async () => teardownTestDb());
  beforeEach(async () => {
    await truncateAllTables();
    await query(migrationSql);
  });

  it('seeds admin_settings.client_inference_enabled as false', async () => {
    const { rows } = await query<{ setting_value: string }>(
      `SELECT setting_value FROM admin_settings WHERE setting_key = 'client_inference_enabled'`,
    );
    expect(rows[0]?.setting_value).toBe('false');
  });

  it('adds safe personal defaults for inference and spellcheck', async () => {
    const { rows: users } = await query<{ id: string }>(
      `INSERT INTO users (username, password_hash, role)
       VALUES ('client-inf-pref-user', 'h', 'user') RETURNING id`,
    );
    await query(`INSERT INTO user_settings (user_id) VALUES ($1)`, [users[0]!.id]);
    const { rows } = await query<{
      client_inference_enabled: boolean;
      client_inference_without_server: boolean;
      client_spellcheck_enabled: boolean;
      client_spellcheck_languages: unknown;
    }>(
      `SELECT client_inference_enabled, client_inference_without_server,
              client_spellcheck_enabled, client_spellcheck_languages
         FROM user_settings WHERE user_id = $1`,
      [users[0]!.id],
    );
    expect(rows[0]).toEqual({
      client_inference_enabled: false,
      client_inference_without_server: true,
      client_spellcheck_enabled: false,
      client_spellcheck_languages: ['en_US', 'de_DE'],
    });
  });

  it('rejects a language outside the closed Hunspell pair', async () => {
    const { rows: users } = await query<{ id: string }>(
      `INSERT INTO users (username, password_hash, role)
       VALUES ('client-inf-lang-user', 'h', 'user') RETURNING id`,
    );
    await query(`INSERT INTO user_settings (user_id) VALUES ($1)`, [users[0]!.id]);
    await expect(query(
      `UPDATE user_settings
          SET client_spellcheck_languages = $1::jsonb
        WHERE user_id = $2`,
      [JSON.stringify(['fr_FR']), users[0]!.id],
    )).rejects.toThrow();
  });

  it('does not add a client_inference LLM use case', async () => {
    await expect(
      query(`INSERT INTO llm_usecase_assignments (usecase) VALUES ('client_inference')`),
    ).rejects.toThrow();
  });
});
