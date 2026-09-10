import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => {
    const err = new Error('getaddrinfo ENOTFOUND (mocked)') as NodeJS.ErrnoException;
    err.code = 'ENOTFOUND';
    throw err;
  }),
}));

const mockGenerateEmbedding = vi.fn();
vi.mock('../../domains/llm/services/openai-compatible-client.js', () => ({
  generateEmbedding: (...args: unknown[]) => mockGenerateEmbedding(...args),
  streamChat: vi.fn(),
  chat: vi.fn(),
  listModels: vi.fn(),
  checkHealth: vi.fn(),
  invalidateDispatcher: vi.fn(),
}));

const mockGetProviderById = vi.fn();
vi.mock('../../domains/llm/services/llm-provider-service.js', () => ({
  getProviderById: (...args: unknown[]) => mockGetProviderById(...args),
  listProviders: vi.fn(),
  createProvider: vi.fn(),
  updateProvider: vi.fn(),
  deleteProvider: vi.fn(),
  setDefaultProvider: vi.fn(),
}));

vi.mock('../../core/services/rate-limit-service.js', () => ({
  getRateLimits: vi.fn().mockResolvedValue({ admin: { max: 9999 } }),
}));

const mockLoggerWarn = vi.fn();
vi.mock('../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: (...args: unknown[]) => mockLoggerWarn(...args), debug: vi.fn() },
}));

import { llmEmbeddingProbeRoutes } from './llm-embedding-probe.js';
import { LlmHttpError } from '../../domains/llm/services/llm-http-error.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  await app.register(sensible);
  // Stub auth + requireAdmin on the root instance so the route sees them.
  app.decorate('authenticate', async (req: { userId?: string }) => {
    req.userId = 'test-admin';
  });
  app.decorate('requireAdmin', async () => {
    /* allow */
  });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof ZodError) {
      reply.status(400).send({ error: 'ValidationError', statusCode: 400 });
      return;
    }
    reply.status(error.statusCode ?? 500).send({ error: error.message, statusCode: error.statusCode ?? 500 });
  });
  await app.register(llmEmbeddingProbeRoutes, { prefix: '/api' });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

beforeEach(() => {
  mockGenerateEmbedding.mockReset();
  mockGetProviderById.mockReset();
  mockLoggerWarn.mockReset();
});

describe('POST /api/admin/embedding/probe', () => {
  it('returns dimensions equal to the length of the first vector', async () => {
    mockGetProviderById.mockResolvedValue({
      id: 'p1',
      name: 'A',
      baseUrl: 'http://a/v1',
      apiKey: null,
      authType: 'none',
      verifySsl: true,
      defaultModel: 'bge-m3',
    });
    mockGenerateEmbedding.mockResolvedValue([[0.1, 0.2, 0.3]]);

    const r = await app.inject({
      method: 'POST',
      url: '/api/admin/embedding/probe',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ providerId: '11111111-1111-4111-8111-111111111111', model: 'bge-m3' }),
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ dimensions: 3 });
    expect(mockGenerateEmbedding).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'p1', baseUrl: 'http://a/v1' }),
      'bge-m3',
      'probe',
    );
  });

  it('returns 404 when provider is not found', async () => {
    mockGetProviderById.mockResolvedValue(null);
    const r = await app.inject({
      method: 'POST',
      url: '/api/admin/embedding/probe',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ providerId: '11111111-1111-4111-8111-111111111111', model: 'x' }),
    });
    expect(r.statusCode).toBe(404);
  });

  it('returns 400 when providerId is not a uuid', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/admin/embedding/probe',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ providerId: 'not-a-uuid', model: 'x' }),
    });
    expect(r.statusCode).toBe(400);
  });

  it('returns { dimensions: 0, error } when generateEmbedding throws', async () => {
    mockGetProviderById.mockResolvedValue({
      id: 'p1',
      name: 'A',
      baseUrl: 'http://a/v1',
      apiKey: null,
      authType: 'none',
      verifySsl: true,
      defaultModel: 'bge-m3',
    });
    mockGenerateEmbedding.mockRejectedValue(new Error('boom'));
    const r = await app.inject({
      method: 'POST',
      url: '/api/admin/embedding/probe',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ providerId: '11111111-1111-4111-8111-111111111111', model: 'x' }),
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ dimensions: 0, error: 'boom' });
  });

  // #1185: since generateEmbedding now throws LlmHttpError, its `.message` no
  // longer folds in the provider's raw body (see llm-http-error.ts) — the body
  // lives on `.detail` and is logged, not returned. This route is admin-gated
  // so the prior exposure was minor, but the shape should still match the
  // body-free-message pattern #1181 established for chat().
  it('returns a body-free message and logs the detail when generateEmbedding throws LlmHttpError', async () => {
    mockGetProviderById.mockResolvedValue({
      id: 'p1',
      name: 'A',
      baseUrl: 'http://a/v1',
      apiKey: null,
      authType: 'none',
      verifySsl: true,
      defaultModel: 'bge-m3',
    });
    const providerBody = 'internal registry trace: host=10.0.4.12 secretpath=/var/models';
    mockGenerateEmbedding.mockRejectedValue(new LlmHttpError('generateEmbedding', 400, providerBody));

    const r = await app.inject({
      method: 'POST',
      url: '/api/admin/embedding/probe',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ providerId: '11111111-1111-4111-8111-111111111111', model: 'x' }),
    });

    expect(r.statusCode).toBe(200);
    const json = r.json();
    expect(json.dimensions).toBe(0);
    expect(json.error).toBe('generateEmbedding HTTP 400');
    expect(json.error).not.toContain(providerBody);

    // The detail still reaches the server log an admin can go looking for.
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
    const [logPayload] = mockLoggerWarn.mock.calls[0]!;
    expect(logPayload.detail).toBe(providerBody);
    expect(logPayload.status).toBe(400);
  });
});
