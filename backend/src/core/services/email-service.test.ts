import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomBytes, createCipheriv } from 'crypto';

vi.mock('nodemailer', () => {
  const sendMail = vi.fn().mockResolvedValue({ messageId: 'test-123' });
  const close = vi.fn();
  return {
    default: {
      createTransport: vi.fn().mockReturnValue({ sendMail, close }),
    },
  };
});

const mockDbQuery = vi.fn().mockResolvedValue({ rows: [] });

vi.mock('../db/postgres.js', () => ({
  query: (...args: unknown[]) => mockDbQuery(...args),
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import nodemailer from 'nodemailer';
import { encryptPat, decryptPat } from '../utils/crypto.js';

describe('email-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Some #738 tests register a higher key version to simulate rotation.
    delete process.env.PAT_ENCRYPTION_KEY_V1;
  });

  it('sendEmail returns false when SMTP is not configured', async () => {
    const { sendEmail, updateSmtpConfig } = await import('./email-service.js');
    updateSmtpConfig({ enabled: false, host: '' });
    const result = await sendEmail('test@example.com', 'Test', '<p>Hello</p>');
    expect(result).toBe(false);
  });

  it('sendEmail sends when SMTP is configured', async () => {
    const { sendEmail, updateSmtpConfig } = await import('./email-service.js');
    updateSmtpConfig({ enabled: true, host: 'smtp.test.com', port: 587, user: 'user', pass: 'pass' });
    const result = await sendEmail('test@example.com', 'Test Subject', '<p>Hello</p>');
    expect(result).toBe(true);
  });

  it('getSmtpConfig masks the password', async () => {
    const { getSmtpConfig, updateSmtpConfig } = await import('./email-service.js');
    updateSmtpConfig({ pass: 'secret-password' });
    const config = getSmtpConfig();
    expect(config.pass).toBe('••••••••');
  });

  it('sendTestEmail returns error when SMTP is not configured', async () => {
    const { sendTestEmail, updateSmtpConfig } = await import('./email-service.js');
    updateSmtpConfig({ enabled: false, host: '' });
    const result = await sendTestEmail('admin@test.com');
    expect(result.success).toBe(false);
    expect(result.error).toContain('not configured');
  });

  // issue #743 — the masked-password sentinel round-tripped by the admin UI
  // must never overwrite the real password (live transport or DB persist).
  describe('stripMaskedSmtpPass (#743)', () => {
    it('removes the masked sentinel from a config patch', async () => {
      const { stripMaskedSmtpPass, SMTP_PASS_MASK } = await import('./email-service.js');
      const stripped = stripMaskedSmtpPass({ host: 'smtp.test.com', pass: SMTP_PASS_MASK });
      expect(stripped.pass).toBeUndefined();
      expect(stripped.host).toBe('smtp.test.com');
    });

    it('keeps a real password untouched', async () => {
      const { stripMaskedSmtpPass } = await import('./email-service.js');
      expect(stripMaskedSmtpPass({ pass: 'real-secret' }).pass).toBe('real-secret');
    });

    it('keeps an empty password so admins can still clear it', async () => {
      const { stripMaskedSmtpPass } = await import('./email-service.js');
      expect(stripMaskedSmtpPass({ pass: '' }).pass).toBe('');
    });

    it('leaves a patch without pass untouched', async () => {
      const { stripMaskedSmtpPass } = await import('./email-service.js');
      expect(stripMaskedSmtpPass({ host: 'smtp.test.com' })).toEqual({ host: 'smtp.test.com' });
    });
  });

  // issue #743 — the DB value must be authoritative when present; previously
  // `smtp_enabled === 'true' || _config.enabled` meant SMTP_ENABLED=true in
  // env could never be disabled via the admin UI across restarts.
  describe('initEmailService smtp_enabled precedence (#743)', () => {
    it('smtp_enabled=false in DB disables SMTP even when env enabled it', async () => {
      const { initEmailService, updateSmtpConfig, getSmtpConfig } = await import('./email-service.js');
      updateSmtpConfig({ enabled: true }); // simulates SMTP_ENABLED=true bootstrap
      mockDbQuery.mockResolvedValueOnce({
        rows: [{ setting_key: 'smtp_enabled', setting_value: 'false' }],
      });
      await initEmailService();
      expect(getSmtpConfig().enabled).toBe(false);
    });

    it('smtp_enabled=true in DB enables SMTP even when env did not', async () => {
      const { initEmailService, updateSmtpConfig, getSmtpConfig } = await import('./email-service.js');
      updateSmtpConfig({ enabled: false });
      mockDbQuery.mockResolvedValueOnce({
        rows: [{ setting_key: 'smtp_enabled', setting_value: 'true' }],
      });
      await initEmailService();
      expect(getSmtpConfig().enabled).toBe(true);
    });

    it('falls back to the current (env) value when smtp_enabled is absent from DB', async () => {
      const { initEmailService, updateSmtpConfig, getSmtpConfig } = await import('./email-service.js');
      updateSmtpConfig({ enabled: true });
      mockDbQuery.mockResolvedValueOnce({
        rows: [{ setting_key: 'smtp_host', setting_value: 'db.example.com' }],
      });
      await initEmailService();
      expect(getSmtpConfig().enabled).toBe(true);
    });
  });

  // issue #738 — smtp_pass is stored encrypted in admin_settings; legacy rows
  // written before this change are plaintext and must keep working (and get
  // re-encrypted at rest on startup).
  describe('initEmailService smtp_pass encryption at rest (#738)', () => {
    const lastTransportOptions = (): { auth?: { user: string; pass: string } } => {
      const calls = (nodemailer.createTransport as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      return calls[calls.length - 1][0] as { auth?: { user: string; pass: string } };
    };

    const findWriteBack = () =>
      mockDbQuery.mock.calls.find(
        ([sql]) => typeof sql === 'string' && sql.includes('UPDATE admin_settings'),
      );

    it('decrypts an encrypted smtp_pass from admin_settings', async () => {
      const { initEmailService, sendEmail } = await import('./email-service.js');
      mockDbQuery.mockResolvedValueOnce({
        rows: [
          { setting_key: 'smtp_host', setting_value: 'db.example.com' },
          { setting_key: 'smtp_user', setting_value: 'mailer' },
          { setting_key: 'smtp_pass', setting_value: encryptPat('db-secret') },
          { setting_key: 'smtp_enabled', setting_value: 'true' },
        ],
      });

      await initEmailService();
      await sendEmail('x@example.com', 'subject', '<p>hi</p>');

      expect(lastTransportOptions().auth?.pass).toBe('db-secret');
      // Already encrypted — nothing to migrate.
      expect(findWriteBack()).toBeUndefined();
    });

    it('treats a legacy plaintext smtp_pass as the password and re-encrypts it at rest', async () => {
      const { initEmailService, sendEmail } = await import('./email-service.js');
      mockDbQuery.mockResolvedValueOnce({
        rows: [
          { setting_key: 'smtp_host', setting_value: 'db.example.com' },
          { setting_key: 'smtp_user', setting_value: 'mailer' },
          { setting_key: 'smtp_pass', setting_value: 'plain-old-secret' },
          { setting_key: 'smtp_enabled', setting_value: 'true' },
        ],
      });

      await initEmailService();

      // The plaintext value keeps working as the live password...
      await sendEmail('x@example.com', 'subject', '<p>hi</p>');
      expect(lastTransportOptions().auth?.pass).toBe('plain-old-secret');

      // ...and is re-encrypted in admin_settings — conditional on the exact
      // value read, so a concurrent PUT /admin/smtp during startup is never
      // overwritten with a re-encryption of the OLD password (#762 review).
      const writeBack = findWriteBack();
      expect(writeBack).toBeDefined();
      const [sql, params] = writeBack! as [string, string[]];
      expect(sql).toContain('setting_value = $2');
      expect(params[1]).toBe('plain-old-secret');
      const persisted = params[0];
      expect(persisted).toMatch(/^h\d+:/);
      expect(decryptPat(persisted)).toBe('plain-old-secret');
    });

    // #762 review follow-up — the documented rotation procedure (rotate key,
    // remove old key) must not strand smtp_pass: a value that decrypts with a
    // NON-latest key version is upgraded on read, defense in depth alongside
    // the rotation endpoint's admin_settings sweep.
    it('re-encrypts a smtp_pass stored under a stale key version, conditional on the read value', async () => {
      const { initEmailService, sendEmail } = await import('./email-service.js');
      const staleCipher = encryptPat('rotate-me'); // h0 under PAT_ENCRYPTION_KEY
      process.env.PAT_ENCRYPTION_KEY_V1 = 'versioned-key-one-at-least-32-chars!!';

      mockDbQuery.mockResolvedValueOnce({
        rows: [
          { setting_key: 'smtp_host', setting_value: 'db.example.com' },
          { setting_key: 'smtp_user', setting_value: 'mailer' },
          { setting_key: 'smtp_pass', setting_value: staleCipher },
          { setting_key: 'smtp_enabled', setting_value: 'true' },
        ],
      });

      await initEmailService();

      // The decrypted password is live...
      await sendEmail('x@example.com', 'subject', '<p>hi</p>');
      expect(lastTransportOptions().auth?.pass).toBe('rotate-me');

      // ...and the row is upgraded to the latest key version, conditional on
      // the exact value read (lost-update guard).
      const writeBack = findWriteBack();
      expect(writeBack).toBeDefined();
      const [sql, params] = writeBack! as [string, string[]];
      expect(sql).toContain('setting_value = $2');
      expect(params[1]).toBe(staleCipher);
      expect(params[0]).toMatch(/^h1:/);
      expect(decryptPat(params[0]!)).toBe('rotate-me');
    });

    it('re-encrypts a pre-HKDF (v{N}) smtp_pass ciphertext on read', async () => {
      const { initEmailService, sendEmail } = await import('./email-service.js');
      // Fixture built with the real pre-#738 algorithm: AES key = first 32
      // chars of the passphrase as UTF-8, no KDF.
      const legacyKey = Buffer.from(process.env.PAT_ENCRYPTION_KEY!.slice(0, 32), 'utf-8');
      const iv = randomBytes(16);
      const cipher = createCipheriv('aes-256-gcm', legacyKey, iv, { authTagLength: 16 });
      let ct = cipher.update('pre-hkdf-secret', 'utf-8', 'hex');
      ct += cipher.final('hex');
      const legacyCipher = `v0:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${ct}`;

      mockDbQuery.mockResolvedValueOnce({
        rows: [
          { setting_key: 'smtp_host', setting_value: 'db.example.com' },
          { setting_key: 'smtp_user', setting_value: 'mailer' },
          { setting_key: 'smtp_pass', setting_value: legacyCipher },
          { setting_key: 'smtp_enabled', setting_value: 'true' },
        ],
      });

      await initEmailService();
      await sendEmail('x@example.com', 'subject', '<p>hi</p>');
      expect(lastTransportOptions().auth?.pass).toBe('pre-hkdf-secret');

      const writeBack = findWriteBack();
      expect(writeBack).toBeDefined();
      const [sql, params] = writeBack! as [string, string[]];
      expect(sql).toContain('setting_value = $2');
      expect(params[1]).toBe(legacyCipher);
      expect(params[0]).toMatch(/^h0:/); // upgraded derivation, same key version
      expect(decryptPat(params[0]!)).toBe('pre-hkdf-secret');
    });

    it('uses a value that fails decryption as-is, without write-back', async () => {
      const { initEmailService, sendEmail } = await import('./email-service.js');
      // Structurally valid ciphertext for a key version that is not configured.
      const undecryptable = `v9:${'a'.repeat(32)}:${'b'.repeat(32)}:${'c'.repeat(32)}`;
      mockDbQuery.mockResolvedValueOnce({
        rows: [
          { setting_key: 'smtp_host', setting_value: 'db.example.com' },
          { setting_key: 'smtp_user', setting_value: 'mailer' },
          { setting_key: 'smtp_pass', setting_value: undecryptable },
          { setting_key: 'smtp_enabled', setting_value: 'true' },
        ],
      });

      await initEmailService();
      await sendEmail('x@example.com', 'subject', '<p>hi</p>');

      expect(lastTransportOptions().auth?.pass).toBe(undecryptable);
      // Not plaintext — must NOT be double-encrypted at rest.
      expect(findWriteBack()).toBeUndefined();
    });

    it('keeps an empty stored smtp_pass empty', async () => {
      const { initEmailService, getSmtpConfig } = await import('./email-service.js');
      mockDbQuery.mockResolvedValueOnce({
        rows: [
          { setting_key: 'smtp_host', setting_value: 'db.example.com' },
          { setting_key: 'smtp_pass', setting_value: '' },
          { setting_key: 'smtp_enabled', setting_value: 'true' },
        ],
      });

      await initEmailService();

      expect(getSmtpConfig().pass).toBe('');
      expect(findWriteBack()).toBeUndefined();
    });
  });
});
