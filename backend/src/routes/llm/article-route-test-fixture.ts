import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { createClient, type RedisClientType } from 'redis';
import { query } from '../../core/db/postgres.js';
import { setupTestDb, truncateAllTables, teardownTestDb } from '../../test-db-helper.js';
import { setRedisClient } from '../../core/services/redis-cache.js';
import { bumpProviderCacheVersion } from '../../domains/llm/services/cache-bus.js';

/** Real persistence/resolution/cache/transport. Only the outbound HTTP peer is synthetic. */
export class ArticleRouteFixture {
  app!: FastifyInstance;
  redis!: RedisClientType;
  server!: Server;
  baseUrl = '';
  userId = '';
  pageId = '';
  providerId = '';
  permitted = true;
  output = 'Improved text';
  requests: Array<{ model: string; messages: Array<{ role: string; content: string }> }> = [];

  async start(register: (app: FastifyInstance) => Promise<void>) {
    await setupTestDb();
    this.redis = createClient({ url: process.env.REDIS_URL });
    await this.redis.connect();
    setRedisClient(this.redis);
    this.server = createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        this.requests.push(JSON.parse(raw));
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: this.output } }] })}\n\ndata: [DONE]\n\n`);
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`;
    this.app = Fastify();
    await this.app.register(sensible);
    this.app.decorate('redis', this.redis);
    this.app.decorate('authenticate', async (request) => {
      request.userId = this.userId;
      request.userCan = async () => this.permitted;
    });
    await this.app.register(register, { prefix: '/api' });
  }

  async reset(usecase = 'chat') {
    await truncateAllTables();
    await this.redis.flushDb();
    this.requests.length = 0;
    this.permitted = true;
    this.output = 'Improved text';
    this.userId = (await query<{ id: string }>("INSERT INTO users (username, password_hash, role) VALUES ('article-reader', 'x', 'user') RETURNING id")).rows[0]!.id;
    this.pageId = (await query<{ id: number }>(`INSERT INTO pages (title, source, visibility, created_by_user_id, owner_id, body_text, confluence_id)
      VALUES ('Article', 'standalone', 'private', $1, $1, 'Original text', 'conf-123') RETURNING id`, [this.userId])).rows[0]!.id.toString();
    this.providerId = (await query<{ id: string }>(`INSERT INTO llm_providers (name, base_url, auth_type, default_model, is_default)
      VALUES ('Article provider', $1, 'none', 'm', TRUE) RETURNING id`, [this.baseUrl])).rows[0]!.id;
    await query('INSERT INTO llm_usecase_assignments (usecase, provider_id, model) VALUES ($1, $2, $3)', [usecase, this.providerId, 'm']);
    bumpProviderCacheVersion();
  }

  async post(route: string, payload: Record<string, unknown>) {
    const response = await this.app.inject({ method: 'POST', url: `/api/llm/${route}`, payload });
    // Hijacked SSE ends before the handler's audit/cache/slot finally blocks.
    // Observe their real terminal counter, rather than race the next test reset.
    const deadline = Date.now() + 5_000;
    while (Number(await this.redis.get(`llm:streams:${this.userId}`)) > 0) {
      if (Date.now() >= deadline) throw new Error('Article stream did not settle');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return response;
  }

  async close() {
    await this.app.close();
    setRedisClient(null);
    await this.redis.quit();
    await new Promise<void>((resolve) => { this.server.close(() => resolve()); this.server.closeAllConnections(); });
    await teardownTestDb();
  }
}

export function sseEvents(body: string): Array<Record<string, unknown>> {
  return body.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
}
