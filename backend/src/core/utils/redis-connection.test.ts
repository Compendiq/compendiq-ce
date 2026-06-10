import { describe, it, expect, vi, afterEach } from 'vitest';
import { getRedisConnectionOpts } from './redis-connection.js';

describe('getRedisConnectionOpts', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('parses a plain redis:// URL into host/port only', () => {
    const opts = getRedisConnectionOpts('redis://localhost:6379');
    expect(opts).toEqual({
      host: 'localhost',
      port: 6379,
      maxRetriesPerRequest: null,
    });
    expect(opts.tls).toBeUndefined();
    expect(opts.username).toBeUndefined();
    expect(opts.password).toBeUndefined();
    expect(opts.db).toBeUndefined();
  });

  it('maps rediss:// to tls: {} (TLS enabled)', () => {
    const opts = getRedisConnectionOpts('rediss://redis.example.com:6380');
    expect(opts.tls).toEqual({});
    expect(opts.host).toBe('redis.example.com');
    expect(opts.port).toBe(6380);
  });

  it('does NOT set tls for plain redis://', () => {
    const opts = getRedisConnectionOpts('redis://redis.example.com:6379');
    expect(opts.tls).toBeUndefined();
  });

  it('preserves the ACL username', () => {
    const opts = getRedisConnectionOpts(
      'redis://app-user:secret@redis.example.com:6379',
    );
    expect(opts.username).toBe('app-user');
    expect(opts.password).toBe('secret');
  });

  it('supports password-only URLs (redis://:pass@host)', () => {
    const opts = getRedisConnectionOpts('redis://:changeme-redis@localhost:6379');
    expect(opts.password).toBe('changeme-redis');
    expect(opts.username).toBeUndefined();
  });

  it('preserves the /N database index as a number', () => {
    const opts = getRedisConnectionOpts('redis://localhost:6379/2');
    expect(opts.db).toBe(2);
  });

  it('omits db for a bare or trailing-slash path', () => {
    expect(getRedisConnectionOpts('redis://localhost:6379').db).toBeUndefined();
    expect(getRedisConnectionOpts('redis://localhost:6379/').db).toBeUndefined();
  });

  it('ignores a non-numeric db path', () => {
    expect(getRedisConnectionOpts('redis://localhost:6379/abc').db).toBeUndefined();
  });

  it('defaults the port to 6379 when omitted', () => {
    const opts = getRedisConnectionOpts('redis://myhost');
    expect(opts.host).toBe('myhost');
    expect(opts.port).toBe(6379);
  });

  it('decodes percent-encoded credentials (matches node-redis behavior)', () => {
    const opts = getRedisConnectionOpts('redis://app%40user:p%40ss%2Fword@host:6379');
    expect(opts.username).toBe('app@user');
    expect(opts.password).toBe('p@ss/word');
  });

  it('combines TLS, ACL credentials, and db index from one rediss:// URL', () => {
    const opts = getRedisConnectionOpts('rediss://worker:hunter2@redis.internal:6390/3');
    expect(opts).toEqual({
      host: 'redis.internal',
      port: 6390,
      username: 'worker',
      password: 'hunter2',
      db: 3,
      tls: {},
      maxRetriesPerRequest: null,
    });
  });

  it('falls back to localhost:6379 on an unparseable URL', () => {
    const opts = getRedisConnectionOpts('not a url');
    expect(opts).toEqual({
      host: 'localhost',
      port: 6379,
      maxRetriesPerRequest: null,
    });
  });

  it('falls back to localhost defaults on malformed percent-encoding instead of throwing', () => {
    // WHATWG URL parsing accepts an invalid %-sequence in the userinfo, but
    // decodeURIComponent throws URIError on it. Per the documented contract
    // the parser must degrade to the localhost fallback, never throw at
    // Queue/Worker construction time.
    const fallback = {
      host: 'localhost',
      port: 6379,
      maxRetriesPerRequest: null,
    };
    expect(() => getRedisConnectionOpts('redis://:pa%zzword@host:6390')).not.toThrow();
    expect(getRedisConnectionOpts('redis://:pa%zzword@host:6390')).toEqual(fallback);
    expect(getRedisConnectionOpts('redis://bad%user:pw@host:6390')).toEqual(fallback);
  });

  it('always sets maxRetriesPerRequest: null (required by BullMQ)', () => {
    expect(getRedisConnectionOpts('redis://h:1').maxRetriesPerRequest).toBeNull();
    expect(getRedisConnectionOpts('://broken').maxRetriesPerRequest).toBeNull();
  });

  it('reads REDIS_URL from the environment when called without arguments', () => {
    vi.stubEnv('REDIS_URL', 'rediss://env-user:env-pass@env-host:7000/1');
    const opts = getRedisConnectionOpts();
    expect(opts).toEqual({
      host: 'env-host',
      port: 7000,
      username: 'env-user',
      password: 'env-pass',
      db: 1,
      tls: {},
      maxRetriesPerRequest: null,
    });
  });

  it('defaults to redis://localhost:6379 when REDIS_URL is unset', () => {
    vi.stubEnv('REDIS_URL', '');
    const original = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    try {
      const opts = getRedisConnectionOpts();
      expect(opts).toEqual({
        host: 'localhost',
        port: 6379,
        maxRetriesPerRequest: null,
      });
    } finally {
      process.env.REDIS_URL = original;
    }
  });
});
