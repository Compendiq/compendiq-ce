import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger
vi.mock('../core/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock license-service — we control what getLicenseInfo returns
const mockGetLicenseInfo = vi.fn();
vi.mock('./license-service.js', () => ({
  getLicenseInfo: (...args: unknown[]) => mockGetLicenseInfo(...args),
}));

import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import licensePlugin from './license-middleware.js';
import type { LicenseInfo } from './types.js';

function communityLicense(): LicenseInfo {
  return {
    tier: 'community',
    seats: 0,
    expiry: new Date(0),
    isValid: false,
    isExpired: false,
    raw: null,
  };
}

function validTeamLicense(): LicenseInfo {
  return {
    tier: 'team',
    seats: 10,
    expiry: new Date(2030, 11, 31),
    isValid: true,
    isExpired: false,
    raw: 'ATM-team-10-20301231-fakesig',
  };
}

function validEnterpriseLicense(): LicenseInfo {
  return {
    tier: 'enterprise',
    seats: 200,
    expiry: new Date(2030, 11, 31),
    isValid: true,
    isExpired: false,
    raw: 'ATM-enterprise-200-20301231-fakesig',
  };
}

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  await app.register(licensePlugin);

  // Test route that is gated by enterprise license
  app.get('/gated', { preHandler: [app.checkEnterpriseLicense] }, async (request) => {
    return { tier: request.licenseTier, message: 'ok' };
  });

  // Test route that is NOT gated (shows licenseTier is always attached)
  app.get('/open', async (request) => {
    return { tier: request.licenseTier };
  });

  // Error handler matching app.ts pattern
  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    const statusCode = error.statusCode ?? 500;
    reply.status(statusCode).send({
      error: error.name ?? 'InternalServerError',
      message: statusCode === 500 ? 'Internal Server Error' : error.message,
      statusCode,
    });
  });

  return app;
}

describe('license-middleware', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  // ── licenseTier on every request ─────────────────────────────────────────

  describe('onRequest hook (licenseTier)', () => {
    it('attaches community tier when no license', async () => {
      mockGetLicenseInfo.mockReturnValue(communityLicense());

      const res = await app.inject({ method: 'GET', url: '/open' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.tier).toBe('community');
    });

    it('attaches team tier when team license is valid', async () => {
      mockGetLicenseInfo.mockReturnValue(validTeamLicense());

      const res = await app.inject({ method: 'GET', url: '/open' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.tier).toBe('team');
    });

    it('attaches enterprise tier when enterprise license is valid', async () => {
      mockGetLicenseInfo.mockReturnValue(validEnterpriseLicense());

      const res = await app.inject({ method: 'GET', url: '/open' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.tier).toBe('enterprise');
    });
  });

  // ── checkEnterpriseLicense ───────────────────────────────────────────────

  describe('checkEnterpriseLicense', () => {
    it('allows request with valid team license', async () => {
      mockGetLicenseInfo.mockReturnValue(validTeamLicense());

      const res = await app.inject({ method: 'GET', url: '/gated' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.message).toBe('ok');
      expect(body.tier).toBe('team');
    });

    it('allows request with valid enterprise license', async () => {
      mockGetLicenseInfo.mockReturnValue(validEnterpriseLicense());

      const res = await app.inject({ method: 'GET', url: '/gated' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.message).toBe('ok');
    });

    it('rejects request with community tier (403)', async () => {
      mockGetLicenseInfo.mockReturnValue(communityLicense());

      const res = await app.inject({ method: 'GET', url: '/gated' });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.message).toContain('enterprise license');
    });
  });

  // ── Decorator existence ──────────────────────────────────────────────────

  describe('plugin registration', () => {
    it('decorates fastify with checkEnterpriseLicense', () => {
      expect(typeof app.checkEnterpriseLicense).toBe('function');
    });
  });
});
