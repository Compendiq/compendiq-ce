import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  acquireToken,
  setRateLimit,
  getRateLimit,
  resetRateLimiter,
} from './confluence-rate-limiter.js';

// Mock postgres to avoid DB calls
vi.mock('../../../core/db/postgres.js', () => ({
  query: vi.fn().mockResolvedValue({ rows: [] }),
}));

vi.mock('../../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('confluence-rate-limiter', () => {
  beforeEach(() => {
    resetRateLimiter();
    setRateLimit(60); // Default: 60 RPM
  });

  it('acquires tokens immediately when available', async () => {
    const start = Date.now();
    await acquireToken();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
  });

  it('getRateLimit returns current configuration', () => {
    const info = getRateLimit();
    expect(info.rpm).toBe(60);
    expect(info.availableTokens).toBeGreaterThan(0);
    expect(info.queueDepth).toBe(0);
  });

  it('setRateLimit clamps to valid range', () => {
    setRateLimit(0);
    expect(getRateLimit().rpm).toBe(1);

    setRateLimit(1000);
    expect(getRateLimit().rpm).toBe(600);

    setRateLimit(120);
    expect(getRateLimit().rpm).toBe(120);
  });

  it('exhausts tokens and queues requests', async () => {
    setRateLimit(5); // 5 RPM = very low
    resetRateLimiter();

    // Drain all 5 tokens quickly
    for (let i = 0; i < 5; i++) {
      await acquireToken();
    }

    const info = getRateLimit();
    expect(info.availableTokens).toBeLessThanOrEqual(1);
  });

  it('handles rapid sequential acquisitions', async () => {
    setRateLimit(60);
    resetRateLimiter();

    // 10 rapid acquisitions should succeed immediately
    const promises = Array.from({ length: 10 }, () => acquireToken());
    await Promise.all(promises);
    // All resolved without error
  });

  it('resetRateLimiter restores tokens', async () => {
    // Drain some tokens
    await acquireToken();
    await acquireToken();
    await acquireToken();

    resetRateLimiter();
    const info = getRateLimit();
    expect(info.availableTokens).toBeGreaterThanOrEqual(59);
  });
});
