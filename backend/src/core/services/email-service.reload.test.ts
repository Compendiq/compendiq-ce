/**
 * SMTP configuration reloads (#1757): the database-to-config mapping shared by
 * boot and every reload (D-1757-1), soft failure, the re-encryption write-back
 * outside the serialized reloader, and the cache-bus subscription (D-1757-2).
 *
 * `query` and the cache-bus are mocked; each test imports a fresh module so
 * the module-level reloader and live configuration start clean.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  query: vi.fn(),
  subscribe: vi.fn(),
  onReconnect: vi.fn(),
  isCacheBusActive: vi.fn(),
  createTransport: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../db/postgres.js', () => ({ query: h.query }));
vi.mock('./redis-cache-bus.js', () => ({
  subscribe: h.subscribe,
  onReconnect: h.onReconnect,
  isCacheBusActive: h.isCacheBusActive,
}));
vi.mock('../utils/logger.js', () => ({ logger: h.logger }));
vi.mock('nodemailer', () => ({ default: { createTransport: h.createTransport } }));

import { encryptPat } from '../utils/crypto.js';
import type * as EmailServiceModule from './email-service.js';

/** The environment every fresh module import sees (DEFAULT_CONFIG). */
const ENV = {
  SMTP_HOST: 'env.example.com',
  SMTP_PORT: '2526',
  SMTP_SECURE: 'true',
  SMTP_USER: 'env-user',
  SMTP_PASS: 'env-pass',
  SMTP_FROM: 'env@example.com',
  SMTP_ENABLED: 'true',
};
const ENV_CONFIG = {
  host: 'env.example.com',
  port: 2526,
  secure: true,
  user: 'env-user',
  from: 'env@example.com',
  enabled: true,
};

type Row = { setting_key: string; setting_value: string };
const rowsOf = (settings: Record<string, string>): { rows: Row[]; rowCount: number } => {
  const rows = Object.entries(settings).map(([setting_key, setting_value]) => ({ setting_key, setting_value }));
  return { rows, rowCount: rows.length };
};
const isSelect = (sql: unknown) => typeof sql === 'string' && sql.includes(`LIKE 'smtp_%'`);
const isUpdate = (sql: unknown) => typeof sql === 'string' && sql.includes('UPDATE admin_settings');
const selects = () => h.query.mock.calls.filter(([sql]) => isSelect(sql));
const updates = () => h.query.mock.calls.filter(([sql]) => isUpdate(sql)) as Array<[string, string[]]>;

/** Rows the mocked SELECT returns; UPDATEs answer `updateResult()`. */
let smtpRows: Record<string, string> = {};
let updateResult: () => Promise<{ rows: never[]; rowCount: number }>;

type EmailService = typeof EmailServiceModule;

async function loadService(): Promise<EmailService> {
  for (const [key, value] of Object.entries(ENV)) vi.stubEnv(key, value);
  return import('./email-service.js');
}

/** The password the live transport authenticates with (builds the transport). */
async function livePass(svc: EmailService): Promise<string | undefined> {
  h.createTransport.mockClear();
  await svc.sendTestEmail('admin@example.com');
  const options = h.createTransport.mock.calls.at(-1)?.[0] as { auth?: { pass: string } } | undefined;
  return options?.auth?.pass;
}

/**
 * Yield one macrotask so already-started work (a write-back's mocked query
 * and the log line after it) gets to settle. Not a duration guess: it is only
 * used to show that nothing further happens after the awaited condition.
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('email-service SMTP reload (#1757)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    smtpRows = {};
    updateResult = async () => ({ rows: [], rowCount: 1 });
    h.query.mockImplementation(async (sql: string) => {
      if (isSelect(sql)) return rowsOf(smtpRows);
      if (isUpdate(sql)) return updateResult();
      return { rows: [], rowCount: 0 };
    });
    h.createTransport.mockImplementation(() => ({
      sendMail: vi.fn().mockResolvedValue({ messageId: 'test' }),
      close: vi.fn(),
    }));
    h.subscribe.mockReturnValue(vi.fn());
    h.onReconnect.mockReturnValue(vi.fn());
    h.isCacheBusActive.mockReturnValue(false);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('mapping from the smtp_* rows (D-1757-1)', () => {
    it('applies every present row and decrypts smtp_pass', async () => {
      const svc = await loadService();
      smtpRows = {
        smtp_host: 'db.example.com',
        smtp_port: '465',
        smtp_secure: 'true',
        smtp_user: 'db-user',
        smtp_pass: encryptPat('db-secret'),
        smtp_from: 'db@example.com',
        smtp_enabled: 'true',
      };

      await expect(svc.reloadSmtpConfigFromDb('bus')).resolves.toBe(true);

      expect(svc.getSmtpConfig()).toEqual({
        host: 'db.example.com',
        port: 465,
        secure: true,
        user: 'db-user',
        pass: svc.SMTP_PASS_MASK,
        from: 'db@example.com',
        enabled: true,
      });
      expect(await livePass(svc)).toBe('db-secret');
      // Already on the latest key: nothing to write back.
      await settle();
      expect(updates()).toHaveLength(0);
    });

    it('maps absent rows to the environment defaults, not to the current live value', async () => {
      const svc = await loadService();
      svc.updateSmtpConfig({
        host: 'live.example.com',
        port: 2000,
        user: 'live-user',
        pass: 'live-pass',
        from: 'live@example.com',
        enabled: false,
      });
      smtpRows = { smtp_host: 'db.example.com' };

      await expect(svc.reloadSmtpConfigFromDb('bus')).resolves.toBe(true);

      expect(svc.getSmtpConfig()).toEqual({
        host: 'db.example.com',
        port: ENV_CONFIG.port,
        // O-1 (unchanged): with at least one row and no smtp_secure row the
        // mapping is false even though SMTP_SECURE=true.
        secure: false,
        user: ENV_CONFIG.user,
        pass: svc.SMTP_PASS_MASK,
        from: ENV_CONFIG.from,
        enabled: ENV_CONFIG.enabled,
      });
      expect(await livePass(svc)).toBe('env-pass');
    });

    it('maps zero rows to the environment defaults', async () => {
      const svc = await loadService();
      svc.updateSmtpConfig({ host: 'live.example.com', port: 2000, secure: false, enabled: false });
      smtpRows = {};

      await expect(svc.reloadSmtpConfigFromDb('bus')).resolves.toBe(true);

      expect(svc.getSmtpConfig()).toEqual({ ...ENV_CONFIG, pass: svc.SMTP_PASS_MASK });
    });

    it('treats an empty smtp_port row like an absent one', async () => {
      const svc = await loadService();
      smtpRows = { smtp_host: 'db.example.com', smtp_port: '' };

      await svc.reloadSmtpConfigFromDb('bus');

      expect(svc.getSmtpConfig().port).toBe(ENV_CONFIG.port);
    });

    it('lets an smtp_enabled=false row win over SMTP_ENABLED=true', async () => {
      const svc = await loadService();
      smtpRows = { smtp_enabled: 'false' };

      await svc.reloadSmtpConfigFromDb('bus');

      expect(svc.getSmtpConfig().enabled).toBe(false);
    });
  });

  describe('re-encryption write-back', () => {
    it('re-encrypts a legacy plaintext smtp_pass after the apply, conditional on the value read', async () => {
      const svc = await loadService();
      smtpRows = { smtp_host: 'db.example.com', smtp_user: 'mailer', smtp_pass: 'plain-old-secret', smtp_enabled: 'true' };
      let hostWhenUpdateStarted: string | undefined;
      updateResult = async () => {
        hostWhenUpdateStarted = svc.getSmtpConfig().host;
        return { rows: [], rowCount: 1 };
      };

      await expect(svc.reloadSmtpConfigFromDb('bus')).resolves.toBe(true);
      await vi.waitFor(() => expect(updates()).toHaveLength(1));

      expect(hostWhenUpdateStarted).toBe('db.example.com');
      const [sql, params] = updates()[0]!;
      expect(sql).toContain('setting_value = $2');
      expect(params[1]).toBe('plain-old-secret');
      expect(params[0]).toMatch(/^h\d+:/);
      expect(await livePass(svc)).toBe('plain-old-secret');
      await vi.waitFor(() =>
        expect(h.logger.info).toHaveBeenCalledWith(expect.stringMatching(/^Re-encrypted smtp_pass/)),
      );
    });

    it('a write-back that never settles does not block the next reload', async () => {
      const svc = await loadService();
      smtpRows = { smtp_host: 'first.example.com', smtp_pass: 'plain-old-secret', smtp_enabled: 'true' };
      updateResult = () => new Promise(() => { /* never settles */ });

      await expect(svc.reloadSmtpConfigFromDb('bus')).resolves.toBe(true);
      await vi.waitFor(() => expect(updates()).toHaveLength(1));

      smtpRows = { smtp_host: 'second.example.com', smtp_enabled: 'true' };
      await expect(svc.reloadSmtpConfigFromDb('bus')).resolves.toBe(true);
      expect(svc.getSmtpConfig().host).toBe('second.example.com');
    });

    it('a burst of coalesced requests writes back at most once per applied run, and logs nothing when no row matched', async () => {
      const svc = await loadService();
      smtpRows = { smtp_host: 'db.example.com', smtp_pass: 'plain-old-secret', smtp_enabled: 'true' };
      // A concurrent save replaced the row: the conditional UPDATE matches nothing.
      updateResult = async () => ({ rows: [], rowCount: 0 });
      const firstRead = Promise.withResolvers<{ rows: Row[]; rowCount: number }>();
      h.query.mockImplementationOnce(() => firstRead.promise);

      const requests = [
        svc.reloadSmtpConfigFromDb('bus'),
        svc.reloadSmtpConfigFromDb('reconnect'),
        svc.reloadSmtpConfigFromDb('bus'),
        svc.reloadSmtpConfigFromDb('writer'),
        svc.reloadSmtpConfigFromDb('bus'),
      ];
      firstRead.resolve(rowsOf(smtpRows));

      expect(await Promise.all(requests)).toEqual([true, true, true, true, true]);
      // One run for the first request, one coalesced follow-up for the rest.
      expect(selects()).toHaveLength(2);
      // Each requester starts its run's write-back as it resumes, so every
      // UPDATE has been issued by now: one per applied run, not per request.
      expect(updates()).toHaveLength(2);
      await settle(); // let both write-backs finish before checking the log
      expect(h.logger.info).not.toHaveBeenCalledWith(expect.stringMatching(/Re-encrypted/));
    });
  });

  describe('failed reads', () => {
    it('a failed read keeps the previous configuration and resolves false', async () => {
      const svc = await loadService();
      smtpRows = { smtp_host: 'db.example.com', smtp_port: '465', smtp_enabled: 'true' };
      await svc.reloadSmtpConfigFromDb('bus');
      h.query.mockRejectedValueOnce(new Error('connection refused'));

      await expect(svc.reloadSmtpConfigFromDb('bus')).resolves.toBe(false);

      expect(svc.getSmtpConfig()).toMatchObject({ host: 'db.example.com', port: 465, enabled: true });
      expect(h.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ phase: 'bus' }),
        expect.any(String),
      );
    });

    it('a failed cold-load keeps the environment defaults', async () => {
      const svc = await loadService();
      h.query.mockRejectedValueOnce(new Error('connection refused'));

      await svc.initEmailService();

      expect(svc.getSmtpConfig()).toEqual({ ...ENV_CONFIG, pass: svc.SMTP_PASS_MASK });
    });
  });

  describe('subscribeSmtpConfigReload (D-1757-2)', () => {
    const busHandler = () => h.subscribe.mock.calls[0]![1] as () => Promise<void>;
    const reconnectHandler = () => h.onReconnect.mock.calls[0]![0] as () => Promise<void>;

    it('with an active bus registers both handlers and awaits one reload; the handlers reload; unsubscribe removes both', async () => {
      const svc = await loadService();
      h.isCacheBusActive.mockReturnValue(true);
      const unsubscribeBus = vi.fn();
      const unsubscribeReconnect = vi.fn();
      h.subscribe.mockReturnValue(unsubscribeBus);
      h.onReconnect.mockReturnValue(unsubscribeReconnect);
      smtpRows = { smtp_host: 'subscribe.example.com' };
      const read = Promise.withResolvers<{ rows: Row[]; rowCount: number }>();
      h.query.mockImplementationOnce(() => read.promise);

      let subscribed = false;
      const pending = svc.subscribeSmtpConfigReload().then((unsubscribe) => {
        subscribed = true;
        return unsubscribe;
      });
      await vi.waitFor(() => expect(selects()).toHaveLength(1));
      expect(h.subscribe).toHaveBeenCalledWith('smtp:config:changed', expect.any(Function));
      expect(h.onReconnect).toHaveBeenCalledTimes(1);
      expect(subscribed).toBe(false); // the subscribe-time reload is awaited

      read.resolve(rowsOf(smtpRows));
      const unsubscribe = await pending;
      expect(svc.getSmtpConfig().host).toBe('subscribe.example.com');

      smtpRows = { smtp_host: 'bus.example.com' };
      await busHandler()();
      expect(svc.getSmtpConfig().host).toBe('bus.example.com');

      smtpRows = { smtp_host: 'reconnect.example.com' };
      await reconnectHandler()();
      expect(svc.getSmtpConfig().host).toBe('reconnect.example.com');
      expect(selects()).toHaveLength(3);

      unsubscribe();
      expect(unsubscribeBus).toHaveBeenCalledTimes(1);
      expect(unsubscribeReconnect).toHaveBeenCalledTimes(1);
    });

    it('with an inactive bus registers the handlers without an extra read', async () => {
      const svc = await loadService();
      h.isCacheBusActive.mockReturnValue(false);

      await svc.subscribeSmtpConfigReload();

      expect(h.subscribe).toHaveBeenCalledWith('smtp:config:changed', expect.any(Function));
      expect(h.onReconnect).toHaveBeenCalledTimes(1);
      expect(h.query).not.toHaveBeenCalled();
    });
  });
});
