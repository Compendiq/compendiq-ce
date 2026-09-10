import {
  LoginPageVariantSchema,
  type LoginPageVariant,
} from '@compendiq/contracts';
import { query } from '../db/postgres.js';
import { logger } from '../utils/logger.js';

const SETTING_KEY = 'login_page_variant';

export const DEFAULT_LOGIN_PAGE_VARIANT: LoginPageVariant = 'local-loop';

function parseVariant(value: string | null | undefined): LoginPageVariant | null {
  const parsed = LoginPageVariantSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Resolve the login presentation in this order:
 * persisted admin setting → deployment environment → safe product default.
 *
 * The read never throws because presentation configuration must never prevent
 * a visitor from reaching authentication.
 */
export async function getLoginPageVariant(): Promise<LoginPageVariant> {
  try {
    const result = await query<{ setting_value: string }>(
      'SELECT setting_value FROM admin_settings WHERE setting_key = $1',
      [SETTING_KEY],
    );
    const stored = parseVariant(result.rows[0]?.setting_value);
    if (stored) return stored;
  } catch (error) {
    logger.warn({ error }, 'Failed to read login page variant; using configured fallback');
  }

  return parseVariant(process.env.LOGIN_PAGE_VARIANT) ?? DEFAULT_LOGIN_PAGE_VARIANT;
}

export async function setLoginPageVariant(variant: LoginPageVariant): Promise<void> {
  await query(
    `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (setting_key)
     DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = NOW()`,
    [SETTING_KEY, variant],
  );
}
