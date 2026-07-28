import { query } from '../db/postgres.js';
import { logger } from '../utils/logger.js';

/**
 * Issue #1051 — deployment-level self-registration policy.
 *
 * Compendiq lets an admin decide whether the public
 * `POST /api/auth/register` endpoint accepts new sign-ups once the initial
 * account exists. The policy is a single key-value row in `admin_settings`
 * (`registration_mode`), so there is NO dedicated migration.
 *
 *   - `open`   → any visitor may self-register.
 *   - `closed` → self-registration is rejected with 403 `registration_disabled`.
 *
 * The default is `closed`: a fresh install must not silently accept anonymous
 * sign-ups the moment the first admin appears. Registration is nonetheless
 * always allowed during **bootstrap** — i.e. before any real (non-sentinel)
 * admin exists — so the very first account can always be created regardless of
 * the stored mode.
 */

export type RegistrationMode = 'open' | 'closed';

/** Fail-safe default: registration is disabled once a real admin exists. */
export const DEFAULT_REGISTRATION_MODE: RegistrationMode = 'closed';

/**
 * System sentinel user seeded by migration 032 (`__system__`, role `admin`).
 * It owns built-in templates but is NOT a real operator, so every
 * "does a real admin exist?" predicate must exclude it — otherwise the
 * sentinel would be mistaken for the first admin and permanently break
 * first-account creation. Mirrors the predicate used by
 * `GET /api/health/setup-status` and `POST /api/setup/admin`.
 */
export const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Read the configured registration mode. Never throws: any DB error (or an
 * absent / unrecognised value) resolves to the fail-safe default `closed`.
 * Mirrors the never-throw style of `getAdminAccessDeniedRetentionDays`.
 */
export async function getRegistrationMode(): Promise<RegistrationMode> {
  try {
    const r = await query<{ setting_value: string }>(
      `SELECT setting_value FROM admin_settings WHERE setting_key = 'registration_mode'`,
    );
    return r.rows[0]?.setting_value === 'open' ? 'open' : 'closed';
  } catch (err) {
    logger.warn({ err }, 'Failed to read registration_mode; defaulting to closed');
    return DEFAULT_REGISTRATION_MODE;
  }
}

export interface EffectiveRegistrationPolicy {
  /** The stored mode (unaffected by the bootstrap allowance). */
  mode: RegistrationMode;
  /** Whether `POST /api/auth/register` should currently accept a new sign-up. */
  allowRegistration: boolean;
}

/**
 * Resolve the effective registration policy the register gate enforces.
 *
 * Registration is allowed when EITHER:
 *   - no real (non-sentinel) admin exists yet — bootstrap allowance, so the
 *     first account can always be created on a fresh install; OR
 *   - the stored mode is `open`.
 *
 * Never throws — a DB error falls back to `getRegistrationMode`'s default and,
 * for the admin-count probe, to treating the deployment as NON-bootstrap so we
 * fail closed rather than accidentally re-opening registration.
 */
export async function getEffectiveRegistrationPolicy(): Promise<EffectiveRegistrationPolicy> {
  const mode = await getRegistrationMode();

  let realAdminExists = true; // fail closed if the probe fails
  try {
    const r = await query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND id != $1`,
      [SYSTEM_USER_ID],
    );
    realAdminExists = parseInt(r.rows[0]?.count ?? '0', 10) > 0;
  } catch (err) {
    logger.warn({ err }, 'Failed to count admins for registration policy; treating as non-bootstrap');
    realAdminExists = true;
  }

  // Bootstrap: no real admin yet → always allow (first-account creation).
  if (!realAdminExists) {
    return { mode, allowRegistration: true };
  }

  return { mode, allowRegistration: mode === 'open' };
}
