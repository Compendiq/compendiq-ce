import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';

// Mock undici request
const mockUndiciRequest = vi.fn();
vi.mock('undici', () => ({
  request: (...args: unknown[]) => mockUndiciRequest(...args),
}));

// Mock fs for CA bundle loading
vi.mock('fs', () => ({
  readFileSync: vi.fn().mockImplementation(() => {
    throw new Error('no file');
  }),
}));

// Mock external dependencies
vi.mock('../db/postgres.js', () => ({
  query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  getPool: vi.fn().mockReturnValue({}),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

vi.mock('../utils/crypto.js', () => ({
  encryptPat: vi.fn().mockReturnValue('encrypted-pat'),
}));

vi.mock('../services/audit-service.js', () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { settingsRoutes } from './settings.js';

describe('Settings routes – test-confluence', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(sensible);

    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof ZodError) {
        reply.status(400).send({
          error: 'ValidationError',
          message: error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
          statusCode: 400,
        });
        return;
      }
      reply.status(error.statusCode ?? 500).send({ error: error.message, statusCode: error.statusCode ?? 500 });
    });

    // Mock auth decorator
    app.decorate('authenticate', async (request: { userId: string; username: string; userRole: string }) => {
      request.userId = 'test-user-id';
      request.username = 'testuser';
      request.userRole = 'user';
    });

    await app.register(settingsRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return success when Confluence responds OK', async () => {
    mockUndiciRequest.mockResolvedValue({
      statusCode: 200,
      body: { dump: vi.fn().mockResolvedValue(undefined) },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/settings/test-confluence',
      payload: { url: 'https://confluence.example.com', pat: 'test-pat' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    expect(body.message).toBe('Connection successful');

    // Verify undici was called with correct URL and auth header
    expect(mockUndiciRequest).toHaveBeenCalledWith(
      'https://confluence.example.com/rest/api/space?limit=1',
      expect.objectContaining({
        method: 'GET',
        headers: { Authorization: 'Bearer test-pat' },
      }),
    );
  });

  it('should return failure with HTTP status on non-2xx response', async () => {
    mockUndiciRequest.mockResolvedValue({
      statusCode: 401,
      body: { dump: vi.fn().mockResolvedValue(undefined) },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/settings/test-confluence',
      payload: { url: 'https://confluence.example.com', pat: 'bad-pat' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(false);
    expect(body.message).toBe('HTTP 401');
  });

  it('should return detailed error message including cause', async () => {
    const fetchError = new TypeError('fetch failed');
    (fetchError as Error & { cause: Error }).cause = new Error('unable to verify the first certificate');
    mockUndiciRequest.mockRejectedValue(fetchError);

    const response = await app.inject({
      method: 'POST',
      url: '/api/settings/test-confluence',
      payload: { url: 'https://confluence.example.com', pat: 'test-pat' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(false);
    expect(body.message).toContain('fetch failed');
    expect(body.message).toContain('unable to verify the first certificate');
  });

  it('should return error message without duplicate when cause matches message', async () => {
    mockUndiciRequest.mockRejectedValue(new Error('Connection refused'));

    const response = await app.inject({
      method: 'POST',
      url: '/api/settings/test-confluence',
      payload: { url: 'https://confluence.example.com', pat: 'test-pat' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(false);
    expect(body.message).toBe('Connection refused');
  });

  it('should block SSRF attempts to private networks', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/settings/test-confluence',
      payload: { url: 'https://192.168.1.1', pat: 'test-pat' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(false);
    expect(body.message).toContain('URL blocked');
    expect(mockUndiciRequest).not.toHaveBeenCalled();
  });

  it('should reject invalid payload (missing url)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/settings/test-confluence',
      payload: { pat: 'test-pat' },
    });

    expect(response.statusCode).toBe(400);
  });
});
