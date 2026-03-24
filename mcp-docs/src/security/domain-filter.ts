/**
 * Domain filter: allowlist/blocklist enforcement.
 * Reads configuration from Redis (set by admin UI via backend).
 */

import type { RedisClientType } from 'redis';
import { logger } from '../logger.js';

export interface DomainConfig {
  mode: 'allowlist' | 'blocklist';
  allowedDomains: string[];
  blockedDomains: string[];
}

const DOMAIN_CONFIG_KEY = 'mcp:docs:config:domains';

const DEFAULT_CONFIG: DomainConfig = {
  mode: 'blocklist',
  allowedDomains: ['*'],
  blockedDomains: [],
};

let cachedConfig: DomainConfig | null = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 30_000; // Re-read from Redis every 30s

export async function getDomainConfig(redis: RedisClientType | null): Promise<DomainConfig> {
  if (cachedConfig && Date.now() < cacheExpiry) return cachedConfig;

  if (!redis) return DEFAULT_CONFIG;

  try {
    const raw = await redis.get(DOMAIN_CONFIG_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Validate structure before trusting Redis data
      if (
        parsed &&
        typeof parsed === 'object' &&
        (parsed.mode === 'allowlist' || parsed.mode === 'blocklist') &&
        Array.isArray(parsed.allowedDomains) &&
        Array.isArray(parsed.blockedDomains)
      ) {
        cachedConfig = parsed as DomainConfig;
      } else {
        logger.warn({ parsed }, 'Invalid domain config in Redis, using defaults');
        cachedConfig = DEFAULT_CONFIG;
      }
    } else {
      cachedConfig = DEFAULT_CONFIG;
    }
    cacheExpiry = Date.now() + CACHE_TTL_MS;
    return cachedConfig;
  } catch (err) {
    logger.error({ err }, 'Failed to read domain config from Redis');
    return cachedConfig ?? DEFAULT_CONFIG;
  }
}

export function isDomainAllowed(hostname: string, config: DomainConfig): boolean {
  const domain = hostname.toLowerCase();

  if (config.mode === 'blocklist') {
    // Block mode: everything allowed except blocked domains
    return !config.blockedDomains.some((b) => matchesDomain(domain, b.toLowerCase()));
  }

  // Allowlist mode: only allowed domains
  return config.allowedDomains.some((a) => matchesDomain(domain, a.toLowerCase()));
}

function matchesDomain(hostname: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(2);
    return hostname === suffix || hostname.endsWith('.' + suffix);
  }
  return hostname === pattern;
}

/** Reset cached config (for tests). */
export function resetDomainConfigCache(): void {
  cachedConfig = null;
  cacheExpiry = 0;
}
