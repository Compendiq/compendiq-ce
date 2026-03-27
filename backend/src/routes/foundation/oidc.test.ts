import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock oidc-service module — must be before importing the routes
vi.mock('../../core/services/oidc-service.js', () => ({
  getEnabledProvider: vi.fn(),
  getProvider: vi.fn(),
  upsertProvider: vi.fn(),
  buildAuthorizationUrl: vi.fn(),
  consumeAuthSession: vi.fn(),
  exchangeCodeForTokens: vi.fn(),
  verifyIdToken: vi.fn(),
  provisionOidcUser: vi.fn(),
  syncOidcGroups: vi.fn(),
  getDiscoveryDocument: vi.fn(),
  listOidcGroupRoleMappings: vi.fn(),
  createOidcGroupRoleMapping: vi.fn(),
  deleteOidcGroupRoleMapping: vi.fn(),
}));

// Mock auth plugin
vi.mock('../../core/plugins/auth.js', () => ({
  generateAccessToken: vi.fn().mockResolvedValue('mock-access-token'),
  generateRefreshToken: vi.fn().mockResolvedValue({
    token: 'mock-refresh-token',
    jti: 'mock-jti',
    family: 'mock-family',
  }),
  default: vi.fn().mockResolvedValue(undefined),
}));

// Mock audit service
vi.mock('../../core/services/audit-service.js', () => ({
  logAuditEvent: vi.fn(),
}));

// Mock redis-cache
const mockRedisGet = vi.fn();
const mockRedisSet = vi.fn();
const mockRedisDel = vi.fn();
const mockRedisGetDel = vi.fn();
vi.mock('../../core/services/redis-cache.js', () => ({
  getRedisClient: vi.fn(() => ({
    get: mockRedisGet,
    set: mockRedisSet,
    del: mockRedisDel,
    getDel: mockRedisGetDel,
  })),
}));

// Mock logger
vi.mock('../../core/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock enterprise license-service — default to valid enterprise license
const mockIsEnterprise = vi.fn().mockReturnValue(true);
const mockGetLicenseInfo = vi.fn().mockReturnValue({
  tier: 'enterprise',
  seats: 100,
  expiry: new Date(2030, 11, 31),
  isValid: true,
  isExpired: false,
  raw: 'ATM-enterprise-100-20301231-fakesig',
});
vi.mock('../../enterprise/license-service.js', () => ({
  isEnterprise: (...args: unknown[]) => mockIsEnterprise(...args),
  getLicenseInfo: (...args: unknown[]) => mockGetLicenseInfo(...args),
}));

import Fastify, { type FastifyRequest } from 'fastify';
import sensible from '@fastify/sensible';
import cookie from '@fastify/cookie';
import { ZodError } from 'zod';
import licensePlugin from '../../enterprise/license-middleware.js';
import { oidcRoutes, oidcAdminRoutes } from './oidc.js';
import {
  getEnabledProvider,
  getProvider,
  upsertProvider,
  buildAuthorizationUrl,
  consumeAuthSession,
  exchangeCodeForTokens,
  verifyIdToken,
  provisionOidcUser,
  syncOidcGroups,
  getDiscoveryDocument,
  listOidcGroupRoleMappings,
  createOidcGroupRoleMapping,
  deleteOidcGroupRoleMapping,
} from '../../core/services/oidc-service.js';

const MOCK_PROVIDER = {
  id: 1,
  name: 'default',
  issuerUrl: 'https://idp.example.com',
  clientId: 'test-client-id',
  clientSecretEncrypted: 'v0:abc:def:encrypted',
  redirectUri: 'http://localhost:3051/api/auth/oidc/callback',
  groupsClaim: 'groups',
  enabled: true,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
};

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  await app.register(cookie);

  // Register mock auth decorators
  app.decorate('authenticate', async (request: FastifyRequest) => {
    request.userId = 'admin-user-id';
    request.username = 'admin';
    request.userRole = 'admin' as const;
  });
  app.decorate('requireAdmin', async (request: FastifyRequest) => {
    request.userId = 'admin-user-id';
    request.username = 'admin';
    request.userRole = 'admin' as const;
  });

  // Register license plugin (provides checkEnterpriseLicense decorator + licenseTier)
  await app.register(licensePlugin);

  // Zod error handler (same as app.ts)
  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    if (error instanceof ZodError) {
      reply.status(400).send({
        error: 'ValidationError',
        message: error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
        statusCode: 400,
      });
      return;
    }
    const statusCode = error.statusCode ?? 500;
    reply.status(statusCode).send({
      error: error.name ?? 'InternalServerError',
      message: statusCode === 500 ? 'Internal Server Error' : error.message,
      statusCode,
    });
  });

  await app.register(oidcRoutes, { prefix: '/api' });
  await app.register(oidcAdminRoutes, { prefix: '/api' });
  return app;
}

describe('OIDC Routes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset enterprise license mocks to valid enterprise (default for OIDC tests)
    mockIsEnterprise.mockReturnValue(true);
    mockGetLicenseInfo.mockReturnValue({
      tier: 'enterprise',
      seats: 100,
      expiry: new Date(2030, 11, 31),
      isValid: true,
      isExpired: false,
      raw: 'ATM-enterprise-100-20301231-fakesig',
    });
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  // ── Public endpoints ──────────────────────────────────────────────────────

  describe('GET /api/auth/oidc/config', () => {
    it('returns enabled=true when provider is configured and enterprise license is valid', async () => {
      vi.mocked(getEnabledProvider).mockResolvedValue(MOCK_PROVIDER);
      mockIsEnterprise.mockReturnValue(true);

      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/oidc/config',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.enabled).toBe(true);
      expect(body.issuer).toBe('https://idp.example.com');
      expect(body.enterpriseRequired).toBe(false);
    });

    it('returns enabled=false when no provider is configured', async () => {
      vi.mocked(getEnabledProvider).mockResolvedValue(null);
      mockIsEnterprise.mockReturnValue(true);

      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/oidc/config',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.enabled).toBe(false);
      expect(body.issuer).toBeNull();
      expect(body.enterpriseRequired).toBe(false);
    });

    it('returns enabled=false and enterpriseRequired=true when no enterprise license', async () => {
      vi.mocked(getEnabledProvider).mockResolvedValue(MOCK_PROVIDER);
      mockIsEnterprise.mockReturnValue(false);
      mockGetLicenseInfo.mockReturnValue({
        tier: 'community',
        seats: 0,
        expiry: new Date(0),
        isValid: false,
        isExpired: false,
        raw: null,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/oidc/config',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.enabled).toBe(false);
      expect(body.enterpriseRequired).toBe(true);
      // Provider info is still returned so frontend knows OIDC is configured
      expect(body.issuer).toBe('https://idp.example.com');
    });
  });

  describe('GET /api/auth/oidc/authorize', () => {
    it('redirects to IdP authorization URL when provider is enabled', async () => {
      vi.mocked(getEnabledProvider).mockResolvedValue(MOCK_PROVIDER);
      vi.mocked(buildAuthorizationUrl).mockResolvedValue({
        url: 'https://idp.example.com/authorize?client_id=test&state=abc',
        state: 'abc',
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/oidc/authorize',
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe(
        'https://idp.example.com/authorize?client_id=test&state=abc',
      );
    });

    it('returns 503 when OIDC is not enabled', async () => {
      vi.mocked(getEnabledProvider).mockResolvedValue(null);

      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/oidc/authorize',
      });

      expect(res.statusCode).toBe(503);
    });
  });

  describe('GET /api/auth/oidc/callback', () => {
    it('exchanges code and redirects with login_code on success', async () => {
      vi.mocked(consumeAuthSession).mockResolvedValue({
        state: 'test-state',
        nonce: 'test-nonce',
        codeVerifier: 'test-verifier',
        providerId: 1,
        redirectUri: 'http://localhost:3051/api/auth/oidc/callback',
      });
      vi.mocked(getEnabledProvider).mockResolvedValue(MOCK_PROVIDER);
      vi.mocked(exchangeCodeForTokens).mockResolvedValue({
        access_token: 'idp-access-token',
        id_token: 'idp-id-token',
        token_type: 'Bearer',
      });
      vi.mocked(verifyIdToken).mockResolvedValue({
        sub: 'oidc-user-123',
        iss: 'https://idp.example.com',
        aud: 'test-client-id',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        nonce: 'test-nonce',
        preferred_username: 'jdoe',
        email: 'jdoe@example.com',
        groups: ['engineering', 'dev-team'],
      });
      vi.mocked(provisionOidcUser).mockResolvedValue({
        id: 'user-uuid-123',
        username: 'jdoe',
        role: 'user',
      });
      vi.mocked(syncOidcGroups).mockResolvedValue();

      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/oidc/callback?code=auth-code-123&state=test-state',
      });

      expect(res.statusCode).toBe(302);
      const location = res.headers.location as string;
      expect(location).toContain('/auth/oidc/callback');
      expect(location).toContain('login_code=');
      // Should NOT contain tokens in the URL
      expect(location).not.toContain('mock-access-token');

      // Verify login code was stored in Redis
      expect(mockRedisSet).toHaveBeenCalledTimes(1);
      const [redisKey, redisValue, redisOpts] = mockRedisSet.mock.calls[0];
      expect(redisKey).toMatch(/^oidc:login_code:/);
      expect(redisOpts.EX).toBe(60);
      const storedData = JSON.parse(redisValue);
      expect(storedData.accessToken).toBe('mock-access-token');
      expect(storedData.user.id).toBe('user-uuid-123');
    });

    it('redirects to login with error on invalid state', async () => {
      vi.mocked(consumeAuthSession).mockResolvedValue(null);

      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/oidc/callback?code=auth-code&state=invalid-state',
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain('/login');
      expect(res.headers.location).toContain('error=oidc_state_invalid');
    });

    it('redirects to login with error on provider mismatch', async () => {
      vi.mocked(consumeAuthSession).mockResolvedValue({
        state: 'test-state',
        nonce: 'test-nonce',
        codeVerifier: 'test-verifier',
        providerId: 999, // Different from MOCK_PROVIDER.id
        redirectUri: 'http://localhost:3051/api/auth/oidc/callback',
      });
      vi.mocked(getEnabledProvider).mockResolvedValue(MOCK_PROVIDER);

      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/oidc/callback?code=auth-code&state=test-state',
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain('error=oidc_provider_mismatch');
    });
  });

  describe('POST /api/auth/oidc/exchange', () => {
    it('exchanges a valid login code for tokens (atomic getDel)', async () => {
      const storedData = {
        accessToken: 'stored-access-token',
        refreshToken: 'stored-refresh-token',
        user: { id: 'user-123', username: 'jdoe', role: 'user' },
      };
      mockRedisGetDel.mockResolvedValue(JSON.stringify(storedData));

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/oidc/exchange',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: 'valid-login-code' }),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.accessToken).toBe('stored-access-token');
      expect(body.user.username).toBe('jdoe');
      // Verify atomic get-and-delete was used (not separate get + del)
      expect(mockRedisGetDel).toHaveBeenCalledWith('oidc:login_code:valid-login-code');
      expect(mockRedisDel).not.toHaveBeenCalled();
    });

    it('returns 401 for invalid login code', async () => {
      mockRedisGetDel.mockResolvedValue(null);

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/oidc/exchange',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: 'invalid-code' }),
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('POST /api/auth/oidc/logout', () => {
    it('clears the refresh cookie and returns end-session URL', async () => {
      vi.mocked(getEnabledProvider).mockResolvedValue(MOCK_PROVIDER);
      vi.mocked(getDiscoveryDocument).mockResolvedValue({
        issuer: 'https://idp.example.com',
        authorization_endpoint: 'https://idp.example.com/authorize',
        token_endpoint: 'https://idp.example.com/token',
        jwks_uri: 'https://idp.example.com/jwks',
        end_session_endpoint: 'https://idp.example.com/logout',
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/oidc/logout',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.endSessionUrl).toContain('https://idp.example.com/logout');
      expect(body.endSessionUrl).toContain('client_id=test-client-id');
    });

    it('requires authentication (onRequest hook)', async () => {
      // Build a separate app where authenticate rejects unauthenticated requests
      const strictApp = Fastify({ logger: false });
      await strictApp.register(sensible);
      await strictApp.register(cookie);
      strictApp.decorate('authenticate', async (_request: FastifyRequest) => {
        // Simulate auth failure — no Authorization header
        throw strictApp.httpErrors.unauthorized('Not authenticated');
      });
      strictApp.decorate('requireAdmin', async () => { /* no-op */ });
      await strictApp.register(licensePlugin);
      strictApp.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
        const statusCode = error.statusCode ?? 500;
        reply.status(statusCode).send({ error: error.message, statusCode });
      });
      await strictApp.register(oidcRoutes, { prefix: '/api' });

      const res = await strictApp.inject({
        method: 'POST',
        url: '/api/auth/oidc/logout',
      });

      expect(res.statusCode).toBe(401);
      await strictApp.close();
    });
  });

  // ── Admin endpoints ───────────────────────────────────────────────────────

  describe('GET /api/admin/oidc', () => {
    it('returns configured=false when no provider exists', async () => {
      vi.mocked(getProvider).mockResolvedValue(null);

      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/oidc',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.configured).toBe(false);
      expect(body.provider).toBeNull();
    });

    it('returns provider config without client secret', async () => {
      vi.mocked(getProvider).mockResolvedValue(MOCK_PROVIDER);

      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/oidc',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.configured).toBe(true);
      expect(body.provider.issuerUrl).toBe('https://idp.example.com');
      expect(body.provider.clientId).toBe('test-client-id');
      // Client secret must never be exposed
      expect(body.provider.clientSecret).toBeUndefined();
      expect(body.provider.clientSecretEncrypted).toBeUndefined();
    });
  });

  describe('PUT /api/admin/oidc', () => {
    it('saves OIDC configuration', async () => {
      vi.mocked(upsertProvider).mockResolvedValue(MOCK_PROVIDER);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/admin/oidc',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          issuerUrl: 'https://idp.example.com',
          clientId: 'test-client-id',
          clientSecret: 'super-secret',
          redirectUri: 'http://localhost:3051/api/auth/oidc/callback',
          groupsClaim: 'groups',
          enabled: true,
        }),
      });

      expect(res.statusCode).toBe(200);
      expect(upsertProvider).toHaveBeenCalledWith(expect.objectContaining({
        issuerUrl: 'https://idp.example.com',
        clientId: 'test-client-id',
        clientSecret: 'super-secret',
      }));
    });

    it('saves without clientSecret to preserve existing secret', async () => {
      vi.mocked(upsertProvider).mockResolvedValue(MOCK_PROVIDER);

      const res = await app.inject({
        method: 'PUT',
        url: '/api/admin/oidc',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          issuerUrl: 'https://idp.example.com',
          clientId: 'test-client-id',
          // clientSecret intentionally omitted — backend should preserve existing
          redirectUri: 'http://localhost:3051/api/auth/oidc/callback',
          groupsClaim: 'groups',
          enabled: true,
        }),
      });

      expect(res.statusCode).toBe(200);
      expect(upsertProvider).toHaveBeenCalledWith(expect.objectContaining({
        issuerUrl: 'https://idp.example.com',
        clientId: 'test-client-id',
      }));
      // clientSecret should be undefined (not 'UNCHANGED')
      const call = vi.mocked(upsertProvider).mock.calls[0][0];
      expect(call.clientSecret).toBeUndefined();
    });

    it('rejects invalid input', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/admin/oidc',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          issuerUrl: 'not-a-url',
          clientId: '',
          clientSecret: 'secret',
          redirectUri: 'http://localhost:3051/callback',
        }),
      });

      // Zod validation should fail
      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /api/admin/oidc/test', () => {
    it('returns success when discovery endpoint works', async () => {
      vi.mocked(getDiscoveryDocument).mockResolvedValue({
        issuer: 'https://idp.example.com',
        authorization_endpoint: 'https://idp.example.com/authorize',
        token_endpoint: 'https://idp.example.com/token',
        jwks_uri: 'https://idp.example.com/jwks',
        end_session_endpoint: 'https://idp.example.com/logout',
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/oidc/test',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ issuerUrl: 'https://idp.example.com' }),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.issuer).toBe('https://idp.example.com');
    });

    it('returns failure when discovery endpoint fails', async () => {
      vi.mocked(getDiscoveryDocument).mockRejectedValue(new Error('Connection refused'));

      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/oidc/test',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ issuerUrl: 'https://broken.example.com' }),
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Connection refused');
    });
  });

  describe('OIDC Mapping CRUD', () => {
    it('GET /api/admin/oidc/mappings lists mappings', async () => {
      vi.mocked(listOidcGroupRoleMappings).mockResolvedValue([
        { id: 1, oidcGroup: 'engineering', roleId: 3, roleName: 'editor', spaceKey: 'DEV' },
      ]);

      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/oidc/mappings',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveLength(1);
      expect(body[0].oidcGroup).toBe('engineering');
    });

    it('POST /api/admin/oidc/mappings creates a mapping', async () => {
      vi.mocked(createOidcGroupRoleMapping).mockResolvedValue({
        id: 2, oidcGroup: 'devops', roleId: 2, roleName: 'space_admin', spaceKey: 'OPS',
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/admin/oidc/mappings',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ oidcGroup: 'devops', roleId: 2, spaceKey: 'OPS' }),
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.oidcGroup).toBe('devops');
    });

    it('DELETE /api/admin/oidc/mappings/:id deletes a mapping', async () => {
      vi.mocked(deleteOidcGroupRoleMapping).mockResolvedValue(true);

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/admin/oidc/mappings/1',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.message).toBe('Mapping deleted');
    });

    it('DELETE /api/admin/oidc/mappings/:id returns 404 for missing mapping', async () => {
      vi.mocked(deleteOidcGroupRoleMapping).mockResolvedValue(false);

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/admin/oidc/mappings/999',
      });

      expect(res.statusCode).toBe(404);
    });
  });
});
