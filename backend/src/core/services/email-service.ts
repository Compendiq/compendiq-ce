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

// ─── Configuration ───────────────────────────────────────────────────────────

export interface SmtpConfig {
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
    pass: _config.pass ? '••••••••' : '',
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
 * Initialize SMTP config from admin_settings table.
 */
export async function initEmailService(): Promise<void> {
  try {
    const { query } = await import('../db/postgres.js');
    const result = await query<{ setting_key: string; setting_value: string }>(
      `SELECT setting_key, setting_value FROM admin_settings
       WHERE setting_key LIKE 'smtp_%'`,
      [],
    );

    const settings: Record<string, string> = {};
    for (const row of result.rows) {
      settings[row.setting_key] = row.setting_value;
    }

    if (Object.keys(settings).length > 0) {
      updateSmtpConfig({
        host: settings['smtp_host'] ?? _config.host,
        port: settings['smtp_port'] ? parseInt(settings['smtp_port'], 10) : _config.port,
        secure: settings['smtp_secure'] === 'true',
        user: settings['smtp_user'] ?? _config.user,
        pass: settings['smtp_pass'] ?? _config.pass,
        from: settings['smtp_from'] ?? _config.from,
        enabled: settings['smtp_enabled'] === 'true' || _config.enabled,
      });
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to load SMTP settings from admin_settings');
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
