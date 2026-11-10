import { describe, it, expect } from 'vitest';
import { parsePort, parseCacheTtl, parseSessionTtlMs, DEFAULT_CACHE_TTL, DEFAULT_SESSION_TTL_MS } from './config.js';

describe('parsePort', () => {
  it('parses a valid port', () => {
    expect(parsePort('3100')).toBe(3100);
    expect(parsePort('1')).toBe(1);
    expect(parsePort('65535')).toBe(65535);
  });

  it('uses the fallback when unset', () => {
    expect(parsePort(undefined)).toBe(3100);
    expect(parsePort(undefined, '8080')).toBe(8080);
  });

  it('returns null for a non-numeric value (would NaN -> random port otherwise)', () => {
    expect(parsePort('not-a-number')).toBe(null);
    expect(parsePort('')).toBe(null);
    expect(parsePort('   ')).toBe(null);
    expect(parsePort('abc')).toBe(null);
  });

  it('parseInt leniency: a trailing-garbage value keeps the leading integer', () => {
    // parseInt('3100x', 10) === 3100 — not NaN. Documenting the boundary so it
    // is clear the guard fails fast only on a genuinely non-numeric value.
    expect(parsePort('3100x')).toBe(3100);
  });

  it('returns null for out-of-range ports', () => {
    expect(parsePort('0')).toBe(null);
    expect(parsePort('-1')).toBe(null);
    expect(parsePort('65536')).toBe(null);
    expect(parsePort('99999')).toBe(null);
  });
});

describe('parseCacheTtl', () => {
  it('parses a valid TTL', () => {
    expect(parseCacheTtl('60')).toBe(60);
    expect(parseCacheTtl('7200')).toBe(7200);
  });

  it('falls back to the default when unset', () => {
    expect(parseCacheTtl(undefined)).toBe(DEFAULT_CACHE_TTL);
  });

  it('falls back to the default for non-numeric or non-positive values (no NaN)', () => {
    expect(parseCacheTtl('not-a-number')).toBe(DEFAULT_CACHE_TTL);
    expect(parseCacheTtl('')).toBe(DEFAULT_CACHE_TTL);
    expect(parseCacheTtl('0')).toBe(DEFAULT_CACHE_TTL);
    expect(parseCacheTtl('-5')).toBe(DEFAULT_CACHE_TTL);
  });
});

describe('parseSessionTtlMs', () => {
  it('parses a valid TTL in milliseconds', () => {
    expect(parseSessionTtlMs('1500')).toBe(1500);
    expect(parseSessionTtlMs('3600000')).toBe(3_600_000);
  });

  it('falls back to 30 minutes when unset', () => {
    expect(DEFAULT_SESSION_TTL_MS).toBe(1_800_000);
    expect(parseSessionTtlMs(undefined)).toBe(DEFAULT_SESSION_TTL_MS);
  });

  it('falls back to the default for non-numeric or non-positive values (no NaN)', () => {
    expect(parseSessionTtlMs('not-a-number')).toBe(DEFAULT_SESSION_TTL_MS);
    expect(parseSessionTtlMs('')).toBe(DEFAULT_SESSION_TTL_MS);
    expect(parseSessionTtlMs('0')).toBe(DEFAULT_SESSION_TTL_MS);
    expect(parseSessionTtlMs('-5')).toBe(DEFAULT_SESSION_TTL_MS);
  });
});
