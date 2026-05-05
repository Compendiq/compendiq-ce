/**
 * Tests for the IP allowlist Fastify `onRequest` hook (EE #111, Phase C).
 *
 * Covers the nine non-negotiable gates from the plan — above all the forged-
 * XFF case (an untrusted socket must NOT be able to claim an allowlisted IP
 * via an X-Forwarded-For header).
 *
 * We drive the hook through a real Fastify instance via `app.inject` so the
 * `onRequest` wiring (plugin encapsulation, reply short-circuit semantics) is
 * exercised end-to-end. The ip-allowlist-service is mocked so we can flip
 * individual predicates per test without touching the cache-bus / DB.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const mockIsAllowed = vi.fn<(addr: string) => boolean>();
const mockIsTrustedProxy = vi.fn<(addr: string) => boolean>();
const mockIsExemptPath = vi.fn<(path: string) => boolean>();
vi.mock('../services/ip-allowlist-service.js', () => ({
  isAllowed: (addr: string) => mockIsAllowed(addr),
  isTrustedProxy: (addr: string) => mockIsTrustedProxy(addr),
  isExemptPath: (path: string) => mockIsExemptPath(path),
}));

const mockLogAuditEvent = vi.fn();
vi.mock('../services/audit-service.js', () => ({
  logAuditEvent: (
    userId: string | null,
    action: string,
    resourceType?: string,
    resourceId?: string,
    metadata?: Record<string, unknown>,
    request?: unknown,
  ) => mockLogAuditEvent(userId, action, resourceType, resourceId, metadata, request),
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import ipAllowlistHook from './ip-allowlist-hook.js';

/**
 * Build a minimal Fastify instance with the hook registered and a dummy
 * route that answers `200 ok` if the hook lets the request through.
 *
 * Using `exposeHeadRoutes: false` keeps the test surface small; `logger: false`
 * avoids noisy output in the test terminal.
 */
async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, exposeHeadRoutes: false });
  await app.register(ipAllowlistHook);
  app.get('/test', async () => ({ status: 'ok' }));
  app.get('/api/health', async () => ({ status: 'ok' }));
  await app.ready();
  return app;
}

describe('ip-allowlist-hook (onRequest)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    mockIsAllowed.mockReset();
    mockIsTrustedProxy.mockReset();
    mockIsExemptPath.mockReset();
    mockLogAuditEvent.mockReset();
    // Default: every path non-exempt, nobody trusted, nobody allowed.
    // Individual tests override as needed.
    mockIsExemptPath.mockReturnValue(false);
    mockIsTrustedProxy.mockReturnValue(false);
    mockIsAllowed.mockReturnValue(false);
    mockLogAuditEvent.mockResolvedValue(undefined);
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('exempt-path short-circuit', () => {
    it('lets an otherwise-blocked request through if the path is exempt (isAllowed NOT called)', async () => {
      mockIsExemptPath.mockImplementation((p) => p === '/api/health');
      // isAllowed would return false if asked — but it must never be asked.
      mockIsAllowed.mockReturnValue(false);

      const res = await app.inject({
        method: 'GET',
        url: '/api/health',
        remoteAddress: '203.0.113.7',
      });

      expect(res.statusCode).toBe(200);
      expect(mockIsExemptPath).toHaveBeenCalledWith('/api/health');
      expect(mockIsAllowed).not.toHaveBeenCalled();
      expect(mockLogAuditEvent).not.toHaveBeenCalled();
    });

    it('strips the query string before the exempt-path check', async () => {
      mockIsExemptPath.mockImplementation((p) => p === '/api/health');
      mockIsAllowed.mockReturnValue(false);

      const res = await app.inject({
        method: 'GET',
        url: '/api/health?probe=1&detail=full',
        remoteAddress: '203.0.113.7',
      });

      expect(res.statusCode).toBe(200);
      expect(mockIsExemptPath).toHaveBeenCalledWith('/api/health');
      expect(mockIsExemptPath).not.toHaveBeenCalledWith(
        expect.stringContaining('?'),
      );
    });
  });

  describe('forged X-Forwarded-For from an untrusted socket (THE hard gate)', () => {
    it('ignores XFF when the socket peer is not trusted — passes socket IP to isAllowed, returns 403', async () => {
      mockIsExemptPath.mockReturnValue(false);
      // 192.0.2.1 is NOT in trusted proxies.
      mockIsTrustedProxy.mockImplementation((addr) => addr === '172.16.0.1');
      // 10.0.0.1 would be allowlisted IF we honoured the forged header — we must NOT.
      mockIsAllowed.mockImplementation((addr) => addr === '10.0.0.1');

      const res = await app.inject({
        method: 'GET',
        url: '/test',
        remoteAddress: '192.0.2.1',
        headers: { 'x-forwarded-for': '10.0.0.1' },
      });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body)).toEqual({
        error: 'ip_blocked',
        message: 'Access denied from your network.',
      });
      // Hook must have queried isAllowed with the SOCKET ip, not the forged one.
      expect(mockIsAllowed).toHaveBeenCalledWith('192.0.2.1');
      expect(mockIsAllowed).not.toHaveBeenCalledWith('10.0.0.1');
    });
  });

  describe('trusted socket + XFF chain', () => {
    it('honours a single XFF hop when the socket is trusted (passes that hop to isAllowed)', async () => {
      mockIsTrustedProxy.mockImplementation((addr) => addr === '172.16.0.1');
      mockIsAllowed.mockImplementation((addr) => addr === '10.0.0.5');

      const res = await app.inject({
        method: 'GET',
        url: '/test',
        remoteAddress: '172.16.0.1',
        headers: { 'x-forwarded-for': '10.0.0.5' },
      });

      expect(res.statusCode).toBe(200);
      expect(mockIsAllowed).toHaveBeenCalledWith('10.0.0.5');
      expect(mockIsAllowed).not.toHaveBeenCalledWith('172.16.0.1');
    });

    it('stops at the first untrusted hop walking right-to-left (client, trusted-proxy-2, trusted-proxy-1)', async () => {
      // Trusted: the socket + two named proxies. "real-client" is the one we want.
      const trusted = new Set(['172.16.0.1', 'first-proxy', 'second-proxy']);
      mockIsTrustedProxy.mockImplementation((addr) => trusted.has(addr));
      mockIsAllowed.mockImplementation((addr) => addr === 'real-client');

      const res = await app.inject({
        method: 'GET',
        url: '/test',
        remoteAddress: '172.16.0.1',
        headers: {
          // Left-to-right: client, then each proxy that forwarded. The hook
          // walks right-to-left, peeling trusted hops until it hits the first
          // untrusted — which is the real client.
          'x-forwarded-for': 'real-client, second-proxy, first-proxy',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(mockIsAllowed).toHaveBeenCalledWith('real-client');
    });

    it('returns the leftmost hop when the entire XFF chain is trusted', async () => {
      const trusted = new Set(['172.16.0.1', 'proxy-a', 'proxy-b', 'proxy-c']);
      mockIsTrustedProxy.mockImplementation((addr) => trusted.has(addr));
      mockIsAllowed.mockImplementation((addr) => addr === 'proxy-a');

      const res = await app.inject({
        method: 'GET',
        url: '/test',
        remoteAddress: '172.16.0.1',
        headers: { 'x-forwarded-for': 'proxy-a, proxy-b, proxy-c' },
      });

      expect(res.statusCode).toBe(200);
      // Leftmost = proxy-a (walking the all-trusted chain keeps the final
      // value seen in the right-to-left walk).
      expect(mockIsAllowed).toHaveBeenCalledWith('proxy-a');
    });

    it('falls back to the socket IP when XFF is missing entirely on a trusted peer', async () => {
      mockIsTrustedProxy.mockImplementation((addr) => addr === '172.16.0.1');
      mockIsAllowed.mockImplementation((addr) => addr === '172.16.0.1');

      const res = await app.inject({
        method: 'GET',
        url: '/test',
        remoteAddress: '172.16.0.1',
      });

      expect(res.statusCode).toBe(200);
      expect(mockIsAllowed).toHaveBeenCalledWith('172.16.0.1');
    });
  });

  describe('IPv4-mapped-IPv6 normalisation', () => {
    it('strips `::ffff:` prefix before the trusted-proxy check', async () => {
      // The dual-stack socket hands us "::ffff:192.0.2.1". The hook must
      // feed plain "192.0.2.1" into isTrustedProxy so IPv4 CIDRs match.
      mockIsTrustedProxy.mockImplementation((addr) => addr === '192.0.2.1');
      mockIsAllowed.mockImplementation((addr) => addr === '192.0.2.1');

      const res = await app.inject({
        method: 'GET',
        url: '/test',
        remoteAddress: '::ffff:192.0.2.1',
      });

      expect(res.statusCode).toBe(200);
      // The first call is the trusted-proxy check; then XFF is empty so we
      // fall back to the socket IP for the allow check.
      expect(mockIsTrustedProxy).toHaveBeenCalledWith('192.0.2.1');
      expect(mockIsTrustedProxy).not.toHaveBeenCalledWith('::ffff:192.0.2.1');
      expect(mockIsAllowed).toHaveBeenCalledWith('192.0.2.1');
    });
  });

  describe('block path — audit + 403 shape', () => {
    it('records an IP_ALLOWLIST_BLOCKED audit event with the expected metadata', async () => {
      mockIsTrustedProxy.mockReturnValue(false);
      mockIsAllowed.mockReturnValue(false);

      const res = await app.inject({
        method: 'GET',
        url: '/test',
        remoteAddress: '203.0.113.42',
        headers: { 'x-forwarded-for': '10.0.0.99' },
      });

      expect(res.statusCode).toBe(403);
      expect(mockLogAuditEvent).toHaveBeenCalledTimes(1);
      expect(mockLogAuditEvent).toHaveBeenCalledWith(
        null,
        'IP_ALLOWLIST_BLOCKED',
        'request',
        '/test',
        expect.objectContaining({
          clientIp: '203.0.113.42',
          socketIp: '203.0.113.42',
          xff: '10.0.0.99',
        }),
        expect.anything(),
      );
    });

    it('fires the audit event fire-and-forget — 403 returns even if the audit promise never resolves', async () => {
      mockIsTrustedProxy.mockReturnValue(false);
      mockIsAllowed.mockReturnValue(false);
      // Audit promise stays pending forever. If the hook awaited it,
      // app.inject would hang and Vitest would time the test out.
      mockLogAuditEvent.mockImplementation(() => new Promise<void>(() => {}));

      const res = await app.inject({
        method: 'GET',
        url: '/test',
        remoteAddress: '203.0.113.42',
      });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body)).toEqual({
        error: 'ip_blocked',
        message: 'Access denied from your network.',
      });
      expect(mockLogAuditEvent).toHaveBeenCalledTimes(1);
    });

    it('returns exactly { error: "ip_blocked", message: "Access denied from your network." }', async () => {
      mockIsTrustedProxy.mockReturnValue(false);
      mockIsAllowed.mockReturnValue(false);

      const res = await app.inject({
        method: 'GET',
        url: '/test',
        remoteAddress: '203.0.113.42',
      });

      expect(res.statusCode).toBe(403);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(JSON.parse(res.body)).toEqual({
        error: 'ip_blocked',
        message: 'Access denied from your network.',
      });
    });
  });

  describe('defensive edge case — missing socket address', () => {
    it('does not crash when req.socket.remoteAddress is undefined; block path still fires cleanly', async () => {
      mockIsTrustedProxy.mockReturnValue(false);
      mockIsAllowed.mockReturnValue(false);

      // light-my-request defaults remoteAddress to '127.0.0.1' when omitted;
      // to simulate the truly-undefined case we delete it on the incoming
      // request via a preValidation-ish preHandler. The cleanest path is to
      // use a onRequest hook registered BEFORE the plugin — but since the
      // plugin is already registered on this app, we stub the socket on a
      // fresh app so the ordering is right.
      const freshApp = Fastify({ logger: false, exposeHeadRoutes: false });
      freshApp.addHook('onRequest', async (req) => {
        // Force the socket.remoteAddress to undefined before our hook runs.
        Object.defineProperty(req.socket, 'remoteAddress', {
          value: undefined,
          configurable: true,
        });
      });
      await freshApp.register(ipAllowlistHook);
      freshApp.get('/test', async () => ({ status: 'ok' }));
      await freshApp.ready();

      try {
        const res = await freshApp.inject({
          method: 'GET',
          url: '/test',
        });

        // Empty socket → clientIp is "" → isAllowed("") is false (mock default)
        // → 403 without crashing.
        expect(res.statusCode).toBe(403);
        expect(mockIsAllowed).toHaveBeenCalledWith('');
      } finally {
        await freshApp.close();
      }
    });
  });
});
