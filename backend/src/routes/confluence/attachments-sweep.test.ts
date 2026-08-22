/**
 * #1349 — the attachment sweep's admin surface: wiring only (the llm-image-index
 * route-test pattern). The admin gate, the answered shapes, the 202 semantics
 * and the trigger really reaching the service; the sweep's own behaviour is
 * covered against real Postgres + a temp tree in
 * `domains/confluence/services/attachment-sweep-service.integration.test.ts`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import {
  AttachmentStorageStatsSchema,
  AttachmentSweepStatusSchema,
  type AttachmentSweepRun,
} from '@compendiq/contracts';

const svc = vi.hoisted(() => ({
  run: vi.fn(),
  lastRun: vi.fn(),
  statsRecord: vi.fn(),
}));
vi.mock('../../domains/confluence/services/attachment-sweep-service.js', () => ({
  runAttachmentSweep: (...a: unknown[]) => svc.run(...a),
  readAttachmentSweepLastRun: (...a: unknown[]) => svc.lastRun(...a),
  readAttachmentStorageStatsRecord: (...a: unknown[]) => svc.statsRecord(...a),
  ATTACHMENT_SWEEP_WORKER_LOCK: 'attachment-sweep',
}));

const redis = vi.hoisted(() => ({ locked: vi.fn() }));
vi.mock('../../core/services/redis-cache.js', () => ({
  isWorkerLocked: (...a: unknown[]) => redis.locked(...a),
}));

vi.mock('../../core/services/rate-limit-service.js', () => ({
  getRateLimits: vi.fn(async () => ({ admin: { max: 1000 } })),
}));

vi.mock('../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const { attachmentSweepRoutes } = await import('./attachments-sweep.js');

let isAdmin = true;

const STORE_STATS = {
  bytes: 1024,
  files: 3,
  directories: 2,
  orphanDirectories: 1,
  orphanDirectoryBytes: 100,
  orphanFiles: 1,
  orphanFileBytes: 24,
  graceSkipped: 0,
  unreadableDirectories: 0,
};

const A_RUN: AttachmentSweepRun = {
  at: '2026-08-22T10:00:00.000Z',
  dryRun: true,
  status: 'completed',
  note: null,
  durationMs: 1200,
  stores: { confluence: STORE_STATS, local: STORE_STATS },
  missingLocalFiles: 1,
  candidateSample: [
    { store: 'confluence', key: '55555', filename: null, bytes: 100, reason: 'orphan_directory' },
  ],
  candidatesTotal: 1,
  deleted: null,
};

describe('#1349 attachment sweep routes', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof ZodError) {
        reply.status(400).send({ error: 'ValidationError', statusCode: 400 });
        return;
      }
      const statusCode = (error as Error & { statusCode?: number }).statusCode ?? 500;
      reply.status(statusCode).send({ error: error.name, message: error.message, statusCode });
    });
    app.decorate('authenticate', async (request: { userId: string }) => {
      request.userId = 'test-admin';
    });
    app.decorate('requireAdmin', async () => {
      if (!isAdmin) {
        const err = new Error('admin required') as Error & { statusCode: number };
        err.statusCode = 403;
        throw err;
      }
    });
    await app.register(attachmentSweepRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    isAdmin = true;
    redis.locked.mockResolvedValue(false);
    svc.run.mockResolvedValue(A_RUN);
    svc.lastRun.mockResolvedValue(A_RUN);
    svc.statsRecord.mockResolvedValue({
      at: '2026-08-22T10:00:00.000Z',
      stores: { confluence: STORE_STATS, local: STORE_STATS },
      missingLocalFiles: 1,
    });
  });

  describe('GET /api/admin/attachments/stats', () => {
    it('answers the persisted record — never a walk', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/admin/attachments/stats' });
      expect(res.statusCode).toBe(200);
      const parsed = AttachmentStorageStatsSchema.parse(res.json());
      expect(parsed.computedAt).toBe('2026-08-22T10:00:00.000Z');
      expect(parsed.stores!.confluence.bytes).toBe(1024);
      expect(parsed.missingLocalFiles).toBe(1);
      expect(parsed.running).toBe(false);
      // The record is the only source; the sweep itself is never invoked.
      expect(svc.statsRecord).toHaveBeenCalledTimes(1);
      expect(svc.run).not.toHaveBeenCalled();
    });

    it('reports an explicit no-run-yet state when no record exists', async () => {
      svc.statsRecord.mockResolvedValue(null);
      const res = await app.inject({ method: 'GET', url: '/api/admin/attachments/stats' });
      const parsed = AttachmentStorageStatsSchema.parse(res.json());
      expect(parsed).toMatchObject({ computedAt: null, stores: null, missingLocalFiles: null });
    });

    it('is admin-only', async () => {
      isAdmin = false;
      const res = await app.inject({ method: 'GET', url: '/api/admin/attachments/stats' });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('GET /api/admin/attachments/sweep', () => {
    it('answers running + the persisted last run', async () => {
      redis.locked.mockResolvedValue(true);
      const res = await app.inject({ method: 'GET', url: '/api/admin/attachments/sweep' });
      expect(res.statusCode).toBe(200);
      const parsed = AttachmentSweepStatusSchema.parse(res.json());
      expect(parsed.running).toBe(true);
      expect(parsed.lastRun).toEqual(A_RUN);
    });

    it('is admin-only', async () => {
      isAdmin = false;
      const res = await app.inject({ method: 'GET', url: '/api/admin/attachments/sweep' });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('POST /api/admin/attachments/sweep', () => {
    it('answers 202 started and kicks the sweep with the requested mode', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/attachments/sweep',
        payload: { dryRun: true },
      });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ started: true, alreadyRunning: false });
      expect(svc.run).toHaveBeenCalledWith({ dryRun: true });
    });

    it('reports alreadyRunning when the worker lock is held', async () => {
      redis.locked.mockResolvedValue(true);
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/attachments/sweep',
        payload: { dryRun: false },
      });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ started: false, alreadyRunning: true });
      // It still kicks — the read and the kick are not atomic, and a lock
      // released in between must not leave nothing running (kickScan's rule).
      expect(svc.run).toHaveBeenCalledWith({ dryRun: false });
    });

    it('refuses a body without an explicit dryRun', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/admin/attachments/sweep', payload: {} });
      expect(res.statusCode).toBe(400);
      expect(svc.run).not.toHaveBeenCalled();
    });

    it('does not fail the request when the detached run rejects', async () => {
      svc.run.mockRejectedValue(new Error('boom'));
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/attachments/sweep',
        payload: { dryRun: true },
      });
      expect(res.statusCode).toBe(202);
    });

    it('is admin-only', async () => {
      isAdmin = false;
      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/attachments/sweep',
        payload: { dryRun: true },
      });
      expect(res.statusCode).toBe(403);
      expect(svc.run).not.toHaveBeenCalled();
    });
  });
});
