/**
 * Invitation delivery contract of `POST /api/admin/users` (#1737).
 *
 * The generated password is returned to the admin exactly when the invitation
 * was not delivered. Real route, `admin-user-service`, `audit-service` and
 * `email-service` over real Postgres; only `nodemailer` (the SMTP boundary),
 * the logger (to capture arguments) and the route-level Redis/rate-limit
 * boundaries are stubbed. Skips when no test database is reachable.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import bcrypt from 'bcrypt';
import { ZodError } from 'zod';

// Read when the route module loads (vitestIntOr), so set it before the import.
vi.hoisted(() => {
  process.env.INVITATION_SEND_TIMEOUT_MS = '200';
});

const { sendMail, rejectSendEmail } = vi.hoisted(() => ({
  sendMail: vi.fn(),
  rejectSendEmail: { value: false },
}));

vi.mock('nodemailer', () => ({
  default: { createTransport: vi.fn(() => ({ sendMail, close: vi.fn() })) },
}));

vi.mock('../../core/utils/logger.js', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() };
  return { logger };
});

// Passthrough: the real service, except for the one case that makes the
// function itself reject (it never does in production).
vi.mock('../../core/services/email-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/services/email-service.js')>();
  return {
    ...actual,
    sendEmail: (...args: Parameters<typeof actual.sendEmail>) =>
      rejectSendEmail.value ? Promise.reject(new Error('sendEmail rejected')) : actual.sendEmail(...args),
  };
});

vi.mock('../../core/services/rate-limit-service.js', () => ({
  getRateLimits: vi.fn().mockResolvedValue({ admin: { max: 100, timeWindow: '1 minute' } }),
}));

vi.mock('../../core/services/user-security-cache.js', () => ({
  invalidateUserSecurityState: vi.fn().mockResolvedValue(undefined),
}));

import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';
import { logger } from '../../core/utils/logger.js';
import { getSmtpConfig, updateSmtpConfig } from '../../core/services/email-service.js';
import { adminUsersRoutes, INVITATION_SEND_TIMEOUT_MS } from './admin-users.js';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('POST /api/admin/users — invitation delivery (#1737)', () => {
  let app: ReturnType<typeof Fastify>;
  let adminId: string;
  const originalSmtp = getSmtpConfig();

  const enableSmtp = () => updateSmtpConfig({ enabled: true, host: 'smtp.invite.test', port: 587 });

  async function create(payload: Record<string, unknown>) {
    const res = await app.inject({ method: 'POST', url: '/api/admin/users', payload });
    return { res, body: res.json() as { user: { id: string; email: string | null }; temporaryPassword?: string } };
  }

  async function userRow(id: string) {
    const r = await query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = $1', [id]);
    return r.rows[0]!;
  }

  async function auditRow(id: string) {
    const r = await query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_log WHERE resource_id = $1 AND metadata->>'event' = 'user_created'`,
      [id],
    );
    expect(r.rows).toHaveLength(1);
    return r.rows[0]!.metadata;
  }

  /** The generated password is 20 hex chars; find the one in `html` that matches the stored hash. */
  async function passwordInMail(html: string, hash: string): Promise<string | undefined> {
    for (const token of html.match(/\b[0-9a-f]{20}\b/g) ?? []) {
      if (await bcrypt.compare(token, hash)) return token;
    }
    return undefined;
  }

  function loggedStrings(): string {
    const calls = Object.values(logger as unknown as Record<string, ReturnType<typeof vi.fn>>).flatMap(
      (fn) => fn.mock.calls,
    );
    return JSON.stringify(calls, (_k, v) => (v instanceof Error ? { message: v.message, stack: v.stack } : v));
  }

  beforeAll(async () => {
    await setupTestDb();
    app = Fastify({ logger: false });
    await app.register(sensible);
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof ZodError) {
        reply.status(400).send({ error: 'ValidationError', statusCode: 400 });
        return;
      }
      reply.status(error.statusCode ?? 500).send({ error: error.message, statusCode: error.statusCode ?? 500 });
    });
    const asAdmin = async (request: { userId: string; username: string; userRole: string }) => {
      request.userId = adminId;
      request.username = 'admin';
      request.userRole = 'admin';
    };
    app.decorate('authenticate', asAdmin);
    app.decorate('requireAdmin', asAdmin);
    await app.register(adminUsersRoutes, { prefix: '/api' });
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    const r = await query<{ id: string }>(
      `INSERT INTO users (username, password_hash, role) VALUES ('admin', 'fakehash', 'admin') RETURNING id`,
    );
    adminId = r.rows[0]!.id;
    vi.clearAllMocks();
    sendMail.mockResolvedValue({ messageId: 'm-1' });
    rejectSendEmail.value = false;
  });

  afterEach(() => {
    updateSmtpConfig({
      enabled: originalSmtp.enabled,
      host: originalSmtp.host,
      port: originalSmtp.port,
      secure: originalSmtp.secure,
      user: originalSmtp.user,
      from: originalSmtp.from,
    });
  });

  it('uses the shortened bound under Vitest', () => {
    expect(INVITATION_SEND_TIMEOUT_MS).toBe(200);
  });

  it('SMTP disabled: returns the password, which signs in; audit invitationSent=false', async () => {
    updateSmtpConfig({ enabled: false, host: '' });
    const { res, body } = await create({ username: 'inv-off', email: 'off@example.test', sendInvitation: true });

    expect(res.statusCode).toBe(201);
    expect(body.temporaryPassword).toMatch(/^[0-9a-f]{20}$/);
    expect(sendMail).not.toHaveBeenCalled();
    const { password_hash } = await userRow(body.user.id);
    expect(await bcrypt.compare(body.temporaryPassword!, password_hash)).toBe(true);
    const audit = await auditRow(body.user.id);
    expect(audit).toMatchObject({ invited: true, invitationSent: false });
    expect(JSON.stringify(audit)).not.toContain(body.temporaryPassword);
    expect(loggedStrings()).not.toContain(body.temporaryPassword);
  });

  it('sendMail resolves: password omitted from the response, mailed to the user; audit invitationSent=true', async () => {
    enableSmtp();
    const { res, body } = await create({ username: 'inv-ok', email: 'ok@example.test', sendInvitation: true });

    expect(res.statusCode).toBe(201);
    expect(body.temporaryPassword).toBeUndefined();
    expect(res.body).not.toContain('temporaryPassword');
    expect(sendMail).toHaveBeenCalledTimes(1);
    const mail = sendMail.mock.calls[0]![0] as { to: string; html: string };
    expect(mail.to).toBe('ok@example.test');
    const { password_hash } = await userRow(body.user.id);
    const mailed = await passwordInMail(mail.html, password_hash);
    expect(mailed).toBeDefined();
    const audit = await auditRow(body.user.id);
    expect(audit).toMatchObject({ invited: true, invitationSent: true });
    expect(JSON.stringify(audit)).not.toContain(mailed!);
    expect(loggedStrings()).not.toContain(mailed!);
  });

  it('sendMail rejects: returns the password, request succeeds; audit invitationSent=false', async () => {
    enableSmtp();
    sendMail.mockRejectedValue(new Error('smtp down'));
    const { res, body } = await create({ username: 'inv-fail', email: 'fail@example.test', sendInvitation: true });

    expect(res.statusCode).toBe(201);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(body.temporaryPassword).toMatch(/^[0-9a-f]{20}$/);
    const { password_hash } = await userRow(body.user.id);
    expect(await bcrypt.compare(body.temporaryPassword!, password_hash)).toBe(true);
    const audit = await auditRow(body.user.id);
    expect(audit).toMatchObject({ invited: true, invitationSent: false });
    expect(JSON.stringify(audit)).not.toContain(body.temporaryPassword);
    expect(loggedStrings()).not.toContain(body.temporaryPassword);
  });

  it('sendEmail itself rejects: returns the password, logs a warning with userId only', async () => {
    enableSmtp();
    rejectSendEmail.value = true;
    const { res, body } = await create({ username: 'inv-rej', email: 'rej@example.test', sendInvitation: true });

    expect(res.statusCode).toBe(201);
    expect(body.temporaryPassword).toMatch(/^[0-9a-f]{20}$/);
    expect(sendMail).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ userId: body.user.id, err: expect.any(Error) }),
      expect.any(String),
    );
    const audit = await auditRow(body.user.id);
    expect(audit).toMatchObject({ invited: true, invitationSent: false });
    expect(JSON.stringify(audit)).not.toContain(body.temporaryPassword);
    expect(loggedStrings()).not.toContain(body.temporaryPassword);
  });

  it('send never settles: the bound expires, returns the password, one warn with userId', async () => {
    enableSmtp();
    sendMail.mockReturnValue(new Promise(() => {}));
    const { res, body } = await create({ username: 'inv-hang', email: 'hang@example.test', sendInvitation: true });

    expect(res.statusCode).toBe(201);
    expect(body.temporaryPassword).toMatch(/^[0-9a-f]{20}$/);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ userId: body.user.id }),
      expect.any(String),
    );
    const { password_hash } = await userRow(body.user.id);
    expect(await bcrypt.compare(body.temporaryPassword!, password_hash)).toBe(true);
    const audit = await auditRow(body.user.id);
    expect(audit).toMatchObject({ invited: true, invitationSent: false });
    expect(JSON.stringify(audit)).not.toContain(body.temporaryPassword);
    expect(loggedStrings()).not.toContain(body.temporaryPassword);
  });

  it('no email address: returns the password, nothing sent; audit invitationSent=false', async () => {
    enableSmtp();
    const { res, body } = await create({ username: 'inv-noemail', sendInvitation: true });

    expect(res.statusCode).toBe(201);
    expect(body.temporaryPassword).toMatch(/^[0-9a-f]{20}$/);
    expect(sendMail).not.toHaveBeenCalled();
    const { password_hash } = await userRow(body.user.id);
    expect(await bcrypt.compare(body.temporaryPassword!, password_hash)).toBe(true);
    const audit = await auditRow(body.user.id);
    expect(audit).toMatchObject({ invited: true, invitationSent: false });
    expect(JSON.stringify(audit)).not.toContain(body.temporaryPassword);
    expect(loggedStrings()).not.toContain(body.temporaryPassword);
  });

  it('explicit password: no password generated or returned, no email sent', async () => {
    enableSmtp();
    const { res, body } = await create({
      username: 'inv-explicit',
      email: 'explicit@example.test',
      sendInvitation: true,
      password: 'Explicit-Password-123!',
    });

    expect(res.statusCode).toBe(201);
    expect(body.temporaryPassword).toBeUndefined();
    expect(sendMail).not.toHaveBeenCalled();
    const { password_hash } = await userRow(body.user.id);
    expect(await bcrypt.compare('Explicit-Password-123!', password_hash)).toBe(true);
    const audit = await auditRow(body.user.id);
    expect(audit).toMatchObject({ invited: true, invitationSent: false });
    expect(JSON.stringify(audit)).not.toContain('Explicit-Password-123!');
    expect(loggedStrings()).not.toContain('Explicit-Password-123!');
  });
});
