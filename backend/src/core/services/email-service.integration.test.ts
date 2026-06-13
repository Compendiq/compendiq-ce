import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

// Mock nodemailer at the boundary — no SMTP traffic from tests.
vi.mock('nodemailer', () => {
  const sendMail = vi.fn().mockResolvedValue({ messageId: 'test-123' });
  const close = vi.fn();
  return {
    default: {
      createTransport: vi.fn().mockReturnValue({ sendMail, close }),
    },
  };
});

// Real Postgres, with one seam: the wrapper lets a test inject a concurrent
// write between initEmailService's SELECT and its write-back UPDATE — the
// race that the conditional `AND setting_value = $2` guard must survive
// (#762 review follow-up). Every statement still executes against the DB.
const hooks = vi.hoisted(() => ({
  afterSmtpSelect: null as null | (() => Promise<void>),
}));

vi.mock('../db/postgres.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/postgres.js')>();
  return {
    ...actual,
    query: async (text: string, params?: unknown[]) => {
      const result = await actual.query(text, params);
      if (hooks.afterSmtpSelect && text.includes(`LIKE 'smtp_%'`)) {
        const hook = hooks.afterSmtpSelect;
        hooks.afterSmtpSelect = null;
        await hook();
      }
      return result;
    },
  };
});

import {
  setupTestDb,
  truncateAllTables,
  teardownTestDb,
  isDbAvailable,
} from '../../test-db-helper.js';
import { query } from '../db/postgres.js';
import { encryptPat, decryptPat } from '../utils/crypto.js';
import { initEmailService } from './email-service.js';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)(
  'initEmailService smtp_pass write-backs — real Postgres (#738 / #762 review follow-up)',
  () => {
    beforeAll(async () => {
      await setupTestDb();
    });

    afterAll(async () => {
      await teardownTestDb();
    });

    beforeEach(async () => {
      await truncateAllTables();
      hooks.afterSmtpSelect = null;
    });

    afterEach(() => {
      delete process.env.PAT_ENCRYPTION_KEY_V1;
    });

    async function seedSmtpSettings(pass: string): Promise<void> {
      await query(
        `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
         SELECT key, value, NOW()
         FROM unnest($1::text[], $2::text[]) AS t(key, value)`,
        [
          ['smtp_host', 'smtp_user', 'smtp_pass', 'smtp_enabled'],
          ['db.example.com', 'mailer', pass, 'true'],
        ],
      );
    }

    async function readSmtpPass(): Promise<string> {
      const r = await query<{ setting_value: string }>(
        `SELECT setting_value FROM admin_settings WHERE setting_key = 'smtp_pass'`,
      );
      return r.rows[0]!.setting_value;
    }

    it('upgrades a legacy plaintext smtp_pass in place against the real schema', async () => {
      await seedSmtpSettings('plain-old-secret');

      await initEmailService();

      const stored = await readSmtpPass();
      expect(stored).toMatch(/^h\d+:/);
      expect(decryptPat(stored)).toBe('plain-old-secret');
    });

    it('upgrades an smtp_pass on a stale key version in place (re-encrypt-on-read)', async () => {
      await seedSmtpSettings(encryptPat('rotate-me')); // h0 under PAT_ENCRYPTION_KEY
      process.env.PAT_ENCRYPTION_KEY_V1 = 'versioned-key-one-at-least-32-chars!!';

      await initEmailService();

      const stored = await readSmtpPass();
      expect(stored).toMatch(/^h1:/);
      expect(decryptPat(stored)).toBe('rotate-me');
    });

    it('does not clobber a concurrent PUT /admin/smtp during the startup write-back (lost update)', async () => {
      await seedSmtpSettings('old-secret'); // legacy plaintext → triggers the write-back
      const concurrentCipher = encryptPat('brand-new-secret');

      // Simulates an admin saving a NEW password between the startup SELECT
      // and the legacy-upgrade UPDATE of this pod.
      hooks.afterSmtpSelect = async () => {
        await query(
          `UPDATE admin_settings SET setting_value = $1, updated_at = NOW()
           WHERE setting_key = 'smtp_pass'`,
          [concurrentCipher],
        );
      };

      await initEmailService();

      // The concurrent value must win: the write-back is conditional on the
      // value originally read, so 0 rows match and nothing is overwritten.
      const stored = await readSmtpPass();
      expect(stored).toBe(concurrentCipher);
      expect(decryptPat(stored)).toBe('brand-new-secret');
    });
  },
);
