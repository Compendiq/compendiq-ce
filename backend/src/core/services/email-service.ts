/**
 * Email notification service using Nodemailer SMTP.
 *
 * Configurable via admin_settings table (with env var fallbacks).
 * When SMTP is not configured, silently logs a warning and skips.
 *
 * Emails are sent fire-and-forget — callers do not await delivery.
 * A simple in-memory queue with concurrency limit prevents overwhelming
 * the SMTP server. For production deployments with BullMQ enabled,
 * emails could be routed through a BullMQ queue instead.
 */

import nodemailer, { type Transporter } from 'nodemailer';
import { logger } from '../utils/logger.js';
import { query } from '../db/postgres.js';
import { decryptPat, encryptPat, isEncryptedSecretFormat, reEncryptPat } from '../utils/crypto.js';
import { createCoalescedReloader } from './coalesced-reload.js';
import { isCacheBusActive, onReconnect, subscribe } from './redis-cache-bus.js';

// ─── Configuration ───────────────────────────────────────────────────────────

interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  enabled: boolean;
}

const DEFAULT_CONFIG: SmtpConfig = {
  host: process.env.SMTP_HOST ?? '',
  port: parseInt(process.env.SMTP_PORT ?? '587', 10),
  secure: process.env.SMTP_SECURE === 'true',
  user: process.env.SMTP_USER ?? '',
  pass: process.env.SMTP_PASS ?? '',
  from: process.env.SMTP_FROM ?? 'noreply@compendiq.local',
  enabled: process.env.SMTP_ENABLED === 'true',
};

const _config: SmtpConfig = { ...DEFAULT_CONFIG };
let _transporter: Transporter | null = null;

// ─── Transport management ────────────────────────────────────────────────────

function createTransport(config: SmtpConfig): Transporter {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user ? { user: config.user, pass: config.pass } : undefined,
  });
}

function getTransporter(): Transporter | null {
  if (!_config.enabled || !_config.host) {
    return null;
  }
  if (!_transporter) {
    _transporter = createTransport(_config);
  }
  return _transporter;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Masked-password sentinel returned by `getSmtpConfig()` and round-tripped
 * by the admin UI on save.
 */
export const SMTP_PASS_MASK = '••••••••';

/**
 * Strip the masked-password sentinel from a config patch (issue #743).
 *
 * The admin UI round-trips the mask from `GET /admin/smtp` when saving other
 * settings. Apply this guard once, before BOTH the live `updateSmtpConfig()`
 * call and the admin_settings persist, so the literal mask never overwrites
 * the real password. An empty string is kept so admins can still clear it.
 */
export function stripMaskedSmtpPass(config: Partial<SmtpConfig>): Partial<SmtpConfig> {
  if (config.pass !== SMTP_PASS_MASK) {
    return config;
  }
  const stripped = { ...config };
  delete stripped.pass;
  return stripped;
}

/**
 * Update SMTP configuration at runtime (from admin settings).
 */
export function updateSmtpConfig(config: Partial<SmtpConfig>): void {
  const prev = { ..._config };
  Object.assign(_config, config);

  // Recreate transport if connection settings changed
  if (
    prev.host !== _config.host ||
    prev.port !== _config.port ||
    prev.secure !== _config.secure ||
    prev.user !== _config.user ||
    prev.pass !== _config.pass
  ) {
    if (_transporter) {
      _transporter.close();
      _transporter = null;
    }
  }

  logger.info({ host: _config.host, port: _config.port, enabled: _config.enabled }, 'SMTP config updated');
}

/**
 * Get the current SMTP configuration (password masked).
 */
export function getSmtpConfig(): Omit<SmtpConfig, 'pass'> & { pass: string } {
  return {
    ..._config,
    pass: _config.pass ? SMTP_PASS_MASK : '',
  };
}

/**
 * Send an email. Fire-and-forget — errors are logged, not thrown.
 */
export async function sendEmail(
  to: string | string[],
  subject: string,
  html: string,
): Promise<boolean> {
  const transporter = getTransporter();
  if (!transporter) {
    logger.debug({ to, subject }, 'SMTP not configured, skipping email');
    return false;
  }

  try {
    const recipients = Array.isArray(to) ? to.join(', ') : to;
    await transporter.sendMail({
      from: _config.from,
      to: recipients,
      subject,
      html,
    });
    logger.info({ to: recipients, subject }, 'Email sent');
    return true;
  } catch (err) {
    logger.error({ err, to, subject }, 'Failed to send email');
    return false;
  }
}

/**
 * Send a test email to verify SMTP configuration.
 */
export async function sendTestEmail(to: string): Promise<{ success: boolean; error?: string }> {
  const transporter = getTransporter();
  if (!transporter) {
    return { success: false, error: 'SMTP not configured or disabled' };
  }

  try {
    await transporter.sendMail({
      from: _config.from,
      to,
      subject: 'Compendiq — SMTP Test Email',
      html: `
        <div style="font-family:sans-serif;padding:20px;">
          <h2 style="color:#6366f1;">SMTP Configuration Test</h2>
          <p>If you received this email, your SMTP settings are configured correctly.</p>
          <p style="color:#94a3b8;font-size:12px;">Sent by Compendiq</p>
        </div>
      `,
    });
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { success: false, error: message };
  }
}

/**
 * Resolve the smtp_pass value stored in admin_settings (issue #738).
 *
 * Values are persisted encrypted with the versioned `encryptPat()` helpers,
 * but rows written before encryption-at-rest landed contain the plaintext
 * password. Those are detected by format and kept working as-is. A value
 * that looks encrypted but fails to decrypt (e.g. its key version was
 * rotated away) is used verbatim so it is never double-encrypted; SMTP auth
 * will fail loudly instead of silently.
 *
 * `reEncrypted` carries the ciphertext the caller should write back to
 * admin_settings (conditionally on the value it read): the encryption of a
 * legacy plaintext row, or the upgrade of a ciphertext that decrypted under
 * a stale key version / the pre-HKDF derivation. The latter is defense in
 * depth for key rotation (#762 review follow-up): even if the rotation
 * endpoint's sweep was never run, smtp_pass converges onto the latest key
 * before the operator removes the old one. `null` = nothing to persist.
 */
function readStoredSmtpPass(stored: string): { pass: string; reEncrypted: string | null } {
  if (stored === '') {
    return { pass: '', reEncrypted: null };
  }
  if (!isEncryptedSecretFormat(stored)) {
    return { pass: stored, reEncrypted: encryptPat(stored) };
  }
  try {
    const pass = decryptPat(stored);
    // Upgrade-on-read: reEncryptPat() returns non-null only when the stored
    // ciphertext uses an old key version or the pre-HKDF derivation.
    return { pass, reEncrypted: reEncryptPat(stored) };
  } catch (err) {
    logger.warn({ err }, 'Stored smtp_pass looks encrypted but failed to decrypt; using the stored value as-is');
    return { pass: stored, reEncrypted: null };
  }
}

// ─── Loading from admin_settings (boot and every reload, #1757) ──────────────

/** Why a reload was requested. Diagnostic only: it reaches the failure log. */
export type SmtpReloadPhase = 'cold-load' | 'writer' | 'bus' | 'reconnect' | 'subscribe';

/**
 * One successful read of the smtp_* rows. `storedPass` and `reEncrypted` feed
 * the conditional re-encryption write-back. The object itself identifies the
 * run that read it (coalesced-reload S9), so the write-back starts once per
 * applied run however many requesters shared that run.
 */
interface SmtpLoad {
  config: SmtpConfig;
  storedPass: string | undefined;
  reEncrypted: string | null;
}

/**
 * Map the smtp_* rows onto a full configuration (D-1757-1). An absent row
 * falls back to the environment (`DEFAULT_CONFIG`), never to the current live
 * value, so the boot load and every later reload are the same function of the
 * database on every replica. Zero rows yield the environment defaults.
 */
function mapSmtpRows(settings: Record<string, string>): SmtpLoad {
  if (Object.keys(settings).length === 0) {
    return { config: { ...DEFAULT_CONFIG }, storedPass: undefined, reEncrypted: null };
  }
  const storedPass = settings['smtp_pass'];
  const passResult = storedPass !== undefined ? readStoredSmtpPass(storedPass) : null;
  return {
    config: {
      host: settings['smtp_host'] ?? DEFAULT_CONFIG.host,
      // An empty smtp_port row falls back like an absent one.
      port: settings['smtp_port'] ? parseInt(settings['smtp_port'], 10) : DEFAULT_CONFIG.port,
      // Unchanged (O-1): with at least one row but no smtp_secure row this is
      // false even when SMTP_SECURE=true.
      secure: settings['smtp_secure'] === 'true',
      user: settings['smtp_user'] ?? DEFAULT_CONFIG.user,
      pass: passResult ? passResult.pass : DEFAULT_CONFIG.pass,
      from: settings['smtp_from'] ?? DEFAULT_CONFIG.from,
      // DB value is authoritative when present (issue #743) — otherwise an
      // SMTP_ENABLED=true env bootstrap could never be disabled via the UI.
      enabled: settings['smtp_enabled'] !== undefined ? settings['smtp_enabled'] === 'true' : DEFAULT_CONFIG.enabled,
    },
    storedPass,
    reEncrypted: passResult?.reEncrypted ?? null,
  };
}

/**
 * Every load of the SMTP configuration (boot, writer, bus event, reconnect)
 * goes through this one serialized, coalesced reloader (#1758), so an older
 * read can never overwrite a newer one. `apply` only swaps the live config;
 * the re-encryption write-back runs after the run, outside the reloader.
 */
const reloadSmtpConfig = createCoalescedReloader<SmtpLoad, SmtpReloadPhase>({
  read: async () => {
    const result = await query<{ setting_key: string; setting_value: string }>(
      `SELECT setting_key, setting_value FROM admin_settings
       WHERE setting_key LIKE 'smtp_%'`,
      [],
    );
    const settings: Record<string, string> = {};
    for (const row of result.rows) {
      settings[row.setting_key] = row.setting_value;
    }
    return mapSmtpRows(settings);
  },
  apply: (load) => {
    updateSmtpConfig(load.config);
  },
  onFailure: (err, phase) => {
    logger.warn({ err, phase }, 'Failed to load SMTP settings from admin_settings');
  },
});

/** The write-back of each applied run, keyed by that run's value object. */
const reEncryptionWriteBacks = new WeakMap<SmtpLoad, Promise<void>>();

/**
 * Start the re-encryption write-back of an applied run unless it was already
 * started for that run; returns the run's write-back promise (never rejects).
 */
function startReEncryptionWriteBack(load: SmtpLoad): Promise<void> {
  let writeBack = reEncryptionWriteBacks.get(load);
  if (!writeBack) {
    writeBack = writeBackReEncryptedPass(load);
    reEncryptionWriteBacks.set(load, writeBack);
  }
  return writeBack;
}

// issue #738 — converge the at-rest value without the admin re-saving
// settings: encrypt legacy plaintext rows and upgrade ciphertexts that sit on
// a stale key version / pre-HKDF derivation. The UPDATE is conditional on the
// exact value read so a concurrent PUT /admin/smtp is never overwritten with a
// re-encryption of the OLD password (#762 review follow-up). Never published.
async function writeBackReEncryptedPass({ storedPass, reEncrypted }: SmtpLoad): Promise<void> {
  if (storedPass === undefined || !reEncrypted) {
    return;
  }
  try {
    const result = await query(
      `UPDATE admin_settings SET setting_value = $1, updated_at = NOW()
       WHERE setting_key = 'smtp_pass' AND setting_value = $2`,
      [reEncrypted, storedPass],
    );
    if (result.rowCount === 1) {
      logger.info('Re-encrypted smtp_pass in admin_settings with the latest encryption key');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to re-encrypt smtp_pass in admin_settings');
  }
}

/**
 * Re-read the smtp_* rows and apply them to the live configuration (#1757).
 * Resolves `true` when a read that started at or after this call was applied,
 * `false` when it failed (the previous configuration stays, a warning is
 * logged). Never rejects. Does not wait for the re-encryption write-back.
 */
export async function reloadSmtpConfigFromDb(phase: SmtpReloadPhase): Promise<boolean> {
  const outcome = await reloadSmtpConfig(phase);
  if (!outcome.ok) {
    return false;
  }
  void startReEncryptionWriteBack(outcome.value);
  return true;
}

/**
 * Reload the SMTP configuration whenever another replica saves it (cache-bus
 * `smtp:config:changed`) and after the bus reconnects (missed events are not
 * replayed, ADR-024). Must run after `initCacheBus`; resolves with one function
 * that removes both handlers.
 *
 * D-1757-2: with an active bus it also reloads once, awaited, which narrows
 * (does not close) the window between the boot load and the subscription.
 */
export async function subscribeSmtpConfigReload(): Promise<() => void> {
  const unsubscribeBus = subscribe('smtp:config:changed', async () => {
    await reloadSmtpConfigFromDb('bus');
  });
  const unsubscribeReconnect = onReconnect(async () => {
    await reloadSmtpConfigFromDb('reconnect');
  });
  if (isCacheBusActive()) {
    await reloadSmtpConfigFromDb('subscribe');
  }
  return () => {
    unsubscribeBus();
    unsubscribeReconnect();
  };
}

/**
 * Initialize SMTP config from admin_settings table (the boot cold-load).
 * Unlike other reloads it waits for its own re-encryption write-back.
 */
export async function initEmailService(): Promise<void> {
  const outcome = await reloadSmtpConfig('cold-load');
  if (outcome.ok) {
    await startReEncryptionWriteBack(outcome.value);
  }
}

/**
 * Close the SMTP transport (for graceful shutdown).
 */
export function closeEmailService(): void {
  if (_transporter) {
    _transporter.close();
    _transporter = null;
  }
}
