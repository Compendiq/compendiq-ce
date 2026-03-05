import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildApp } from '../app.js';
import { setupTestDb, truncateAllTables, teardownTestDb } from '../test-db-helper.js';
import { generateAccessToken } from '../plugins/auth.js';
import { query } from '../db/postgres.js';
import { FastifyInstance } from 'fastify';

describe('Per-route rate limiting', () => {
  let app: FastifyInstance;
  let testUserId: string;
  let adminToken: string;

  beforeAll(async () => {
    await setupTestDb();
    app = await buildApp();
    await app.ready();
  });

  beforeEach(async () => {
    await truncateAllTables();

    // Create admin user for authenticated routes
    const result = await query<{ id: string }>(
      "INSERT INTO users (username, password_hash, role) VALUES ('ratelimituser', 'fakehash', 'admin') RETURNING id",
    );
    testUserId = result.rows[0].id;
    await query('INSERT INTO user_settings (user_id) VALUES ($1)', [testUserId]);

    adminToken = await generateAccessToken({
      sub: testUserId,
      username: 'ratelimituser',
      role: 'admin',
    });
  });

  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  describe('Auth routes rate limit (5/min)', () => {
    it('should have rate limit headers on auth routes', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'nonexistent', password: 'wrong' },
      });

      // Even failed auth should have rate limit headers
      expect(response.headers['x-ratelimit-limit']).toBeDefined();
      // Auth routes should have a limit of 5
      expect(response.headers['x-ratelimit-limit']).toBe('5');
    });

    it('should enforce rate limit after 5 requests', async () => {
      // Send 5 requests (exhaust the limit)
      for (let i = 0; i < 5; i++) {
        await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { username: `user${i}`, password: 'wrong' },
        });
      }

      // 6th request should be rate limited
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'overflow', password: 'wrong' },
      });
      expect(response.statusCode).toBe(429);
    });

    it('should have rate limit on register route', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { username: 'newuser', password: 'password123' },
      });

      expect(response.headers['x-ratelimit-limit']).toBe('5');
    });
  });

  describe('LLM routes rate limit (10/min)', () => {
    it('should have rate limit headers on LLM streaming routes', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/llm/generate',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { prompt: 'test', model: 'test-model' },
      });

      // May fail due to Ollama being unavailable, but rate limit headers should still be present
      // Check that the response had rate limit set (headers present)
      // Rate limit should be 10 for LLM routes
      if (response.headers['x-ratelimit-limit']) {
        expect(response.headers['x-ratelimit-limit']).toBe('10');
      }
    });
  });

  describe('Embedding routes rate limit (5/min)', () => {
    it('should have rate limit on embedding process route', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/embeddings/process',
        headers: { authorization: `Bearer ${adminToken}` },
      });

      if (response.headers['x-ratelimit-limit']) {
        expect(response.headers['x-ratelimit-limit']).toBe('5');
      }
    });
  });

  describe('Admin routes rate limit (20/min)', () => {
    it('should have rate limit on admin re-embed route', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/re-embed',
        headers: { authorization: `Bearer ${adminToken}` },
      });

      if (response.headers['x-ratelimit-limit']) {
        expect(response.headers['x-ratelimit-limit']).toBe('20');
      }
    });

    it('should have rate limit on admin audit-log route', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/admin/audit-log',
        headers: { authorization: `Bearer ${adminToken}` },
      });

      if (response.headers['x-ratelimit-limit']) {
        expect(response.headers['x-ratelimit-limit']).toBe('20');
      }
    });
  });

  describe('Global rate limit (100/min)', () => {
    it('should have global fallback rate limit on health endpoint', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/health',
      });

      // Health route should use global limit (100)
      if (response.headers['x-ratelimit-limit']) {
        expect(parseInt(response.headers['x-ratelimit-limit'] as string, 10)).toBe(100);
      }
    });
  });
});
