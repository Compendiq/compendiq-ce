import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { createClient, type RedisClientType } from 'redis';
import { isDbAvailable, setupTestDb, truncateAllTables, teardownTestDb } from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { query } from '../../core/db/postgres.js';
import { setRedisClient } from '../../core/services/redis-cache.js';
import { bumpProviderCacheVersion } from '../../domains/llm/services/cache-bus.js';
import { getSystemPrompt } from '../../domains/llm/services/prompts.js';
import { llmQualityRoutes } from './llm-quality.js';

const available = await isDbAvailable() && await isRedisAvailable();
describe.skipIf(!available)('POST /api/llm/analyze-quality — real article and provider', () => {
  let app: ReturnType<typeof Fastify>;
  let server: Server;
  let redis: RedisClientType;
  let baseUrl: string;
  let userId: string;
  let pageId: string;
  let permitted = true;
  const requests: Array<{ model: string; messages: Array<{ content: string }> }> = [];
  const content = '<p>This is a test article with some content.</p>';
  const send = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/llm/analyze-quality', payload });

  beforeAll(async () => {
    await setupTestDb();
    redis = createClient({ url: process.env.REDIS_URL });
    await redis.connect();
    setRedisClient(redis);
    server = createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        requests.push(JSON.parse(raw));
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: '## Overall Quality Score: 75/100\n## Completeness: 80/100\n' } }] })}\n\ndata: [DONE]\n\n`);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    app = Fastify();
    await app.register(sensible);
    app.decorate('redis', redis);
    app.decorate('authenticate', async (request) => {
      request.userId = userId;
      request.userCan = async () => permitted;
    });
    await app.register(llmQualityRoutes, { prefix: '/api' });
  });
  beforeEach(async () => {
    await truncateAllTables();
    await redis.flushDb();
    requests.length = 0;
    permitted = true;
    userId = (await query<{ id: string }>("INSERT INTO users (username, password_hash, role) VALUES ('quality-reader', 'x', 'user') RETURNING id")).rows[0]!.id;
    pageId = (await query<{ id: number }>(`INSERT INTO pages (title, source, visibility, created_by_user_id, owner_id, body_text)
      VALUES ('Article', 'standalone', 'private', $1, $1, $2) RETURNING id`, [userId, content])).rows[0]!.id.toString();
    const providerId = (await query<{ id: string }>(`INSERT INTO llm_providers (name, base_url, auth_type, default_model)
      VALUES ('Quality', $1, 'none', 'm') RETURNING id`, [baseUrl])).rows[0]!.id;
    await query("INSERT INTO llm_usecase_assignments (usecase, provider_id, model) VALUES ('quality', $1, 'm')", [providerId]);
    bumpProviderCacheVersion();
  });
  afterAll(async () => {
    await app.close();
    setRedisClient(null);
    await redis.quit();
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    await teardownTestDb();
  });
  it('rejects missing content without dispatch', async () => {
    expect((await send({ pageId, model: 'llama3' })).statusCode).toBeGreaterThanOrEqual(400);
    expect(requests).toHaveLength(0);
  });
  it('resolves an omitted model server-side', async () => {
    const response = await send({ pageId, content });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/event-stream');
    expect(requests[0]!.model).toBe('m');
  });
  it('rejects oversized content', async () => {
    const response = await send({ pageId, content: 'x'.repeat(100_001), model: 'llama3' });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain('Content too large');
    expect(requests).toHaveLength(0);
  });
  it('streams quality SSE and ignores a caller model override', async () => {
    const response = await send({ pageId, content, model: 'llama3' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/event-stream');
    const chunks = response.body.split('\n').filter((line) => line.startsWith('data: '));
    expect(JSON.parse(chunks[0]!.slice(6)).content).toContain('Overall Quality Score');
    expect(requests[0]!.model).toBe('m');
  });
  it('uses the analyze_quality system prompt', async () => {
    expect((await send({ pageId, content })).statusCode).toBe(200);
    expect(requests[0]!.messages[0]!.content).toBe(getSystemPrompt('analyze_quality'));
  });
  it('replays a cached response without a second provider call', async () => {
    await send({ pageId, content });
    const response = await send({ pageId, content });
    expect(response.statusCode).toBe(200);
    const chunks = response.body.split('\n').filter((line) => line.startsWith('data: '));
    expect(JSON.parse(chunks[0]!.slice(6))).toMatchObject({ cached: true });
    expect(response.body).toContain('Overall Quality Score');
    expect(requests).toHaveLength(1);
  });
  it('requires an existing readable article; omitted and nonexistent IDs send no bytes', async () => {
    expect((await send({ content })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await send({ pageId: 'page-123', content })).statusCode).toBe(404);
    expect(requests).toHaveLength(0);
    expect((await send({ pageId, content })).statusCode).toBe(200);
  });
  it('refuses missing inference permission', async () => {
    permitted = false;
    const response = await send({ pageId, content });
    expect(response.statusCode).toBe(403);
    expect(response.json().message).toContain('Permission "llm:query" required');
    expect(requests).toHaveLength(0);
  });
});
