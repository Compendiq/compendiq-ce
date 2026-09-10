/**
 * Persist a Notion internal integration token encrypted at rest (#1462).
 *
 * Uses `encryptPat` / `decryptPat` (AES-256-GCM). Client-visible callers
 * must use {@link getNotionConnectionStatus} (`hasToken` only).
 */
import { query } from '../../../core/db/postgres.js';
import { decryptPat, encryptPat } from '../../../core/utils/crypto.js';
import { logger } from '../../../core/utils/logger.js';
import { NotionClient, NotionError } from './notion-client.js';

export interface NotionConnectionStatus {
  hasToken: boolean;
}

async function ensureUserSettingsRow(userId: string): Promise<void> {
  try {
    await query('INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
  } catch (err) {
    if ((err as { code?: string }).code !== '23503') throw err;
    logger.warn(
      { userId },
      'user_settings row-ensure hit a foreign-key violation (user likely deleted mid-request); treating as a no-op',
    );
  }
}

export async function getNotionConnectionStatus(userId: string): Promise<NotionConnectionStatus> {
  const result = await query<{ notion_integration_token: string | null }>(
    'SELECT notion_integration_token FROM user_settings WHERE user_id = $1',
    [userId],
  );
  return { hasToken: Boolean(result.rows[0]?.notion_integration_token) };
}

/**
 * Decrypt for server-side Notion HTTP only. Never feed this onto a route
 * response, log line, or toast.
 */
export async function getDecryptedNotionToken(userId: string): Promise<string | null> {
  const result = await query<{ notion_integration_token: string | null }>(
    'SELECT notion_integration_token FROM user_settings WHERE user_id = $1',
    [userId],
  );
  const stored = result.rows[0]?.notion_integration_token;
  if (!stored) return null;
  return decryptPat(stored);
}

export async function connectNotionToken(userId: string, token: string): Promise<NotionConnectionStatus> {
  const client = new NotionClient(token);
  try {
    await client.probe();
  } catch (err) {
    if (err instanceof NotionError) throw err;
    logger.warn({ err: err instanceof Error ? err.name : 'Error', userId }, 'Notion probe failed');
    throw err;
  }

  const ciphertext = encryptPat(token);
  await ensureUserSettingsRow(userId);
  const updated = await query(
    `UPDATE user_settings
        SET notion_integration_token = $1, updated_at = NOW()
      WHERE user_id = $2`,
    [ciphertext, userId],
  );
  return { hasToken: (updated.rowCount ?? 0) > 0 };
}

export async function disconnectNotionToken(userId: string): Promise<NotionConnectionStatus> {
  await query(
    `UPDATE user_settings
        SET notion_integration_token = NULL, updated_at = NOW()
      WHERE user_id = $1`,
    [userId],
  );
  return { hasToken: false };
}
