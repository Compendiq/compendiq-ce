import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../app.js';
import { setupTestDb, teardownTestDb, isDbAvailable } from '../test-db-helper.js';
import { FastifyInstance } from 'fastify';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('HTTP security headers (@fastify/helmet)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await setupTestDb();
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  it('should set X-Content-Type-Options: nosniff', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health/live' });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('should set X-Frame-Options: SAMEORIGIN', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health/live' });
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
  });

  it('should set X-DNS-Prefetch-Control: off', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health/live' });
    expect(response.headers['x-dns-prefetch-control']).toBe('off');
  });

  it('should set Cross-Origin-Resource-Policy: same-origin', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health/live' });
    expect(response.headers['cross-origin-resource-policy']).toBe('same-origin');
  });

  it('should set Cross-Origin-Opener-Policy: same-origin', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health/live' });
    expect(response.headers['cross-origin-opener-policy']).toBe('same-origin');
  });

  it('should NOT set Content-Security-Policy (CSP handled by nginx)', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health/live' });
    expect(response.headers['content-security-policy']).toBeUndefined();
  });

  it('should set security headers on all routes, not just health', async () => {
    // Try an unauthenticated route that returns 401 - headers should still be present
    const response = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
  });
});
