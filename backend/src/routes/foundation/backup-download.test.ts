import { PassThrough } from 'node:stream';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backupDownloadRoutes } from './backup-download.js';

const consumeBackupExportTicket = vi.fn();
vi.mock('../../core/services/backup-export-ticket.js', () => ({
  consumeBackupExportTicket: (...args: unknown[]) => consumeBackupExportTicket(...args),
}));

const createEncryptedBackupStream = vi.fn();
vi.mock('../../core/services/backup-service.js', () => ({
  createEncryptedBackupStream: (...args: unknown[]) => createEncryptedBackupStream(...args),
  BackupLockError: class BackupLockError extends Error {},
  BackupDumpError: class BackupDumpError extends Error {},
}));

const logAuditEvent = vi.fn(async () => undefined);
vi.mock('../../core/services/audit-service.js', () => ({
  logAuditEvent: (...args: unknown[]) => logAuditEvent(...args),
}));

const TICKET = 'a'.repeat(64);
const SECRET = { kind: 'passphrase' as const, passphrase: 'correct horse battery staple' };

async function build() {
  const app = Fastify();
  await app.register(backupDownloadRoutes, { prefix: '/api' });
  await app.ready();
  return app;
}

describe('backup download routes (#1420)', () => {
  beforeEach(() => {
    consumeBackupExportTicket.mockResolvedValue({ userId: 'admin-1', secret: SECRET });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('rejects malformed ticket paths before consulting Redis', async () => {
    const app = await build();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/backup/download/NOT-A-TICKET',
      });

      expect(response.statusCode).toBe(404);
      expect(consumeBackupExportTicket).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('streams a ticket once and returns 404 when it is reused', async () => {
    consumeBackupExportTicket
      .mockResolvedValueOnce({ userId: 'admin-1', secret: SECRET })
      .mockResolvedValueOnce(null);
    createEncryptedBackupStream.mockResolvedValue({
      stream: PassThrough.from([Buffer.from('encrypted-backup')]),
      filename: 'compendiq-backup.enc',
    });
    const app = await build();
    try {
      const first = await app.inject({
        method: 'GET',
        url: `/api/backup/download/${TICKET}`,
      });
      const reused = await app.inject({
        method: 'GET',
        url: `/api/backup/download/${TICKET}`,
      });

      expect(first.statusCode).toBe(200);
      expect(first.rawPayload).toEqual(Buffer.from('encrypted-backup'));
      expect(first.headers).toMatchObject({
        'cache-control': 'no-store',
        'content-type': 'application/octet-stream',
        'content-disposition': 'attachment; filename="compendiq-backup.enc"',
        'referrer-policy': 'no-referrer',
      });
      expect(reused.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('records completion only after the readable finishes', async () => {
    const stream = new PassThrough();
    createEncryptedBackupStream.mockResolvedValue({
      stream,
      filename: 'compendiq-backup.enc',
    });
    const app = await build();
    try {
      const responsePromise = app.inject({
        method: 'GET',
        url: `/api/backup/download/${TICKET}`,
      });
      await vi.waitFor(() => expect(createEncryptedBackupStream).toHaveBeenCalledOnce());

      expect(logAuditEvent).not.toHaveBeenCalled();
      stream.end('encrypted-backup');
      const response = await responsePromise;

      expect(response.statusCode).toBe(200);
      await vi.waitFor(() => {
        expect(logAuditEvent).toHaveBeenCalledOnce();
        expect(logAuditEvent).toHaveBeenCalledWith(
          'admin-1',
          'BACKUP_EXPORTED',
          'backup',
          'compendiq-backup.enc',
          { filename: 'compendiq-backup.enc' },
        );
      });
    } finally {
      await app.close();
    }
  });

  it('records a stream error as one failed export and never as completed', async () => {
    const stream = new PassThrough();
    createEncryptedBackupStream.mockResolvedValue({
      stream,
      filename: 'compendiq-backup.enc',
    });
    const app = await build();
    try {
      const responsePromise = app
        .inject({ method: 'GET', url: `/api/backup/download/${TICKET}` })
        .catch(() => undefined);
      await vi.waitFor(() => expect(createEncryptedBackupStream).toHaveBeenCalledOnce());

      stream.destroy(new Error('pg_dump failed'));
      await responsePromise;
      await vi.waitFor(() => expect(logAuditEvent).toHaveBeenCalledOnce());

      expect(logAuditEvent).toHaveBeenCalledWith(
        'admin-1',
        'BACKUP_EXPORT_FAILED',
        'backup',
        'compendiq-backup.enc',
        { filename: 'compendiq-backup.enc' },
      );
      expect(logAuditEvent).not.toHaveBeenCalledWith(
        expect.anything(),
        'BACKUP_EXPORTED',
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
    } finally {
      await app.close();
    }
  });
});
