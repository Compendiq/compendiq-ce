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

vi.mock('../db/postgres.js', () => ({
  query: vi.fn().mockResolvedValue({ rows: [] }),
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
});
