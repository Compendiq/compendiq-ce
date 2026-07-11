import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';

// admin.ts imports the cluster-wide LLM queue setters (Redis cache-bus).
// They are not under test here — keep Redis out of this suite.
vi.mock('../../domains/llm/services/llm-queue.js', () => ({
  setLlmConcurrencyClusterWide: vi.fn().mockResolvedValue(undefined),
  setLlmMaxQueueDepthClusterWide: vi.fn().mockResolvedValue(undefined),
}));

import {
  setupTestDb,
  truncateAllTables,
  teardownTestDb,
  isDbAvailable,
} from '../../test-db-helper.js';
import * as pg from '../../core/db/postgres.js';
import { query } from '../../core/db/postgres.js';
import { encryptPat, decryptPat } from '../../core/utils/crypto.js';
import { adminRoutes } from './admin.js';

/**
 * Real-DB integration test for POST /api/admin/rotate-encryption-key.
 *
 * #762 review follow-up: the rotation sweep must cover
 * `admin_settings.smtp_pass` (a versioned ciphertext since #738), not just
 * `user_settings.confluence_pat`. Otherwise the documented rotation
 * procedure — rotate, then remove the old key — leaves smtp_pass
 * undecryptable and SMTP auth fails silently.
 */

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)(
  'POST /api/admin/rotate-encryption-key — admin_settings.smtp_pass sweep (#762 review follow-up)',
  () => {
    let app: FastifyInstance;
    let adminId = '';

    beforeAll(async () => {
      await setupTestDb();
      app = Fastify({ logger: false });
      await app.register(sensible);
      // Stub auth at the decorator boundary (per repo test rules); the
      // userId is a real seeded admin row so the audit_log FK holds.
      app.decorate(
        'requireAdmin',
        async (request: { userId: string; username: string; userRole: string }) => {
          request.userId = adminId;
          request.username = 'rotate_admin';
          request.userRole = 'admin';
        },
      );
      await app.register(adminRoutes, { prefix: '/api' });
      await app.ready();
    });

    afterAll(async () => {
      await app.close();
      await teardownTestDb();
    });

    beforeEach(async () => {
      await truncateAllTables();
      const r = await query<{ id: string }>(
        `INSERT INTO users (username, password_hash, role)
         VALUES ('rotate_admin', 'fakehash', 'admin') RETURNING id`,
      );
      adminId = r.rows[0]!.id;
    });

    afterEach(() => {
      delete process.env.PAT_ENCRYPTION_KEY_V1;
    });

    async function seedSmtpPass(value: string): Promise<void> {
      await query(
        `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
         VALUES ('smtp_pass', $1, NOW())`,
        [value],
      );
    }

    async function readSmtpPass(): Promise<string | null> {
      const r = await query<{ setting_value: string }>(
        `SELECT setting_value FROM admin_settings WHERE setting_key = 'smtp_pass'`,
      );
      return r.rows[0]?.setting_value ?? null;
    }

    it('re-encrypts smtp_pass alongside PATs so it stays decryptable after the old key is removed', async () => {
      // Both secrets at rest under key version 0 (PAT_ENCRYPTION_KEY).
      await seedSmtpPass(encryptPat('smtp-secret'));
      await query(
        `INSERT INTO user_settings (user_id, confluence_pat) VALUES ($1, $2)`,
        [adminId, encryptPat('pat-secret')],
      );

      // Operator rotates: introduce key version 1.
      process.env.PAT_ENCRYPTION_KEY_V1 = 'versioned-key-one-at-least-32-chars!!';

      const res = await app.inject({ method: 'POST', url: '/api/admin/rotate-encryption-key' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ rotated: 2, skipped: 0, errors: 0, total: 2 });

      // smtp_pass now lives under the NEW key — removing v0 cannot strand it.
      const smtp = await readSmtpPass();
      expect(smtp).toMatch(/^h1:/);
      expect(decryptPat(smtp!)).toBe('smtp-secret');

      // The PAT sweep still works as before.
      const pat = (
        await query<{ confluence_pat: string }>(
          `SELECT confluence_pat FROM user_settings WHERE user_id = $1`,
          [adminId],
        )
      ).rows[0]!.confluence_pat;
      expect(pat).toMatch(/^h1:/);
      expect(decryptPat(pat)).toBe('pat-secret');
    });

    it('encrypts a legacy plaintext smtp_pass during the sweep', async () => {
      await seedSmtpPass('plain-old-secret');
      process.env.PAT_ENCRYPTION_KEY_V1 = 'versioned-key-one-at-least-32-chars!!';

      const res = await app.inject({ method: 'POST', url: '/api/admin/rotate-encryption-key' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ rotated: 1, skipped: 0, errors: 0, total: 1 });

      const smtp = await readSmtpPass();
      expect(smtp).toMatch(/^h1:/);
      expect(decryptPat(smtp!)).toBe('plain-old-secret');
    });

    it('skips an smtp_pass already on the latest key, leaving the row byte-identical', async () => {
      const current = encryptPat('already-current');
      await seedSmtpPass(current);

      const res = await app.inject({ method: 'POST', url: '/api/admin/rotate-encryption-key' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ rotated: 0, skipped: 1, errors: 0, total: 1 });
      expect(await readSmtpPass()).toBe(current);
    });

    it('does not clobber a PAT that was concurrently replaced mid-rotation (lost-update guard, #889)', async () => {
      // Seed the user's PAT under key version 0 (the "old" ciphertext the
      // rotation loop snapshots).
      await query(`INSERT INTO user_settings (user_id, confluence_pat) VALUES ($1, $2)`, [
        adminId,
        encryptPat('old-pat'),
      ]);

      // Operator rotates: introduce key version 1 so reEncryptPat re-encrypts
      // the snapshotted old ciphertext (rotation actually happens for this row).
      process.env.PAT_ENCRYPTION_KEY_V1 = 'versioned-key-one-at-least-32-chars!!';

      // A concurrent PUT /settings saves a brand-new PAT under the latest key.
      const newCipher = encryptPat('new-pat');

      // Simulate the race: land the concurrent write AFTER the rotation's
      // snapshot SELECT but BEFORE the per-row UPDATE. Capture the real query
      // fn first so the injected write and passthrough bypass the spy.
      const realQuery = pg.query;
      let injected = false;
      const spy = vi
        .spyOn(pg, 'query')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockImplementation(async (sql: any, params?: any) => {
          const res = await realQuery(sql, params);
          if (!injected && /SELECT user_id, confluence_pat FROM user_settings/i.test(String(sql))) {
            injected = true;
            await realQuery(
              'UPDATE user_settings SET confluence_pat = $1 WHERE user_id = $2',
              [newCipher, adminId],
            );
          }
          return res;
        });

      try {
        const res = await app.inject({ method: 'POST', url: '/api/admin/rotate-encryption-key' });
        expect(res.statusCode).toBe(200);
        // The raced row must not be counted as rotated; it is a no-op skip.
        expect(res.json()).toMatchObject({ rotated: 0, skipped: 1, errors: 0, total: 1 });
      } finally {
        spy.mockRestore();
      }

      // The concurrently-saved new PAT survived — it was NOT reverted to a
      // re-encryption of the stale snapshot value.
      const pat = (
        await query<{ confluence_pat: string }>(
          `SELECT confluence_pat FROM user_settings WHERE user_id = $1`,
          [adminId],
        )
      ).rows[0]!.confluence_pat;
      expect(pat).toBe(newCipher);
      expect(decryptPat(pat)).toBe('new-pat');
    });

    it('ignores an empty smtp_pass row (cleared password is not a secret)', async () => {
      await seedSmtpPass('');

      const res = await app.inject({ method: 'POST', url: '/api/admin/rotate-encryption-key' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ rotated: 0, skipped: 0, errors: 0, total: 0 });
      expect(await readSmtpPass()).toBe('');
    });
  },
);
