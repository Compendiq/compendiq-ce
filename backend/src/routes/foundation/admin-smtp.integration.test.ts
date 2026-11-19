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
import { query } from '../../core/db/postgres.js';
import { decryptPat } from '../../core/utils/crypto.js';
import { adminRoutes } from './admin.js';

/**
 * Real-DB probe for #1761: `PUT /api/admin/smtp` persists before it applies.
 * A trigger on admin_settings that rejects `smtp_%` writes makes the save fail;
 * the rows and the live configuration must both stay as they were. With the
 * trigger gone, the save succeeds and the live configuration equals the rows.
 */

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('PUT /api/admin/smtp — persist before apply (#1761)', () => {
  let app: FastifyInstance;
  let adminId = '';

  beforeAll(async () => {
    await setupTestDb();
    app = Fastify({ logger: false });
    await app.register(sensible);
    app.decorate(
      'requireAdmin',
      async (request: { userId: string; username: string; userRole: string }) => {
        request.userId = adminId;
        request.username = 'smtp_admin';
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
       VALUES ('smtp_admin', 'fakehash', 'admin') RETURNING id`,
    );
    adminId = r.rows[0]!.id;
  });

  afterEach(async () => {
    // Created inside the test; always removed so no other file can see it.
    await query('DROP TRIGGER IF EXISTS reject_smtp_writes ON admin_settings');
    await query('DROP FUNCTION IF EXISTS reject_smtp_writes()');
  });

  const put = (payload: Record<string, unknown>) =>
    app.inject({ method: 'PUT', url: '/api/admin/smtp', payload });
  const getConfig = async () => (await app.inject({ method: 'GET', url: '/api/admin/smtp' })).json();
  async function smtpRows(): Promise<Record<string, string>> {
    const r = await query<{ setting_key: string; setting_value: string }>(
      `SELECT setting_key, setting_value FROM admin_settings WHERE setting_key LIKE 'smtp_%'`,
    );
    return Object.fromEntries(r.rows.map((row) => [row.setting_key, row.setting_value]));
  }

  it('leaves rows and live configuration unchanged when the write is rejected, and matches them once it succeeds', async () => {
    const previous = { host: 'smtp.previous.local', port: 587, secure: false, user: 'u1', pass: 'secret-one', from: 'a@test.local', enabled: true };
    expect((await put(previous)).statusCode).toBe(200);
    const rowsBefore = await smtpRows();
    const configBefore = await getConfig();
    expect(configBefore).toMatchObject({ host: previous.host, port: previous.port, enabled: true });

    await query(`
      CREATE FUNCTION reject_smtp_writes() RETURNS trigger AS $$
      BEGIN
        IF NEW.setting_key LIKE 'smtp_%' THEN
          RAISE EXCEPTION 'smtp settings writes rejected';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await query(`
      CREATE TRIGGER reject_smtp_writes BEFORE INSERT OR UPDATE ON admin_settings
      FOR EACH ROW EXECUTE FUNCTION reject_smtp_writes()`);

    const next = { host: 'smtp.next.local', port: 2525, secure: true, user: 'u2', pass: 'secret-two', from: 'b@test.local', enabled: false };
    const rejected = await put(next);
    expect(rejected.statusCode).toBe(500);
    expect(await smtpRows()).toEqual(rowsBefore);
    expect(await getConfig()).toEqual(configBefore);

    await query('DROP TRIGGER reject_smtp_writes ON admin_settings');
    expect((await put(next)).statusCode).toBe(200);

    const rows = await smtpRows();
    const config = await getConfig();
    expect(rows.smtp_host).toBe(config.host);
    expect(Number(rows.smtp_port)).toBe(config.port);
    expect(rows.smtp_secure === 'true').toBe(config.secure);
    expect(rows.smtp_user).toBe(config.user);
    expect(rows.smtp_from).toBe(config.from);
    expect(rows.smtp_enabled === 'true').toBe(config.enabled);
    expect(decryptPat(rows.smtp_pass!)).toBe(next.pass);
    expect(config).toMatchObject({ host: next.host, port: next.port, enabled: false });
  });
});
