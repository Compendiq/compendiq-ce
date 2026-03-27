import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';

// Mock logger
vi.mock('../core/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  getLicenseInfo,
  isEnterprise,
  generateLicenseKey,
  _resetLicenseCache,
} from './license-service.js';
import { logger } from '../core/utils/logger.js';

const TEST_SECRET = 'test-signing-secret-at-least-32-chars!!';

/** Helper to build a valid HMAC signature for a given data string */
function sign(data: string, secret: string = TEST_SECRET): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

/** Helper to build a full valid license key */
function buildKey(
  tier: string,
  seats: number,
  expiryStr: string,
  secret: string = TEST_SECRET,
): string {
  const data = `ATM-${tier}-${seats}-${expiryStr}`;
  const sig = sign(data, secret);
  return `${data}-${sig}`;
}

/** Build a future date string in YYYYMMDD format */
function futureDate(daysAhead: number = 365): string {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  return [
    d.getFullYear().toString(),
    (d.getMonth() + 1).toString().padStart(2, '0'),
    d.getDate().toString().padStart(2, '0'),
  ].join('');
}

/** Build a past date string in YYYYMMDD format */
function pastDate(daysAgo: number = 30): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return [
    d.getFullYear().toString(),
    (d.getMonth() + 1).toString().padStart(2, '0'),
    d.getDate().toString().padStart(2, '0'),
  ].join('');
}

describe('license-service', () => {
  beforeEach(() => {
    _resetLicenseCache();
    vi.clearAllMocks();
    delete process.env.ATLASMIND_LICENSE_KEY;
    delete process.env.ATLASMIND_LICENSE_SECRET;
    delete process.env.PAT_ENCRYPTION_KEY;
  });

  afterEach(() => {
    delete process.env.ATLASMIND_LICENSE_KEY;
    delete process.env.ATLASMIND_LICENSE_SECRET;
    delete process.env.PAT_ENCRYPTION_KEY;
  });

  // ── Community mode (no key) ──────────────────────────────────────────────

  describe('community mode', () => {
    it('returns community tier when no license key is set', () => {
      const info = getLicenseInfo();

      expect(info.tier).toBe('community');
      expect(info.seats).toBe(0);
      expect(info.isValid).toBe(false);
      expect(info.raw).toBeNull();
    });

    it('isEnterprise() returns false when no key is set', () => {
      expect(isEnterprise()).toBe(false);
    });
  });

  // ── Valid license keys ───────────────────────────────────────────────────

  describe('valid license keys', () => {
    it('parses a valid team license', () => {
      const expiry = futureDate();
      process.env.ATLASMIND_LICENSE_SECRET = TEST_SECRET;
      process.env.ATLASMIND_LICENSE_KEY = buildKey('team', 10, expiry);

      const info = getLicenseInfo();

      expect(info.tier).toBe('team');
      expect(info.seats).toBe(10);
      expect(info.isValid).toBe(true);
      expect(info.isExpired).toBe(false);
    });

    it('parses a valid business license', () => {
      const expiry = futureDate();
      process.env.ATLASMIND_LICENSE_SECRET = TEST_SECRET;
      process.env.ATLASMIND_LICENSE_KEY = buildKey('business', 50, expiry);

      const info = getLicenseInfo();

      expect(info.tier).toBe('business');
      expect(info.seats).toBe(50);
      expect(info.isValid).toBe(true);
    });

    it('parses a valid enterprise license', () => {
      const expiry = futureDate();
      process.env.ATLASMIND_LICENSE_SECRET = TEST_SECRET;
      process.env.ATLASMIND_LICENSE_KEY = buildKey('enterprise', 200, expiry);

      const info = getLicenseInfo();

      expect(info.tier).toBe('enterprise');
      expect(info.seats).toBe(200);
      expect(info.isValid).toBe(true);
    });

    it('isEnterprise() returns true for valid license', () => {
      process.env.ATLASMIND_LICENSE_SECRET = TEST_SECRET;
      process.env.ATLASMIND_LICENSE_KEY = buildKey('team', 10, futureDate());

      expect(isEnterprise()).toBe(true);
    });

    it('falls back to PAT_ENCRYPTION_KEY for signature verification', () => {
      const expiry = futureDate();
      process.env.PAT_ENCRYPTION_KEY = TEST_SECRET;
      process.env.ATLASMIND_LICENSE_KEY = buildKey('team', 5, expiry);

      const info = getLicenseInfo();

      expect(info.tier).toBe('team');
      expect(info.isValid).toBe(true);
    });

    it('prefers ATLASMIND_LICENSE_SECRET over PAT_ENCRYPTION_KEY', () => {
      const expiry = futureDate();
      const otherSecret = 'other-secret-at-least-32-characters!!';
      process.env.ATLASMIND_LICENSE_SECRET = TEST_SECRET;
      process.env.PAT_ENCRYPTION_KEY = otherSecret;
      // Sign with TEST_SECRET (ATLASMIND_LICENSE_SECRET)
      process.env.ATLASMIND_LICENSE_KEY = buildKey('team', 5, expiry, TEST_SECRET);

      const info = getLicenseInfo();

      expect(info.tier).toBe('team');
      expect(info.isValid).toBe(true);
    });
  });

  // ── Expired license ──────────────────────────────────────────────────────

  describe('expired license', () => {
    it('returns community tier for expired key', () => {
      const expiry = pastDate(30);
      process.env.ATLASMIND_LICENSE_SECRET = TEST_SECRET;
      process.env.ATLASMIND_LICENSE_KEY = buildKey('enterprise', 100, expiry);

      const info = getLicenseInfo();

      expect(info.tier).toBe('community');
      expect(info.seats).toBe(100); // seat count is still preserved
      expect(info.isValid).toBe(false);
      expect(info.isExpired).toBe(true);
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        expect.objectContaining({ expiry }),
        expect.stringContaining('expired'),
      );
    });

    it('isEnterprise() returns false for expired key', () => {
      process.env.ATLASMIND_LICENSE_SECRET = TEST_SECRET;
      process.env.ATLASMIND_LICENSE_KEY = buildKey('team', 10, pastDate());

      expect(isEnterprise()).toBe(false);
    });
  });

  // ── Invalid keys ─────────────────────────────────────────────────────────

  describe('invalid license keys', () => {
    it('returns community for key with wrong prefix', () => {
      process.env.ATLASMIND_LICENSE_SECRET = TEST_SECRET;
      process.env.ATLASMIND_LICENSE_KEY = 'XYZ-team-10-20301231-abc123';

      const info = getLicenseInfo();

      expect(info.tier).toBe('community');
      expect(info.isValid).toBe(false);
    });

    it('returns community for key with too few parts', () => {
      process.env.ATLASMIND_LICENSE_SECRET = TEST_SECRET;
      process.env.ATLASMIND_LICENSE_KEY = 'ATM-team-10';

      const info = getLicenseInfo();

      expect(info.tier).toBe('community');
    });

    it('returns community for key with too many parts', () => {
      process.env.ATLASMIND_LICENSE_SECRET = TEST_SECRET;
      process.env.ATLASMIND_LICENSE_KEY = 'ATM-team-10-20301231-sig-extra';

      const info = getLicenseInfo();

      expect(info.tier).toBe('community');
    });

    it('returns community for invalid tier', () => {
      process.env.ATLASMIND_LICENSE_SECRET = TEST_SECRET;
      process.env.ATLASMIND_LICENSE_KEY = 'ATM-premium-10-20301231-fakesig';

      const info = getLicenseInfo();

      expect(info.tier).toBe('community');
    });

    it('returns community for non-numeric seat count', () => {
      process.env.ATLASMIND_LICENSE_SECRET = TEST_SECRET;
      process.env.ATLASMIND_LICENSE_KEY = 'ATM-team-abc-20301231-fakesig';

      const info = getLicenseInfo();

      expect(info.tier).toBe('community');
    });

    it('returns community for zero seat count', () => {
      process.env.ATLASMIND_LICENSE_SECRET = TEST_SECRET;
      process.env.ATLASMIND_LICENSE_KEY = 'ATM-team-0-20301231-fakesig';

      const info = getLicenseInfo();

      expect(info.tier).toBe('community');
    });

    it('returns community for negative seat count', () => {
      process.env.ATLASMIND_LICENSE_SECRET = TEST_SECRET;
      // Note: negative produces 6 parts because of the extra dash — still handled
      process.env.ATLASMIND_LICENSE_KEY = 'ATM-team--5-20301231-fakesig';

      const info = getLicenseInfo();

      expect(info.tier).toBe('community');
    });

    it('returns community for malformed expiry date', () => {
      process.env.ATLASMIND_LICENSE_SECRET = TEST_SECRET;
      process.env.ATLASMIND_LICENSE_KEY = 'ATM-team-10-2030123-fakesig'; // 7 digits

      const info = getLicenseInfo();

      expect(info.tier).toBe('community');
    });

    it('returns community for wrong signature and logs warning', () => {
      process.env.ATLASMIND_LICENSE_SECRET = TEST_SECRET;
      process.env.ATLASMIND_LICENSE_KEY = `ATM-team-10-${futureDate()}-0000000000000000000000000000000000000000000000000000000000000000`;

      const info = getLicenseInfo();

      expect(info.tier).toBe('community');
      expect(info.isValid).toBe(false);
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        expect.stringContaining('Invalid license key signature'),
      );
    });

    it('returns community when no signing secret is available', () => {
      // No ATLASMIND_LICENSE_SECRET or PAT_ENCRYPTION_KEY set
      process.env.ATLASMIND_LICENSE_KEY = `ATM-team-10-${futureDate()}-anysignature`;

      const info = getLicenseInfo();

      expect(info.tier).toBe('community');
    });

    it('handles whitespace around the key', () => {
      const expiry = futureDate();
      process.env.ATLASMIND_LICENSE_SECRET = TEST_SECRET;
      process.env.ATLASMIND_LICENSE_KEY = `  ${buildKey('team', 10, expiry)}  `;

      const info = getLicenseInfo();

      expect(info.tier).toBe('team');
      expect(info.isValid).toBe(true);
    });
  });

  // ── Caching ──────────────────────────────────────────────────────────────

  describe('caching', () => {
    it('caches the license result after first call', () => {
      process.env.ATLASMIND_LICENSE_SECRET = TEST_SECRET;
      process.env.ATLASMIND_LICENSE_KEY = buildKey('team', 10, futureDate());

      const first = getLicenseInfo();
      // Changing env after first call should not affect result
      process.env.ATLASMIND_LICENSE_KEY = '';
      const second = getLicenseInfo();

      expect(first).toBe(second); // Same reference
      expect(second.tier).toBe('team');
    });

    it('_resetLicenseCache clears the cached result', () => {
      process.env.ATLASMIND_LICENSE_SECRET = TEST_SECRET;
      process.env.ATLASMIND_LICENSE_KEY = buildKey('team', 10, futureDate());

      const first = getLicenseInfo();
      expect(first.tier).toBe('team');

      _resetLicenseCache();
      delete process.env.ATLASMIND_LICENSE_KEY;

      const second = getLicenseInfo();
      expect(second.tier).toBe('community');
    });
  });

  // ── generateLicenseKey ───────────────────────────────────────────────────

  describe('generateLicenseKey', () => {
    it('generates a valid key that can be verified', () => {
      process.env.ATLASMIND_LICENSE_SECRET = TEST_SECRET;

      const expiry = new Date(2030, 11, 31); // Dec 31 2030
      const key = generateLicenseKey('enterprise', 100, expiry);

      expect(key).toMatch(/^ATM-enterprise-100-20301231-[0-9a-f]{64}$/);

      // Parse the generated key to verify round-trip
      _resetLicenseCache();
      process.env.ATLASMIND_LICENSE_KEY = key;
      const info = getLicenseInfo();

      expect(info.tier).toBe('enterprise');
      expect(info.seats).toBe(100);
      expect(info.isValid).toBe(true);
    });

    it('pads month and day correctly', () => {
      process.env.ATLASMIND_LICENSE_SECRET = TEST_SECRET;

      const expiry = new Date(2030, 0, 5); // Jan 5 2030
      const key = generateLicenseKey('team', 5, expiry);

      expect(key).toContain('ATM-team-5-20300105-');
    });

    it('throws when no signing secret is configured', () => {
      // No ATLASMIND_LICENSE_SECRET or PAT_ENCRYPTION_KEY
      expect(() => generateLicenseKey('team', 5, new Date(2030, 0, 1))).toThrow(
        'No signing secret configured',
      );
    });
  });
});
