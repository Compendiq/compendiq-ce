import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  setupTestDb,
  truncateAllTables,
  teardownTestDb,
  isDbAvailable,
} from '../../test-db-helper.js';
import { query } from '../db/postgres.js';
import {
  getRegistrationMode,
  getEffectiveRegistrationPolicy,
  SYSTEM_USER_ID,
} from './registration-policy-service.js';

/**
 * Issue #1051 — registration-policy service, against the REAL Postgres so the
 * SQL (admin_settings read + sentinel-excluding admin count) is exercised
 * end-to-end. `truncateAllTables` wipes the seeded sentinel too, so every test
 * that needs it re-inserts the `__system__` row explicitly.
 */

const dbAvailable = await isDbAvailable();

async function setMode(mode: string): Promise<void> {
  await query(
    `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
     VALUES ('registration_mode', $1, NOW())
     ON CONFLICT (setting_key) DO UPDATE SET setting_value = $1, updated_at = NOW()`,
    [mode],
  );
}

async function insertSentinel(): Promise<void> {
  await query(
    `INSERT INTO users (id, username, password_hash, role)
     VALUES ($1, '__system__', 'nologin', 'admin')
     ON CONFLICT (id) DO NOTHING`,
    [SYSTEM_USER_ID],
  );
}

async function insertRealAdmin(username = 'real_admin'): Promise<void> {
  await query(
    `INSERT INTO users (username, password_hash, role) VALUES ($1, 'fakehash', 'admin')`,
    [username],
  );
}

describe.skipIf(!dbAvailable)('registration-policy-service (#1051)', () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
  });

  describe('getRegistrationMode', () => {
    it("defaults to 'closed' when the row is absent", async () => {
      expect(await getRegistrationMode()).toBe('closed');
    });

    it("returns 'open' when the stored value is 'open'", async () => {
      await setMode('open');
      expect(await getRegistrationMode()).toBe('open');
    });

    it("returns 'closed' when the stored value is 'closed'", async () => {
      await setMode('closed');
      expect(await getRegistrationMode()).toBe('closed');
    });

    it("returns 'closed' for an unrecognised/garbage value (fail safe)", async () => {
      await setMode('invite');
      expect(await getRegistrationMode()).toBe('closed');
    });
  });

  describe('getEffectiveRegistrationPolicy', () => {
    it('allows registration during bootstrap — only the sentinel exists — regardless of a closed mode', async () => {
      await insertSentinel();
      await setMode('closed');
      const policy = await getEffectiveRegistrationPolicy();
      expect(policy).toEqual({ mode: 'closed', allowRegistration: true });
    });

    it('allows registration during bootstrap with no users at all (unset mode)', async () => {
      const policy = await getEffectiveRegistrationPolicy();
      expect(policy).toEqual({ mode: 'closed', allowRegistration: true });
    });

    it('disallows registration when a real admin exists and the mode is unset (default closed)', async () => {
      await insertSentinel();
      await insertRealAdmin();
      const policy = await getEffectiveRegistrationPolicy();
      expect(policy).toEqual({ mode: 'closed', allowRegistration: false });
    });

    it('disallows registration when a real admin exists and the mode is closed', async () => {
      await insertRealAdmin();
      await setMode('closed');
      const policy = await getEffectiveRegistrationPolicy();
      expect(policy).toEqual({ mode: 'closed', allowRegistration: false });
    });

    it("allows registration when a real admin exists and the mode is 'open'", async () => {
      await insertSentinel();
      await insertRealAdmin();
      await setMode('open');
      const policy = await getEffectiveRegistrationPolicy();
      expect(policy).toEqual({ mode: 'open', allowRegistration: true });
    });

    it('does not treat the sentinel as a real admin (sentinel-exclusion guard)', async () => {
      // Only the sentinel admin — must still be considered bootstrap.
      await insertSentinel();
      await setMode('closed');
      const policy = await getEffectiveRegistrationPolicy();
      expect(policy.allowRegistration).toBe(true);
    });
  });
});
