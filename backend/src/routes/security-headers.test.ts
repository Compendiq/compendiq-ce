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

  // The four headers below are owned by the nginx edge
  // (frontend/nginx-security-headers.conf), which is the only surface a client
  // ever reaches (the backend is never host-published). Helmet is configured
  // NOT to emit them so nginx's appending `add_header` cannot produce duplicate
  // or conflicting values on proxied responses (#1053).

  it('should NOT set X-Content-Type-Options (owned by the nginx edge)', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health/live' });
    expect(response.headers['x-content-type-options']).toBeUndefined();
  });

  it('should NOT set X-Frame-Options (owned by the nginx edge)', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health/live' });
    expect(response.headers['x-frame-options']).toBeUndefined();
  });

  it('should NOT set Referrer-Policy (owned by the nginx edge)', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health/live' });
    expect(response.headers['referrer-policy']).toBeUndefined();
  });

  it('should NOT set the deprecated X-XSS-Protection header', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health/live' });
    expect(response.headers['x-xss-protection']).toBeUndefined();
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

  it('should set backend-owned security headers on all routes, not just health', async () => {
    // Try an unauthenticated route that returns 401 - the headers Helmet still
    // owns (COOP/CORP/DNS-prefetch) must be present regardless of status.
    const response = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(response.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(response.headers['x-dns-prefetch-control']).toBe('off');
  });
});
