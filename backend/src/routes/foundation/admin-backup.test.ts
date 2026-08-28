import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import { adminBackupRoutes } from './admin-backup.js';

vi.mock('../../core/services/rate-limit-service.js', () => ({
  getRateLimits: vi.fn(async () => ({ admin: { max: 20 } })),
}));

vi.mock('../../core/services/audit-service.js', () => ({
  logAuditEvent: vi.fn(async () => undefined),
}));

vi.mock('../../core/services/queue-service.js', () => ({
  enqueueJob: vi.fn(async () => 'job-1'),
}));

const getBackupPublicConfig = vi.fn();
const hasMasterBackupKey = vi.fn();
const updateBackupSettings = vi.fn();
const getBackupRuntimeConfig = vi.fn();

vi.mock('../../core/services/backup-settings.js', () => ({
  getBackupPublicConfig: (...args: unknown[]) => getBackupPublicConfig(...args),
  hasMasterBackupKey: (...args: unknown[]) => hasMasterBackupKey(...args),
  updateBackupSettings: (...args: unknown[]) => updateBackupSettings(...args),
  getBackupRuntimeConfig: (...args: unknown[]) => getBackupRuntimeConfig(...args),
}));

const isBackupLockHeld = vi.fn();
const listBackupRuns = vi.fn();
const resolveBackupSecret = vi.fn();

vi.mock('../../core/services/backup-service.js', () => ({
  isBackupLockHeld: (...args: unknown[]) => isBackupLockHeld(...args),
  listBackupRuns: (...args: unknown[]) => listBackupRuns(...args),
  resolveBackupSecret: (...args: unknown[]) => resolveBackupSecret(...args),
}));

const createBackupExportTicket = vi.fn();
vi.mock('../../core/services/backup-export-ticket.js', () => ({
  createBackupExportTicket: (...args: unknown[]) => createBackupExportTicket(...args),
}));

vi.mock('../../core/services/backup-s3.js', () => ({
  assertSafeS3Endpoint: vi.fn(async () => new URL('https://s3.amazonaws.com')),
  testS3Connection: vi.fn(async () => undefined),
}));

async function build() {
  const app = Fastify();
  app.decorate('authenticate', async () => undefined);
  app.decorate('requireAdmin', async () => undefined);
  app.decorateRequest('userId', '');
  app.addHook('onRequest', async (req) => {
    req.userId = 'admin-1';
  });
  await app.register(adminBackupRoutes, { prefix: '/api' });
  await app.ready();
  return app;
}

describe('admin backup routes (#1420)', () => {
  afterEach(async () => {
    vi.clearAllMocks();
  });

  beforeEach(() => {
    getBackupPublicConfig.mockResolvedValue({
      s3: {
        enabled: false,
        endpoint: '',
        bucket: '',
        region: 'us-east-1',
        accessKey: '',
        secretKey: '',
        prefix: 'compendiq-backups/',
        forcePathStyle: true,
        hasAccessKey: false,
        hasSecretKey: false,
      },
      schedule: {
        enabled: false,
        intervalHours: 24,
        retentionCount: 7,
        retentionDays: 30,
        lastRunAt: null,
      },
    });
    hasMasterBackupKey.mockReturnValue(false);
    isBackupLockHeld.mockResolvedValue(false);
    listBackupRuns.mockResolvedValue([]);
  });

  it('GET /api/admin/backup returns status', async () => {
    const app = await build();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/admin/backup' });
      expect(res.statusCode).toBe(200);
      expect(res.json().hasMasterKey).toBe(false);
      expect(res.json().history).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('removes the direct streaming export route', async () => {
    const app = await build();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/backup/export',
      });

      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('POST /api/admin/backup/export-ticket returns a same-origin one-use URL', async () => {
    const secret = { kind: 'passphrase', passphrase: 'correct horse battery staple' };
    resolveBackupSecret.mockReturnValue(secret);
    createBackupExportTicket.mockResolvedValue('a'.repeat(64));
    const app = await build();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/backup/export-ticket',
        payload: { passphrase: secret.passphrase },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({
        downloadUrl: `/api/backup/download/${'a'.repeat(64)}`,
      });
      expect(createBackupExportTicket).toHaveBeenCalledWith({
        userId: 'admin-1',
        secret,
      });
    } finally {
      await app.close();
    }
  });

  it('POST /api/admin/backup/export-ticket 400s without a usable secret', async () => {
    resolveBackupSecret.mockImplementation(() => {
      throw new Error('Provide a passphrase of at least 12 characters, or set BACKUP_ENCRYPTION_KEY');
    });
    const app = await build();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/backup/export-ticket',
        payload: {},
      });

      expect(response.statusCode, response.body).toBe(400);
      expect(createBackupExportTicket).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('POST /api/admin/backup/run enqueues a forced job', async () => {
    const { enqueueJob } = await import('../../core/services/queue-service.js');
    const app = await build();
    try {
      const res = await app.inject({ method: 'POST', url: '/api/admin/backup/run' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ jobId: 'job-1' });
      expect(enqueueJob).toHaveBeenCalledWith('backup', expect.objectContaining({ force: true }));
    } finally {
      await app.close();
    }
  });
});
