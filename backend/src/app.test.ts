import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createClient, type RedisClientType } from 'redis';
import { buildApp as productionBuildApp } from './app.js';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from './test-db-helper.js';
import { isRedisAvailable } from './test-redis-helper.js';

/**
 * Full production-app integration coverage. Persistence, auth, route plugins,
 * lifecycle workers, and their close hooks stay real; only network egress is
 * blocked at the DNS/HTTP boundary.
 */
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => {
    const error = new Error(
      'getaddrinfo ENOTFOUND (blocked by app.test)',
    ) as NodeJS.ErrnoException;
    error.code = 'ENOTFOUND';
    throw error;
  }),
}));

const dbAvailable = await isDbAvailable();
const redisAvailable = dbAvailable ? await isRedisAvailable() : false;
const canRun = dbAvailable && redisAvailable;

const apps = new Set<FastifyInstance>();
let redisAdmin: RedisClientType | undefined;

async function createTestApp(): Promise<FastifyInstance> {
  const app = await productionBuildApp();
  apps.add(app);
  return app;
}

async function closeTestApp(app: FastifyInstance): Promise<void> {
  if (!apps.has(app)) return;
  const close = app.close.bind(app);
  await close();
  apps.delete(app);
}

async function closeAllApps(): Promise<void> {
  const openApps = [...apps];
  const results = await Promise.allSettled(openApps.map(async (app) => app.close()));
  const failures: unknown[] = [];
  for (const [index, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      apps.delete(openApps[index]!);
    } else {
      failures.push(result.reason);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Failed to close one or more buildApp instances');
  }
}

beforeAll(async () => {
  if (!canRun) return;
  vi.stubGlobal('fetch', vi.fn(async (): Promise<Response> => {
    throw new Error('Outbound HTTP is blocked by app.test');
  }));
  await setupTestDb();
  redisAdmin = createClient({
    url: process.env.REDIS_URL,
    socket: { connectTimeout: 1_000, reconnectStrategy: false },
  }) as RedisClientType;
  redisAdmin.on('error', () => {
    // Connection failures surface from setup/cleanup operations below.
  });
  await redisAdmin.connect();
  await redisAdmin.flushDb();
}, 30_000);

beforeEach(async () => {
  if (!canRun) return;
  await truncateAllTables();
  await redisAdmin?.flushDb();
});

afterEach(async () => {
  if (!canRun) return;
  try {
    await closeAllApps();
  } finally {
    await redisAdmin?.flushDb();
  }
});

afterAll(async () => {
  if (!canRun) return;
  const failures: unknown[] = [];
  try {
    await closeAllApps();
  } catch (error) {
    failures.push(error);
  }
  try {
    await redisAdmin?.flushDb();
    await redisAdmin?.quit();
  } catch (error) {
    failures.push(error);
    if (redisAdmin?.isOpen) {
      try {
        await redisAdmin.disconnect();
      } catch (disconnectError) {
        failures.push(disconnectError);
      }
    }
  }
  try {
    await teardownTestDb();
  } catch (error) {
    failures.push(error);
  }
  vi.unstubAllGlobals();
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Failed to tear down app.test persistence');
  }
}, 30_000);

describe.skipIf(!canRun)('buildApp — community OIDC config fallback', () => {
  it('serves a disabled OIDC config so the shared CE login page hides the SSO button', async () => {

    const app = await createTestApp();

    try {
      const response = await app.inject({ method: 'GET', url: '/api/auth/oidc/config' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        enabled: false,
        issuer: null,
        name: null,
        enterpriseRequired: true,
      });
    } finally {
      await closeTestApp(app);
    }
  });
});

describe.skipIf(!canRun)('buildApp — CORS multi-origin support', () => {
  const originalFrontendUrl = process.env.FRONTEND_URL;

  afterEach(() => {
    if (originalFrontendUrl === undefined) {
      delete process.env.FRONTEND_URL;
    } else {
      process.env.FRONTEND_URL = originalFrontendUrl;
    }
  });

  it('should allow a single CORS origin', async () => {
    process.env.FRONTEND_URL = 'https://app.example.com';

    const app = await createTestApp();

    const response = await app.inject({
      method: 'OPTIONS',
      url: '/api/health',
      headers: { origin: 'https://app.example.com' },
    });

    expect(response.headers['access-control-allow-origin']).toBe('https://app.example.com');
    await closeTestApp(app);
  });

  it('should allow multiple CORS origins (comma-separated)', async () => {
    process.env.FRONTEND_URL = 'https://app.example.com, https://staging.example.com';

    const app = await createTestApp();

    // First origin
    const res1 = await app.inject({
      method: 'OPTIONS',
      url: '/api/health',
      headers: { origin: 'https://app.example.com' },
    });
    expect(res1.headers['access-control-allow-origin']).toBe('https://app.example.com');

    // Second origin
    const res2 = await app.inject({
      method: 'OPTIONS',
      url: '/api/health',
      headers: { origin: 'https://staging.example.com' },
    });
    expect(res2.headers['access-control-allow-origin']).toBe('https://staging.example.com');

    await closeTestApp(app);
  });

  it('should reject unknown origins when multiple are configured', async () => {
    process.env.FRONTEND_URL = 'https://app.example.com, https://staging.example.com';

    const app = await createTestApp();

    const response = await app.inject({
      method: 'OPTIONS',
      url: '/api/health',
      headers: { origin: 'https://evil.example.com' },
    });

    // @fastify/cors returns false/empty for disallowed origins
    expect(response.headers['access-control-allow-origin']).not.toBe('https://evil.example.com');
    await closeTestApp(app);
  });
});

describe.skipIf(!canRun)('buildApp — CORS allowed methods (#1055)', () => {
  const originalFrontendUrl = process.env.FRONTEND_URL;

  afterEach(() => {
    if (originalFrontendUrl === undefined) {
      delete process.env.FRONTEND_URL;
    } else {
      process.env.FRONTEND_URL = originalFrontendUrl;
    }
  });

  // Parse the comma-joined Access-Control-Allow-Methods header into an
  // uppercase Set so assertions are agnostic to the plugin's comma spacing.
  function methodSet(header: string | undefined): Set<string> {
    return new Set(
      (header ?? '')
        .split(',')
        .map((m) => m.trim().toUpperCase())
        .filter(Boolean),
    );
  }

  const ALL_VERBS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;

  it('advertises the full method set for an allowed origin', async () => {
    process.env.FRONTEND_URL = 'http://localhost:8081';

    const app = await createTestApp();

    try {
      const response = await app.inject({
        method: 'OPTIONS',
        url: '/api/pages/5',
        headers: {
          origin: 'http://localhost:8081',
          'access-control-request-method': 'PUT',
        },
      });

      expect(response.headers['access-control-allow-origin']).toBe('http://localhost:8081');
      const methods = methodSet(response.headers['access-control-allow-methods'] as string);
      // Regression guard: PUT/PATCH/DELETE were previously missing (plugin
      // default was GET,HEAD,POST only).
      for (const verb of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']) {
        expect(methods.has(verb)).toBe(true);
      }
    } finally {
      await closeTestApp(app);
    }
  });

  it.each(ALL_VERBS)('allowed-origin preflight advertises %s', async (verb) => {
    process.env.FRONTEND_URL = 'http://localhost:8081';

    const app = await createTestApp();

    try {
      const response = await app.inject({
        method: 'OPTIONS',
        url: '/api/pages/5',
        headers: {
          origin: 'http://localhost:8081',
          'access-control-request-method': verb,
        },
      });

      const methods = methodSet(response.headers['access-control-allow-methods'] as string);
      expect(methods.has(verb)).toBe(true);
    } finally {
      await closeTestApp(app);
    }
  });

  it.each(ALL_VERBS)('disallowed origin cannot read a credentialed %s response', async (verb) => {
    // Multi-origin (array) form so @fastify/cors exercises reflect-or-reject;
    // a single configured origin is reflected unconditionally.
    process.env.FRONTEND_URL = 'http://localhost:8081, http://localhost:5273';

    const app = await createTestApp();

    try {
      const response = await app.inject({
        method: 'OPTIONS',
        url: '/api/pages/5',
        headers: {
          origin: 'http://evil.example.com',
          'access-control-request-method': verb,
        },
      });

      // No matching Access-Control-Allow-Origin → browser blocks reading the
      // credentialed response regardless of verb.
      expect(response.headers['access-control-allow-origin']).not.toBe('http://evil.example.com');
    } finally {
      await closeTestApp(app);
    }
  });
});

describe.skipIf(!canRun)('buildApp — compression threshold', () => {
  // Regression guard for the production-only @fastify/compress bug observed in
  // the EE backend container: a ~1KB JSON response (/api/health, 1042 bytes)
  // was compressed to an empty body when the client sent
  // `Accept-Encoding: gzip, br, zstd`, leaving the Diagnostics page unable
  // to read backend metadata. The fix raises the floor to 4096 so payloads
  // in the bug-prone size range pass through uncompressed.

  it('does not compress responses below the 4096-byte threshold', async () => {

    const app = await createTestApp();

    // Synthetic route returning ~1KB JSON — the same size range as the live
    // /api/health response that triggered the bug in production.
    app.get('/__test__/small-payload', async (_req, reply) => {
      const payload = { data: 'x'.repeat(1000), size: 'about-1KB' };
      return reply.status(200).send(payload);
    });

    const response = await app.inject({
      method: 'GET',
      url: '/__test__/small-payload',
      headers: { 'accept-encoding': 'gzip, br, zstd' },
    });

    expect(response.statusCode).toBe(200);
    // Below threshold → no content-encoding, body intact.
    expect(response.headers['content-encoding']).toBeUndefined();
    expect(response.rawPayload.length).toBeGreaterThan(900);
    expect(() => JSON.parse(response.rawPayload.toString('utf8'))).not.toThrow();

    await closeTestApp(app);
  });

  it('does compress responses above the 4096-byte threshold', async () => {

    const app = await createTestApp();

    // Synthetic route returning ~5KB JSON — well above the threshold, so
    // compression should kick in to confirm the plugin is wired up and the
    // raised threshold isn't equivalent to disabling compression entirely.
    app.get('/__test__/large-payload', async (_req, reply) => {
      const payload = { data: 'x'.repeat(5000), size: 'about-5KB' };
      return reply.status(200).send(payload);
    });

    const response = await app.inject({
      method: 'GET',
      url: '/__test__/large-payload',
      headers: { 'accept-encoding': 'gzip, br, zstd' },
    });

    expect(response.statusCode).toBe(200);
    // Above threshold → some content-encoding must be set, and the body
    // must be non-empty (the bug we are guarding against: empty body
    // alongside an encoding header).
    expect(response.headers['content-encoding']).toMatch(/^(gzip|br|zstd|deflate)$/);
    expect(response.rawPayload.length).toBeGreaterThan(0);

    await closeTestApp(app);
  });
});

describe.skipIf(!canRun)('buildApp — error handler information leakage', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('should not leak internal error names like TypeError for non-500 errors', async () => {
    process.env.NODE_ENV = 'development';

    const app = await createTestApp();

    // Register a test route that throws a TypeError with a non-500 status code
    app.get('/test/type-error', async () => {
      const err = new TypeError('Cannot read properties of undefined') as TypeError & {
        statusCode: number;
      };
      err.statusCode = 400;
      throw err;
    });

    const response = await app.inject({ method: 'GET', url: '/test/type-error' });
    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    // Should NOT expose "TypeError" — should use generic name
    expect(body.error).not.toBe('TypeError');
    expect(body.error).toBe('ClientError');

    await closeTestApp(app);
  });

  it('should expose known Fastify HTTP error names', async () => {
    process.env.NODE_ENV = 'development';

    const app = await createTestApp();

    // Register a test route that throws a known Fastify error
    app.get('/test/not-found', async (_request, reply) => {
      return reply.notFound('Resource not found');
    });

    const response = await app.inject({ method: 'GET', url: '/test/not-found' });
    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('NotFoundError');

    await closeTestApp(app);
  });

  it('should always use InternalServerError for 500 errors regardless of error name', async () => {
    process.env.NODE_ENV = 'development';

    const app = await createTestApp();

    // Register a test route that throws a RangeError with 500 status
    app.get('/test/range-error', async () => {
      throw new RangeError('Value out of range');
    });

    const response = await app.inject({ method: 'GET', url: '/test/range-error' });
    expect(response.statusCode).toBe(500);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('InternalServerError');
    // Should NOT expose the actual error message for 500 errors
    expect(body.message).toBe('Internal Server Error');

    await closeTestApp(app);
  });

  it('forwards only allow-listed collab error codes', async () => {
    process.env.NODE_ENV = 'development';

    const app = await createTestApp();

    app.get('/test/leaky-code', async () => {
      throw Object.assign(new Error('hidden'), { statusCode: 400, code: 'internal_topology' });
    });
    app.get('/test/collab-code', async () => {
      throw Object.assign(new Error('session'), { statusCode: 409, code: 'collab_session_active' });
    });
    app.get('/test/confluence-code', async () => {
      throw Object.assign(new Error('remote'), { statusCode: 409, code: 'confluence_modified' });
    });
    app.get('/test/confluence-versions', async () => {
      throw Object.assign(new Error('remote'), {
        statusCode: 409,
        code: 'confluence_modified',
        remoteVersion: 9,
        localVersion: 7,
      });
    });

    const leaky = await app.inject({ method: 'GET', url: '/test/leaky-code' });
    expect(leaky.statusCode).toBe(400);
    expect(leaky.json().code).toBeUndefined();

    const collab = await app.inject({ method: 'GET', url: '/test/collab-code' });
    expect(collab.statusCode).toBe(409);
    expect(collab.json().code).toBe('collab_session_active');

    const conf = await app.inject({ method: 'GET', url: '/test/confluence-code' });
    expect(conf.statusCode).toBe(409);
    expect(conf.json().code).toBe('confluence_modified');

    const versions = await app.inject({ method: 'GET', url: '/test/confluence-versions' });
    expect(versions.json()).toMatchObject({
      code: 'confluence_modified',
      remoteVersion: 9,
      localVersion: 7,
    });

    await closeTestApp(app);
  });
});

describe.skipIf(!canRun)('buildApp — Swagger UI gating', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('should register Swagger UI in development', async () => {
    process.env.NODE_ENV = 'development';

    const app = await createTestApp();

    const response = await app.inject({ method: 'GET', url: '/api/docs/' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');

    await closeTestApp(app);
  });

  it('should not register Swagger UI in production', async () => {
    process.env.NODE_ENV = 'production';

    const app = await createTestApp();

    const response = await app.inject({ method: 'GET', url: '/api/docs/' });
    expect(response.statusCode).toBe(404);

    await closeTestApp(app);
  });
});

