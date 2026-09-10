import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { createClient, type RedisClientType } from 'redis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { isDbAvailable, setupTestDb, truncateAllTables } from '../../test-db-helper.js';
import { ZodError } from 'zod';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { query } from '../../core/db/postgres.js';
import { setRedisClient } from '../../core/services/redis-cache.js';
import { defaultLlmAuditWriter } from '../../domains/llm/services/llm-audit-default-writer.js';
import { setLlmAuditHook } from '../../domains/llm/services/llm-audit-hook.js';
import { llmSummarizeRoutes } from './llm-summarize.js';

const available = await isDbAvailable() && await isRedisAvailable();

describe.skipIf(!available)('summarize — real provider and persistence boundaries', () => {
  let app: FastifyInstance;
  let provider: Server;
  let redis: RedisClientType;
  let baseUrl: string;
  let userId: string;
  let authenticated = true;
  let permitted = true;
  const requests: Array<{ model: string; messages: Array<{ content: string }> }> = [];
  const writes: Promise<void>[] = [];

  beforeAll(async () => {
    await setupTestDb();
    redis = createClient({ url: process.env.REDIS_URL });
    await redis.connect();
    setRedisClient(redis);
    provider = createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        requests.push(JSON.parse(raw));
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'A grounded summary.' } }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 31, completion_tokens: 17 } })}\n\n`);
        response.end('data: [DONE]\n\n');
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`;
    app = Fastify();
    await app.register(sensible);
    app.decorate('redis', redis);
    app.decorate('authenticate', async () => {});
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof ZodError) return reply.code(400).send({ error: 'Validation failed' });
      return reply.send(error);
    });
    vi.spyOn(app, 'authenticate').mockImplementation(async (request, reply) => {
      if (!authenticated) return reply.code(401).send({ error: 'Unauthorized' });
      request.userId = userId;
      request.userCan = async () => permitted;
    });
    await app.register(llmSummarizeRoutes, { prefix: '/api' });
    setLlmAuditHook((entry) => {
      const write = defaultLlmAuditWriter(entry);
      writes.push(write);
      return write;
    });
  }, 30_000);

  beforeEach(async () => {
    await Promise.all(writes);
    writes.length = 0;
    requests.length = 0;
    authenticated = true;
    permitted = true;
    await truncateAllTables();
    await redis.flushDb();
    userId = (await query<{ id: string }>(`INSERT INTO users (username, email, password_hash, role)
      VALUES ('summary-reader', 'summary@example.com', 'hash', 'user') RETURNING id`)).rows[0]!.id;
    const providerId = (await query<{ id: string }>(`INSERT INTO llm_providers
      (name, base_url, auth_type, default_model, is_default)
      VALUES ('Summary fixture', $1, 'none', 'default-chat', TRUE) RETURNING id`, [baseUrl])).rows[0]!.id;
    await query(`INSERT INTO llm_usecase_assignments (usecase, provider_id, model)
      VALUES ('summary', $1, 'assigned-summary')`, [providerId]);
  });

  afterAll(async () => {
    await Promise.all(writes);
    setLlmAuditHook(defaultLlmAuditWriter);
    await app.close();
    await redis.quit();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    vi.restoreAllMocks();
  });

  it('streams from the assigned model and persists actual usage once across a replay', async () => {
    const payload = { content: '<p>The launch is on Tuesday.</p>' };
    const response = await app.inject({ method: 'POST', url: '/api/llm/summarize', payload });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toContain('A grounded summary.');
    expect(requests[0]!.model).toBe('assigned-summary');
    await Promise.all(writes);
    const replay = await app.inject({ method: 'POST', url: '/api/llm/summarize', payload });
    expect(replay.body).toContain('A grounded summary.');
    await Promise.all(writes);
    expect(requests).toHaveLength(1);
    expect((await query('SELECT action, input_tokens, output_tokens FROM llm_audit_log WHERE user_id = $1', [userId])).rows)
      .toEqual([{ action: 'summarize', input_tokens: 31, output_tokens: 17 }]);
  });

  it('cannot replace the administrator assignment with a caller-supplied model', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/llm/summarize',
      payload: { content: '<p>Caller-controlled content.</p>', model: 'unauthorized-model' } });
    expect(response.body).toContain('A grounded summary.');
    expect(requests[0]!.model).toBe('assigned-summary');
  });

  it('rejects unauthenticated requests before provider dispatch', async () => {
    authenticated = false;
    const response = await app.inject({ method: 'POST', url: '/api/llm/summarize', payload: { content: 'Private content' } });
    expect(response.statusCode).toBe(401);
    expect(requests).toEqual([]);
  });

  it('rejects readers without inference permission before provider dispatch', async () => {
    permitted = false;
    const response = await app.inject({ method: 'POST', url: '/api/llm/summarize', payload: { content: 'Private content' } });
    expect(response.statusCode).toBe(403);
    expect(requests).toEqual([]);
  });

  it('refuses missing content and content past the route limit without spending inference', async () => {
    const missing = await app.inject({ method: 'POST', url: '/api/llm/summarize', payload: {} });
    const oversized = await app.inject({ method: 'POST', url: '/api/llm/summarize', payload: { content: 'x'.repeat(100_001) } });
    expect(missing.statusCode).toBe(400);
    expect(oversized.statusCode).toBe(400);
    expect(requests).toEqual([]);
  });
});
