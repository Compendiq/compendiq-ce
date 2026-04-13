import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import cookie from '@fastify/cookie';
import { ZodError } from 'zod';

// ---------------------------------------------------------------------------
// Mocks — declared BEFORE the route import so vi.mock hoisting works
// ---------------------------------------------------------------------------

const mockQuery = vi.fn();
vi.mock('../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

const mockBcryptHash = vi.fn();
const mockBcryptCompare = vi.fn();
vi.mock('bcrypt', () => ({
  default: {
    hash: (...a: unknown[]) => mockBcryptHash(...a),
    compare: (...a: unknown[]) => mockBcryptCompare(...a),
  },
}));

const mockGenerateAccessToken = vi.fn().mockResolvedValue('mock-access-token');
const mockGenerateRefreshToken = vi.fn().mockResolvedValue({ token: 'mock-refresh-token', jti: 'mock-jti' });
const mockVerifyRefreshToken = vi.fn();
const mockRevokeToken = vi.fn();
const mockRevokeAllUserTokens = vi.fn();
const mockCleanupExpiredTokens = vi.fn();
const mockVerifyToken = vi.fn();
vi.mock('../../core/plugins/auth.js', () => ({
  generateAccessToken: (...a: unknown[]) => mockGenerateAccessToken(...a),
  generateRefreshToken: (...a: unknown[]) => mockGenerateRefreshToken(...a),
  verifyRefreshToken: (...a: unknown[]) => mockVerifyRefreshToken(...a),
  revokeToken: (...a: unknown[]) => mockRevokeToken(...a),
  revokeAllUserTokens: (...a: unknown[]) => mockRevokeAllUserTokens(...a),
  cleanupExpiredTokens: (...a: unknown[]) => mockCleanupExpiredTokens(...a),
  verifyToken: (...a: unknown[]) => mockVerifyToken(...a),
}));

vi.mock('../../core/services/audit-service.js', () => ({
  logAuditEvent: vi.fn(),
}));

vi.mock('../../core/utils/logger.js', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock('../../core/services/rate-limit-service.js', () => ({
  getRateLimits: vi.fn().mockResolvedValue({ auth: { max: 100 }, admin: { max: 100 }, global: { max: 1000 } }),
}));

import { authRoutes } from './auth.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_USER = {
  id: 'user-uuid-1',
  username: 'testuser',
  role: 'user',
  password_hash: '$2b$12$hashedpassword',
};

function buildApp() {
  const app = Fastify({ logger: false });
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Auth routes', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = buildApp();
    await app.register(sensible);
    await app.register(cookie);

    // Zod validation → 400 (matches production error handler)
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof ZodError) {
        reply.status(400).send({
          error: 'ValidationError',
          message: error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
          statusCode: 400,
        });
        return;
      }
      reply.status(error.statusCode ?? 500).send({
        error: error.message,
        statusCode: error.statusCode ?? 500,
      });
    });

    // Decorators used by auth routes (authenticate, requireAdmin)
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

    await app.register(authRoutes, { prefix: '/api/auth' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Restore default happy-path mocks
    mockGenerateAccessToken.mockResolvedValue('mock-access-token');
    mockGenerateRefreshToken.mockResolvedValue({ token: 'mock-refresh-token', jti: 'mock-jti' });
  });

  // ==========================================================================
  // POST /register
  // ==========================================================================

  describe('POST /api/auth/register', () => {
    it('should create a user and return 201 with accessToken and user', async () => {
      mockBcryptHash.mockResolvedValue('hashed-password');
      // First query: INSERT user RETURNING id, username, role
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: TEST_USER.id, username: TEST_USER.username, role: TEST_USER.role }],
      });
      // Second query: INSERT user_settings
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { username: 'testuser', password: 'securepassword' },
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.accessToken).toBe('mock-access-token');
      expect(body.user).toEqual({
        id: TEST_USER.id,
        username: TEST_USER.username,
        role: TEST_USER.role,
      });

      // Verify bcrypt was called with password and salt rounds
      expect(mockBcryptHash).toHaveBeenCalledWith('securepassword', 12);

      // Verify refresh cookie was set
      const setCookieHeader = response.headers['set-cookie'];
      expect(setCookieHeader).toBeDefined();
      const cookieStr = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
      expect(cookieStr).toContain('kb_refresh=mock-refresh-token');
      expect(cookieStr).toContain('HttpOnly');
    });

    it('should return 409 when username is already taken', async () => {
      mockBcryptHash.mockResolvedValue('hashed-password');
      // Simulate PostgreSQL unique constraint violation (code 23505)
      const duplicateError = new Error('duplicate key value violates unique constraint') as Error & { code: string };
      duplicateError.code = '23505';
      mockQuery.mockRejectedValueOnce(duplicateError);

      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { username: 'existinguser', password: 'securepassword' },
      });

      expect(response.statusCode).toBe(409);
      const body = JSON.parse(response.body);
      expect(body.error).toContain('Username already taken');
    });

    it('should return 400 when username is too short', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { username: 'ab', password: 'securepassword' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should return 400 when password is too short', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { username: 'testuser', password: 'short' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should return 400 when username or password is missing', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {},
      });

      expect(response.statusCode).toBe(400);
    });
  });

  // ==========================================================================
  // POST /login
  // ==========================================================================

  describe('POST /api/auth/login', () => {
    it('should return 200 with accessToken and user and set refresh cookie', async () => {
      // SELECT user by username
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: TEST_USER.id,
          username: TEST_USER.username,
          password_hash: TEST_USER.password_hash,
          role: TEST_USER.role,
        }],
      });
      mockBcryptCompare.mockResolvedValue(true);

      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'testuser', password: 'securepassword' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.accessToken).toBe('mock-access-token');
      expect(body.user).toEqual({
        id: TEST_USER.id,
        username: TEST_USER.username,
        role: TEST_USER.role,
      });

      // Verify refresh cookie was set
      const setCookieHeader = response.headers['set-cookie'];
      expect(setCookieHeader).toBeDefined();
      const cookieStr = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
      expect(cookieStr).toContain('kb_refresh=mock-refresh-token');
      expect(cookieStr).toContain('HttpOnly');

      // Verify bcrypt.compare was called
      expect(mockBcryptCompare).toHaveBeenCalledWith('securepassword', TEST_USER.password_hash);
    });

    it('should return 401 when user is not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'nonexistent', password: 'somepassword' },
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.error).toContain('Invalid username or password');
    });

    it('should return 401 when password is wrong', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: TEST_USER.id,
          username: TEST_USER.username,
          password_hash: TEST_USER.password_hash,
          role: TEST_USER.role,
        }],
      });
      mockBcryptCompare.mockResolvedValue(false);

      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'testuser', password: 'wrongpassword' },
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.error).toContain('Invalid username or password');
    });
  });

  // ==========================================================================
  // POST /refresh
  // ==========================================================================

  describe('POST /api/auth/refresh', () => {
    it('should rotate tokens and return a new accessToken', async () => {
      mockVerifyRefreshToken.mockResolvedValue({
        sub: TEST_USER.id,
        username: TEST_USER.username,
        role: TEST_USER.role,
        jti: 'old-jti',
        family: 'token-family-1',
      });
      // SELECT user by id
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: TEST_USER.id, username: TEST_USER.username, role: TEST_USER.role }],
      });
      mockRevokeToken.mockResolvedValue(undefined);
      mockGenerateAccessToken.mockResolvedValue('new-access-token');
      mockGenerateRefreshToken.mockResolvedValue({ token: 'new-refresh-token', jti: 'new-jti' });

      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/refresh',
        cookies: { kb_refresh: 'valid-refresh-token' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.accessToken).toBe('new-access-token');
      expect(body.user).toEqual({
        id: TEST_USER.id,
        username: TEST_USER.username,
        role: TEST_USER.role,
      });

      // Verify old token was revoked
      expect(mockRevokeToken).toHaveBeenCalledWith('old-jti');

      // Verify new refresh cookie was set
      const setCookieHeader = response.headers['set-cookie'];
      expect(setCookieHeader).toBeDefined();
      const cookieStr = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
      expect(cookieStr).toContain('kb_refresh=new-refresh-token');

      // Verify family was passed for rotation tracking
      expect(mockGenerateRefreshToken).toHaveBeenCalledWith(
        expect.objectContaining({ sub: TEST_USER.id }),
        'token-family-1',
      );
    });

    it('should return 401 when no refresh cookie is present', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/refresh',
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.error).toContain('No refresh token');
    });

    it('should return 401 when refresh token is invalid or expired', async () => {
      mockVerifyRefreshToken.mockRejectedValue(new Error('Token expired'));

      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/refresh',
        cookies: { kb_refresh: 'expired-token' },
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.error).toContain('Invalid refresh token');
    });

    it('should return 401 when user no longer exists', async () => {
      mockVerifyRefreshToken.mockResolvedValue({
        sub: 'deleted-user-id',
        username: 'deleted',
        role: 'user',
        jti: 'some-jti',
        family: 'some-family',
      });
      // User lookup returns empty
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/refresh',
        cookies: { kb_refresh: 'valid-token-deleted-user' },
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.error).toContain('Invalid refresh token');
    });
  });

  // ==========================================================================
  // POST /logout
  // ==========================================================================

  describe('POST /api/auth/logout', () => {
    it('should clear the refresh cookie and return a message when bearer token is valid', async () => {
      mockVerifyToken.mockResolvedValue({ sub: TEST_USER.id });
      mockRevokeAllUserTokens.mockResolvedValue(undefined);

      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { authorization: 'Bearer valid-access-token' },
        cookies: { kb_refresh: 'some-refresh-token' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.message).toBe('Logged out');

      // Verify all user tokens were revoked
      expect(mockRevokeAllUserTokens).toHaveBeenCalledWith(TEST_USER.id);

      // Verify refresh cookie was cleared
      const setCookieHeader = response.headers['set-cookie'];
      expect(setCookieHeader).toBeDefined();
      const cookieStr = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
      expect(cookieStr).toContain('kb_refresh=');
    });

    it('should fall back to refresh cookie when bearer token is invalid', async () => {
      // Bearer token verification fails
      mockVerifyToken.mockRejectedValue(new Error('Token expired'));
      // Refresh cookie succeeds
      mockVerifyRefreshToken.mockResolvedValue({ sub: TEST_USER.id, jti: 'refresh-jti' });
      mockRevokeToken.mockResolvedValue(undefined);
      mockRevokeAllUserTokens.mockResolvedValue(undefined);

      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { authorization: 'Bearer expired-access-token' },
        cookies: { kb_refresh: 'valid-refresh-token' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.message).toBe('Logged out');

      // Verify specific refresh JTI was revoked
      expect(mockRevokeToken).toHaveBeenCalledWith('refresh-jti');
      // Verify all user tokens were revoked
      expect(mockRevokeAllUserTokens).toHaveBeenCalledWith(TEST_USER.id);
    });

    it('should succeed gracefully even when no valid token is available', async () => {
      // Both bearer and refresh cookie fail
      mockVerifyToken.mockRejectedValue(new Error('Invalid'));
      mockVerifyRefreshToken.mockRejectedValue(new Error('Invalid'));

      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.message).toBe('Logged out');

      // No tokens to revoke — should NOT have been called
      expect(mockRevokeAllUserTokens).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // POST /cleanup-tokens
  // ==========================================================================

  describe('POST /api/auth/cleanup-tokens', () => {
    it('should return the deleted token count for admin users', async () => {
      mockCleanupExpiredTokens.mockResolvedValue(42);

      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/cleanup-tokens',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.message).toBe('Cleaned up 42 expired tokens');
      expect(mockCleanupExpiredTokens).toHaveBeenCalled();
    });
  });
});

// =============================================================================
// Non-admin access guard for cleanup-tokens
// =============================================================================

describe('Auth routes - non-admin access guard', () => {
  let nonAdminApp: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    nonAdminApp = Fastify({ logger: false });
    await nonAdminApp.register(sensible);
    await nonAdminApp.register(cookie);

    nonAdminApp.setErrorHandler((error, _request, reply) => {
      reply.status(error.statusCode ?? 500).send({
        error: error.message,
        statusCode: error.statusCode ?? 500,
      });
    });

    // Simulate non-admin: authenticate passes, requireAdmin rejects
    nonAdminApp.decorate('authenticate', async (request: { userId: string; username: string; userRole: string }) => {
      request.userId = 'regular-user-id';
      request.username = 'regular';
      request.userRole = 'user';
    });
    nonAdminApp.decorate(
      'requireAdmin',
      async (
        request: { userId: string; username: string; userRole: string },
        reply: { code: (n: number) => { send: (body: unknown) => void } },
      ) => {
        request.userId = 'regular-user-id';
        request.username = 'regular';
        request.userRole = 'user';
        reply.code(403).send({ error: 'Admin access required', statusCode: 403 });
      },
    );

    await nonAdminApp.register(authRoutes, { prefix: '/api/auth' });
    await nonAdminApp.ready();
  });

  afterAll(async () => {
    await nonAdminApp.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should reject non-admin users on POST /api/auth/cleanup-tokens with 403', async () => {
    const response = await nonAdminApp.inject({
      method: 'POST',
      url: '/api/auth/cleanup-tokens',
    });

    expect(response.statusCode).toBe(403);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('Admin access required');
  });
});
