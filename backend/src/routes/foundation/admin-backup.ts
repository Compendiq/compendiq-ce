/**
 * Encrypted backup export / S3 configuration (#1420).
 *
 *   GET  /api/admin/backup                 — status, S3 config (secrets masked), history
 *   PUT  /api/admin/backup                 — S3 + schedule settings
 *   POST /api/admin/backup/export-ticket   — short-lived browser download ticket
 *   POST /api/admin/backup/test-s3         — Head/list the configured bucket
 *   POST /api/admin/backup/run             — enqueue / run an S3 backup now
 */

import type { FastifyInstance } from 'fastify';
import {
  BackupExportTicketRequestSchema,
  BackupExportTicketResponseSchema,
  UpdateBackupSettingsSchema,
} from '@compendiq/contracts';
import { logAuditEvent } from '../../core/services/audit-service.js';
import { getRateLimits } from '../../core/services/rate-limit-service.js';
import { enqueueJob } from '../../core/services/queue-service.js';
import {
  getBackupPublicConfig,
  getBackupRuntimeConfig,
  hasMasterBackupKey,
  updateBackupSettings,
} from '../../core/services/backup-settings.js';
import { assertSafeS3Endpoint, testS3Connection } from '../../core/services/backup-s3.js';
import {
  isBackupLockHeld,
  listBackupRuns,
  resolveBackupSecret,
} from '../../core/services/backup-service.js';
import { createBackupExportTicket } from '../../core/services/backup-export-ticket.js';
import { SsrfError } from '../../core/utils/ssrf-guard.js';

const ADMIN_RATE_LIMIT = {
  config: {
    rateLimit: {
      max: async () => (await getRateLimits()).admin.max,
      timeWindow: '1 minute',
    },
  },
};

export async function adminBackupRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  fastify.get(
    '/admin/backup',
    { preHandler: fastify.requireAdmin, ...ADMIN_RATE_LIMIT },
    async () => {
      const { s3, schedule } = await getBackupPublicConfig();
      const history = await listBackupRuns(20);
      return {
        hasMasterKey: hasMasterBackupKey(),
        lockHeld: await isBackupLockHeld(),
        s3,
        schedule,
        history,
      };
    },
  );

  fastify.put(
    '/admin/backup',
    { preHandler: fastify.requireAdmin, ...ADMIN_RATE_LIMIT },
    async (request, reply) => {
      const body = UpdateBackupSettingsSchema.parse(request.body ?? {});
      if (body.s3Endpoint) {
        try {
          await assertSafeS3Endpoint(body.s3Endpoint);
        } catch (err) {
          if (!(err instanceof SsrfError)) throw err;
          return reply.code(400).send({
            error: 'Bad Request',
            message: err.message,
            statusCode: 400,
          });
        }
      }
      await updateBackupSettings(body);
      await logAuditEvent(
        request.userId,
        'BACKUP_SETTINGS_CHANGED',
        'backup',
        undefined,
        { keys: Object.keys(body) },
        request,
      );
      const { s3, schedule } = await getBackupPublicConfig();
      return { s3, schedule };
    },
  );

  fastify.post(
    '/admin/backup/export-ticket',
    {
      preHandler: fastify.requireAdmin,
      ...ADMIN_RATE_LIMIT,
    },
    async (request, reply) => {
      const body = BackupExportTicketRequestSchema.parse(request.body ?? {});
      let secret;
      try {
        secret = resolveBackupSecret(body.passphrase);
      } catch (err) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: err instanceof Error ? err.message : 'Invalid backup secret',
          statusCode: 400,
        });
      }

      const ticket = await createBackupExportTicket({
        userId: request.userId,
        secret,
      });
      return BackupExportTicketResponseSchema.parse({
        downloadUrl: `/api/backup/download/${ticket}`,
      });
    },
  );

  fastify.post(
    '/admin/backup/test-s3',
    { preHandler: fastify.requireAdmin, ...ADMIN_RATE_LIMIT },
    async (request, reply) => {
      const cfg = await getBackupRuntimeConfig();
      if (!cfg.s3.endpoint || !cfg.s3.bucket) {
        return reply.code(400).send({
          ok: false,
          error: 'S3 endpoint and bucket are required',
        });
      }
      try {
        await testS3Connection({
          endpoint: cfg.s3.endpoint,
          bucket: cfg.s3.bucket,
          region: cfg.s3.region,
          accessKey: cfg.s3.accessKey,
          secretKey: cfg.s3.secretKey,
          prefix: cfg.s3.prefix,
          forcePathStyle: cfg.s3.forcePathStyle,
        });
        await logAuditEvent(request.userId, 'BACKUP_S3_TESTED', 'backup', undefined, { ok: true }, request);
        return { ok: true };
      } catch (err) {
        const message = err instanceof SsrfError || err instanceof Error ? err.message : String(err);
        return reply.code(400).send({ ok: false, error: message });
      }
    },
  );

  fastify.post(
    '/admin/backup/run',
    { preHandler: fastify.requireAdmin, ...ADMIN_RATE_LIMIT },
    async (request) => {
      const jobId = await enqueueJob('backup', { triggeredBy: request.userId ?? null, force: true });
      await logAuditEvent(
        request.userId,
        'BACKUP_UPLOADED',
        'backup',
        jobId,
        { queued: true },
        request,
      );
      return { jobId };
    },
  );
}
