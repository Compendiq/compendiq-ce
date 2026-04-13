import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('Enterprise integration in app bootstrap', () => {
  describe('community mode (no enterprise package)', () => {
    let app: ReturnType<typeof Fastify>;

    beforeAll(async () => {
      // Build a minimal Fastify app that mimics the enterprise bootstrap in app.ts
      const { loadEnterprisePlugin } = await import('./loader.js');
      const { _resetForTesting } = await import('./loader.js');
      _resetForTesting();

      app = Fastify({ logger: false });
      await app.register(sensible);

      // Mock auth decorators (same pattern as admin.test.ts)
      app.decorate('authenticate', async (request: { userId: string; username: string; userRole: string }) => {
        request.userId = 'admin-user-id';
        request.username = 'admin';
        request.userRole = 'admin';
      });
      app.decorate('requireAdmin', async (request: { userId: string; username: string; userRole: string }) => {
        request.userId = 'admin-user-id';
        request.username = 'admin';
        request.userRole = 'admin';
      });

      // Enterprise bootstrap (same as app.ts)
      const enterprise = await loadEnterprisePlugin();
      const license = enterprise.validateLicense(undefined);
      app.decorate('license', license);
      app.decorate('enterprise', enterprise);
      await enterprise.registerRoutes(app, license);

      // Community license fallback route (same as app.ts)
      app.get('/api/admin/license', { onRequest: [app.requireAdmin] }, async () => ({
        edition: 'community',
        tier: 'community',
        features: [],
      }));

      await app.ready();
    });

    afterAll(async () => {
      await app.close();
    });

    it('GET /api/admin/license should return community edition', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/license',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toEqual({
        edition: 'community',
        tier: 'community',
        features: [],
      });
    });

    it('app.license should be null in community mode', () => {
      expect(app.license).toBeNull();
    });

    it('app.enterprise should be the noop plugin', () => {
      expect(app.enterprise.version).toBe('community');
    });

    it('app.enterprise.isFeatureEnabled should return false for all features', () => {
      expect(app.enterprise.isFeatureEnabled('oidc_sso', app.license)).toBe(false);
      expect(app.enterprise.isFeatureEnabled('audit_log_export', app.license)).toBe(false);
    });
  });

  describe('non-admin access to license endpoint', () => {
    let app: ReturnType<typeof Fastify>;

    beforeAll(async () => {
      const { loadEnterprisePlugin, _resetForTesting } = await import('./loader.js');
      _resetForTesting();

      app = Fastify({ logger: false });
      await app.register(sensible);

      app.setErrorHandler((error, _request, reply) => {
        reply.status(error.statusCode ?? 500).send({
          error: error.message,
          statusCode: error.statusCode ?? 500,
        });
      });

      // Non-admin auth decorators
      app.decorate('authenticate', async (request: { userId: string; username: string; userRole: string }) => {
        request.userId = 'user-id';
        request.username = 'user';
        request.userRole = 'user';
      });
      app.decorate('requireAdmin', async (_request: unknown, reply: { code: (n: number) => { send: (body: unknown) => void } }) => {
        reply.code(403).send({ error: 'Admin access required', statusCode: 403 });
      });

      const enterprise = await loadEnterprisePlugin();
      const license = enterprise.validateLicense(undefined);
      app.decorate('license', license);
      app.decorate('enterprise', enterprise);

      app.get('/api/admin/license', { onRequest: [app.requireAdmin] }, async () => ({
        edition: 'community',
        tier: 'community',
        features: [],
      }));

      await app.ready();
    });

    afterAll(async () => {
      await app.close();
    });

    it('should return 403 for non-admin users', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/license',
      });

      expect(response.statusCode).toBe(403);
    });
  });
});
