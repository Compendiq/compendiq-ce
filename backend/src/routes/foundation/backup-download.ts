import type { FastifyInstance } from 'fastify';
import { logAuditEvent, type AuditAction } from '../../core/services/audit-service.js';
import { consumeBackupExportTicket } from '../../core/services/backup-export-ticket.js';
import {
  BackupDumpError,
  BackupLockError,
  createEncryptedBackupStream,
  type EncryptedBackupStream,
} from '../../core/services/backup-service.js';

const TICKET_PATTERN = /^[0-9a-f]{64}$/;

export async function backupDownloadRoutes(fastify: FastifyInstance) {
  fastify.get('/backup/download/:ticket', { exposeHeadRoute: false }, async (request, reply) => {
    const { ticket } = request.params as { ticket: string };
    if (!TICKET_PATTERN.test(ticket)) {
      return reply.code(404).send({
        error: 'Not Found',
        message: 'Backup export ticket not found',
        statusCode: 404,
      });
    }

    const exportTicket = await consumeBackupExportTicket(ticket);
    if (!exportTicket) {
      return reply.code(404).send({
        error: 'Not Found',
        message: 'Backup export ticket not found',
        statusCode: 404,
      });
    }

    let backup: EncryptedBackupStream;
    try {
      backup = await createEncryptedBackupStream(exportTicket.secret);
    } catch (err) {
      await logAuditEvent(
        exportTicket.userId,
        'BACKUP_EXPORT_FAILED',
        'backup',
        undefined,
        { error: err instanceof Error ? err.message : String(err) },
      );

      if (err instanceof BackupLockError) {
        return reply.code(409).send({
          error: 'Conflict',
          message: err.message,
          statusCode: 409,
        });
      }
      if (err instanceof BackupDumpError) {
        return reply.code(503).send({
          error: 'Service Unavailable',
          message: err.message,
          statusCode: 503,
        });
      }
      throw err;
    }

    const { stream, filename } = backup;
    let auditRecorded = false;
    const recordAudit = (action: AuditAction) => {
      if (auditRecorded) return;
      auditRecorded = true;
      void logAuditEvent(
        exportTicket.userId,
        action,
        'backup',
        filename,
        { filename },
      );
    };

    stream.once('error', () => recordAudit('BACKUP_EXPORT_FAILED'));
    reply.raw.once('finish', () => recordAudit('BACKUP_EXPORTED'));
    reply.raw.once('close', () => {
      if (!reply.raw.writableFinished) recordAudit('BACKUP_EXPORT_FAILED');
    });

    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cache-Control', 'no-store');
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    return reply.send(stream);
  });
}
