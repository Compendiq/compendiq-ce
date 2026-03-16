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
    const { payload: decoded } = await jose.jwtVerify(token, secret, { issuer: 'atlasmind' });

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
    const { payload: decoded } = await jose.jwtVerify(token, secret, { issuer: 'atlasmind' });

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
    const { payload: decoded } = await jose.jwtVerify(token, secret, { issuer: 'atlasmind' });

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
});
