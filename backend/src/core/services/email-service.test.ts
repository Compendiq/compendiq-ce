import { describe, it, expect, vi, beforeEach } from 'vitest';

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

describe('email-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
