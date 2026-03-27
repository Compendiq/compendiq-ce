import { createHmac, timingSafeEqual } from 'node:crypto';
import { logger } from '../core/utils/logger.js';
import type { LicenseInfo, LicenseTier } from './types.js';

const VALID_TIERS: LicenseTier[] = ['team', 'business', 'enterprise'];

let cachedLicense: LicenseInfo | null = null;

function getSigningSecret(): string {
  return process.env.ATLASMIND_LICENSE_SECRET ?? process.env.PAT_ENCRYPTION_KEY ?? '';
}

function verifySignature(data: string, signature: string, secret: string): boolean {
  const expected = createHmac('sha256', secret).update(data).digest('hex');
  if (signature.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}

function communityLicense(raw: string | null = null): LicenseInfo {
  return {
    tier: 'community',
    seats: 0,
    expiry: new Date(0),
    isValid: false,
    isExpired: false,
    raw,
  };
}

function parseLicenseKey(key: string): LicenseInfo {
  // Format: ATM-{tier}-{seats}-{expiryYYYYMMDD}-{signature}
  const parts = key.split('-');
  // ATM is parts[0], tier is parts[1], seats is parts[2], expiry is parts[3], signature is parts[4]
  if (parts.length !== 5 || parts[0] !== 'ATM') {
    return communityLicense(key);
  }

  const tierStr = parts[1].toLowerCase();
  if (!VALID_TIERS.includes(tierStr as LicenseTier)) {
    return communityLicense(key);
  }
  const tier = tierStr as Exclude<LicenseTier, 'community'>;

  const seats = parseInt(parts[2], 10);
  if (isNaN(seats) || seats <= 0) {
    return communityLicense(key);
  }

  const expiryStr = parts[3];
  if (!/^\d{8}$/.test(expiryStr)) {
    return communityLicense(key);
  }
  const expiry = new Date(
    parseInt(expiryStr.slice(0, 4), 10),
    parseInt(expiryStr.slice(4, 6), 10) - 1,
    parseInt(expiryStr.slice(6, 8), 10),
    23, 59, 59, 999,
  );
  if (isNaN(expiry.getTime())) {
    return communityLicense(key);
  }

  const signature = parts[4];
  const dataToVerify = `ATM-${parts[1]}-${parts[2]}-${parts[3]}`;
  const secret = getSigningSecret();

  if (!secret || !verifySignature(dataToVerify, signature, secret)) {
    logger.warn('Invalid license key signature — running in Community mode');
    return communityLicense(key);
  }

  const isExpired = expiry < new Date();
  if (isExpired) {
    logger.warn({ expiry: expiryStr }, 'License key expired — running in Community mode');
  }

  return {
    tier: isExpired ? 'community' : tier,
    seats,
    expiry,
    isValid: !isExpired,
    isExpired,
    raw: key,
  };
}

export function getLicenseInfo(): LicenseInfo {
  if (cachedLicense) return cachedLicense;

  const key = process.env.ATLASMIND_LICENSE_KEY;
  if (!key) {
    cachedLicense = communityLicense();
    return cachedLicense;
  }

  cachedLicense = parseLicenseKey(key.trim());
  return cachedLicense;
}

export function isEnterprise(): boolean {
  return getLicenseInfo().tier !== 'community';
}

/** Reset cache — useful for testing */
export function _resetLicenseCache(): void {
  cachedLicense = null;
}

