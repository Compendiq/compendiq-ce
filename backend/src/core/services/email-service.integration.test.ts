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

import { createClient, type RedisClientType } from 'redis';
import nodemailer from 'nodemailer';
import {
  setupTestDb,
  truncateAllTables,
  teardownTestDb,
  isDbAvailable,
} from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { query } from '../db/postgres.js';
import { encryptPat, decryptPat } from '../utils/crypto.js';
import { prefixedRedisChannel } from '../utils/prefixed-redis-channel.js';
import { getSmtpConfig, initEmailService, sendTestEmail, subscribeSmtpConfigReload } from './email-service.js';
import { initCacheBus, close as closeCacheBus } from './redis-cache-bus.js';

const dbAvailable = await isDbAvailable();
const redisAvailable = dbAvailable && (await isRedisAvailable());

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

// #1757 — a save on another replica reaches this one through the cache-bus:
// the peer writes the rows and publishes the bare reload signal; this process
// re-reads PostgreSQL. A bus reconnect reloads too (missed signals are not
// replayed, ADR-024).
describe.skipIf(!redisAvailable)(
  'SMTP configuration reaches every replica — real Postgres and Redis (#1757)',
  () => {
    const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
    // The cache-bus duplicates `main` for its subscriber, so the subscriber
    // carries this connection name and can be found (and killed) by id alone.
    const busClientName = `smtp-reload-${process.pid}-${Date.now()}`;
    const channel = prefixedRedisChannel('smtp:config:changed');
    let main: RedisClientType;
    /** Stands in for the other replica: it only writes rows and publishes the signal. */
    let peer: RedisClientType;
    let unsubscribe: (() => void) | null = null;

    beforeAll(async () => {
      await setupTestDb();
      main = createClient({ url, name: busClientName }) as RedisClientType;
      main.on('error', () => { /* surfaced through the assertions */ });
      await main.connect();
      peer = createClient({ url }) as RedisClientType;
      peer.on('error', () => { /* surfaced through the assertions */ });
      await peer.connect();
      await initCacheBus(main);
    });

    afterAll(async () => {
      await closeCacheBus();
      await main.quit();
      await peer.quit();
      await teardownTestDb();
    });

    beforeEach(async () => {
      await truncateAllTables();
      hooks.afterSmtpSelect = null;
      unsubscribe = await subscribeSmtpConfigReload();
      // SUBSCRIBE is acknowledged asynchronously; publish only once Redis has it.
      await vi.waitFor(async () => {
        const counts = await peer.pubSubNumSub(channel);
        expect(counts[channel]).toBeGreaterThan(0);
      });
    });

    afterEach(() => {
      unsubscribe?.();
      unsubscribe = null;
    });

    async function writeSmtpRows(settings: Record<string, string>): Promise<void> {
      await query(
        `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
         SELECT key, value, NOW()
         FROM unnest($1::text[], $2::text[]) AS t(key, value)
         ON CONFLICT (setting_key) DO UPDATE
         SET setting_value = EXCLUDED.setting_value, updated_at = NOW()`,
        [Object.keys(settings), Object.values(settings)],
      );
    }

    /** Redis client id of a connection, or undefined when it is not connected. */
    async function clientId(filter: string[], match: (line: string) => boolean): Promise<string | undefined> {
      const clients = await peer.sendCommand(['CLIENT', 'LIST', ...filter]);
      if (typeof clients !== 'string') throw new Error('Redis did not return its client inventory');
      return clients.split('\n').find(match)?.match(/(?:^| )id=(\d+)/)?.[1];
    }

    it("converges on a peer's save and sends the test mail through the newly saved host", async () => {
      expect(getSmtpConfig().host).not.toBe('peer.example.com');

      await writeSmtpRows({
        smtp_host: 'peer.example.com',
        smtp_port: '2525',
        smtp_secure: 'false',
        smtp_user: 'peer-user',
        smtp_pass: encryptPat('peer-secret'),
        smtp_from: 'peer@example.com',
        smtp_enabled: 'true',
      });
      await peer.publish(channel, JSON.stringify({}));

      await vi.waitFor(() =>
        expect(getSmtpConfig()).toMatchObject({
          host: 'peer.example.com',
          port: 2525,
          secure: false,
          user: 'peer-user',
          from: 'peer@example.com',
          enabled: true,
        }),
      );

      const createTransport = nodemailer.createTransport as ReturnType<typeof vi.fn>;
      createTransport.mockClear();
      expect(await sendTestEmail('admin@example.com')).toEqual({ success: true });
      expect(createTransport).toHaveBeenCalledTimes(1);
      expect(createTransport.mock.calls[0]![0]).toMatchObject({
        host: 'peer.example.com',
        port: 2525,
        auth: { user: 'peer-user', pass: 'peer-secret' },
      });
    });

    it('reloads the rows after the bus subscriber reconnects, without touching other subscribers', async () => {
      // Another worker's subscriber on the same Redis server: it must survive.
      const bystander = createClient({ url }) as RedisClientType;
      bystander.on('error', () => { /* surfaced through the assertions */ });
      await bystander.connect();
      try {
        const bystanderId = String(await bystander.sendCommand(['CLIENT', 'ID']));
        await bystander.subscribe(prefixedRedisChannel('smtp:test:bystander'), () => undefined);

        // Written without a signal: only the reconnect reload can pick it up.
        await writeSmtpRows({ smtp_host: 'after-reconnect.example.com', smtp_enabled: 'true' });

        // Kill only this file's cache-bus subscriber, by id (never by type: the
        // backend suite shares one Redis server across parallel workers).
        const subscriberId = await clientId(['TYPE', 'PUBSUB'], (line) => line.includes(`name=${busClientName} `));
        expect(subscriberId).toBeDefined();
        expect(await peer.sendCommand(['CLIENT', 'KILL', 'ID', subscriberId!])).toBe(1);

        await vi.waitFor(() => expect(getSmtpConfig().host).toBe('after-reconnect.example.com'), { timeout: 5_000 });
        expect(await clientId(['ID', bystanderId], (line) => line.includes(`id=${bystanderId} `))).toBe(bystanderId);
      } finally {
        await bystander.quit();
      }
    });
  },
);
