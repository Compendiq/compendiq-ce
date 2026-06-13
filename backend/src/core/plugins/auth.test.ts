import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as jose from 'jose';

/**
 * Tests for access token expiry configuration.
 *
 * These tests verify that generateAccessToken uses the ACCESS_TOKEN_EXPIRY
 * env var (default: '1h') instead of a hardcoded value.
 *
 * We re-import the module for each env-var scenario so the top-level
 * `const ACCESS_TOKEN_EXPIRY` is re-evaluated.
 */

const JWT_SECRET = 'a-test-secret-that-is-at-least-32-chars-long!!';

// Mock the logger so the 24h-clamp tests can assert the startup warning.
// vi.resetModules() in afterEach re-runs this factory on the next import, so
// each test sees a fresh mock instance — fetch it via dynamic import AFTER
// importing auth.js to get the same instance auth.js wrote to.
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

describe('generateAccessToken expiry', () => {
  const payload = { sub: 'user-1', username: 'testuser', role: 'user' as const };

  beforeEach(() => {
    process.env.JWT_SECRET = JWT_SECRET;
  });

  afterEach(() => {
    delete process.env.ACCESS_TOKEN_EXPIRY;
    vi.resetModules();
  });

  it('should default to 1h expiry when ACCESS_TOKEN_EXPIRY is not set', async () => {
    delete process.env.ACCESS_TOKEN_EXPIRY;
    const { generateAccessToken } = await import('./auth.js');

    const now = Math.floor(Date.now() / 1000);
    const token = await generateAccessToken(payload);
    const secret = new TextEncoder().encode(JWT_SECRET);
    const { payload: decoded } = await jose.jwtVerify(token, secret, { issuer: 'compendiq' });

    // exp should be approximately 1 hour (3600s) from now
    const expiry = decoded.exp as number;
    const diff = expiry - now;
    // Allow 5s tolerance for test execution time
    expect(diff).toBeGreaterThanOrEqual(3595);
    expect(diff).toBeLessThanOrEqual(3605);
  });

  it('should respect ACCESS_TOKEN_EXPIRY env var when set to 30m', async () => {
    process.env.ACCESS_TOKEN_EXPIRY = '30m';
    const { generateAccessToken } = await import('./auth.js');

    const now = Math.floor(Date.now() / 1000);
    const token = await generateAccessToken(payload);
    const secret = new TextEncoder().encode(JWT_SECRET);
    const { payload: decoded } = await jose.jwtVerify(token, secret, { issuer: 'compendiq' });

    // exp should be approximately 30 minutes (1800s) from now
    const expiry = decoded.exp as number;
    const diff = expiry - now;
    expect(diff).toBeGreaterThanOrEqual(1795);
    expect(diff).toBeLessThanOrEqual(1805);
  });

  it('should respect ACCESS_TOKEN_EXPIRY set to 2h', async () => {
    process.env.ACCESS_TOKEN_EXPIRY = '2h';
    const { generateAccessToken } = await import('./auth.js');

    const now = Math.floor(Date.now() / 1000);
    const token = await generateAccessToken(payload);
    const secret = new TextEncoder().encode(JWT_SECRET);
    const { payload: decoded } = await jose.jwtVerify(token, secret, { issuer: 'compendiq' });

    const expiry = decoded.exp as number;
    const diff = expiry - now;
    expect(diff).toBeGreaterThanOrEqual(7195);
    expect(diff).toBeLessThanOrEqual(7205);
  });

  it('should throw at import time when ACCESS_TOKEN_EXPIRY has an invalid format', async () => {
    process.env.ACCESS_TOKEN_EXPIRY = 'banana';
    await expect(() => import('./auth.js')).rejects.toThrow(
      'Invalid ACCESS_TOKEN_EXPIRY format: "banana"',
    );
  });

  // #737: ACCESS_TOKEN_EXPIRY is the upper bound on how long a revoked /
  // demoted account could keep API access if every faster invalidation
  // layer failed. Values above 24h are CLAMPED to 24h with a loud startup
  // warning (#756 review) — previously-valid configs like '48h' or '7d'
  // must not turn into a hard boot failure on unattended upgrade. Only an
  // invalid FORMAT still fails startup.
  it('should accept the 24h boundary value without warning', async () => {
    process.env.ACCESS_TOKEN_EXPIRY = '24h';
    const { generateAccessToken } = await import('./auth.js');
    const { logger } = await import('../utils/logger.js');

    const now = Math.floor(Date.now() / 1000);
    const token = await generateAccessToken(payload);
    const secret = new TextEncoder().encode(JWT_SECRET);
    const { payload: decoded } = await jose.jwtVerify(token, secret, { issuer: 'compendiq' });

    const diff = (decoded.exp as number) - now;
    expect(diff).toBeGreaterThanOrEqual(86395);
    expect(diff).toBeLessThanOrEqual(86405);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('should clamp ACCESS_TOKEN_EXPIRY above 24h (999d) to 24h and log a warning instead of failing boot', async () => {
    process.env.ACCESS_TOKEN_EXPIRY = '999d';
    const { generateAccessToken } = await import('./auth.js');
    const { logger } = await import('../utils/logger.js');

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ configured: '999d', effective: '24h' }),
      expect.stringContaining('24h'),
    );

    const now = Math.floor(Date.now() / 1000);
    const token = await generateAccessToken(payload);
    const secret = new TextEncoder().encode(JWT_SECRET);
    const { payload: decoded } = await jose.jwtVerify(token, secret, { issuer: 'compendiq' });

    // Token is issued with the clamped 24h lifetime, not the configured 999d.
    const diff = (decoded.exp as number) - now;
    expect(diff).toBeGreaterThanOrEqual(86395);
    expect(diff).toBeLessThanOrEqual(86405);
  });

  it('should clamp ACCESS_TOKEN_EXPIRY above 24h (25h) to 24h and log a warning instead of failing boot', async () => {
    process.env.ACCESS_TOKEN_EXPIRY = '25h';
    const { generateAccessToken } = await import('./auth.js');
    const { logger } = await import('../utils/logger.js');

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ configured: '25h', effective: '24h' }),
      expect.stringContaining('24h'),
    );

    const now = Math.floor(Date.now() / 1000);
    const token = await generateAccessToken(payload);
    const secret = new TextEncoder().encode(JWT_SECRET);
    const { payload: decoded } = await jose.jwtVerify(token, secret, { issuer: 'compendiq' });

    const diff = (decoded.exp as number) - now;
    expect(diff).toBeGreaterThanOrEqual(86395);
    expect(diff).toBeLessThanOrEqual(86405);
  });
});
