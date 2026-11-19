/**
 * MCP Docs admin settings — stored in admin_settings table.
 * Same pattern as admin-settings-service.ts for LLM settings.
 */

import {
  MCP_DOCS_CACHE_TTL_DEFAULT,
  MCP_DOCS_CACHE_TTL_MAX,
  MCP_DOCS_CACHE_TTL_MIN,
  MCP_DOCS_MAX_CONTENT_LENGTH_DEFAULT,
  MCP_DOCS_MAX_CONTENT_LENGTH_MAX,
  MCP_DOCS_MAX_CONTENT_LENGTH_MIN,
} from '@compendiq/contracts';
import { query, getPool } from '../db/postgres.js';
import { logger } from '../utils/logger.js';

interface McpDocsSettings {
  enabled: boolean;
  url: string;
  domainMode: 'allowlist' | 'blocklist';
  allowedDomains: string[];
  blockedDomains: string[];
  /** Seconds a fetched document stays cached in the sidecar; sent per fetch_url call as `cache_ttl` (#1769). */
  cacheTtl: number;
  /** Ceiling on every fetch_url `max_length` the backend sends; equals the sidecar's hard cap (#1769). */
  maxContentLength: number;
}

const DEFAULTS: McpDocsSettings = {
  enabled: false,
  url: process.env.MCP_DOCS_URL ?? 'http://mcp-docs:3100/mcp',
  domainMode: 'blocklist',
  allowedDomains: ['*'],
  blockedDomains: [],
  cacheTtl: MCP_DOCS_CACHE_TTL_DEFAULT,
  maxContentLength: MCP_DOCS_MAX_CONTENT_LENGTH_DEFAULT,
};

const MCP_SETTING_KEYS = [
  'mcp_docs_enabled',
  'mcp_docs_url',
  'mcp_docs_domain_mode',
  'mcp_docs_allowed_domains',
  'mcp_docs_blocked_domains',
  'mcp_docs_cache_ttl',
  'mcp_docs_max_content_length',
] as const;

type McpSettingKey = (typeof MCP_SETTING_KEYS)[number];

async function getSettingsMap(): Promise<Record<string, string>> {
  const result = await query<{ setting_key: string; setting_value: string }>(
    `SELECT setting_key, setting_value
     FROM admin_settings
     WHERE setting_key = ANY($1::text[])`,
    [MCP_SETTING_KEYS as unknown as string[]],
  );
  const map: Record<string, string> = {};
  for (const row of result.rows) {
    map[row.setting_key] = row.setting_value;
  }
  return map;
}

/**
 * Parse a stored JSON string-array setting, falling back to `fallback` (and
 * logging) when the value is absent or corrupt. A bad domain list must not
 * disable the whole feature, so this is scoped per-field rather than wrapping
 * the entire settings load in one try/catch.
 */
function parseDomainList(raw: string | undefined, fallback: string[]): string[] {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((d) => typeof d === 'string')) {
      return parsed;
    }
    logger.warn('MCP docs domain list is not a string array, using default for this field');
    return fallback;
  } catch (err) {
    logger.warn({ err }, 'Invalid MCP docs domain list JSON, using default for this field');
    return fallback;
  }
}

/**
 * Effective value of a stored integer setting that is forwarded to the sidecar
 * as a tool argument. A row outside the tool's range (a pre-#1769
 * `mcp_docs_max_content_length` of up to 500 000, or a row written by hand)
 * would make the sidecar reject every call with -32602, so it is clamped on
 * read and logged until the operator re-saves; non-numeric → default.
 */
function normalizeStoredInt(
  key: McpSettingKey,
  stored: string | undefined,
  range: { min: number; max: number; fallback: number },
): number {
  if (stored === undefined) return range.fallback;
  const parsed = parseInt(stored, 10);
  if (!Number.isFinite(parsed)) {
    logger.warn({ key, stored }, 'MCP docs setting is not a number — using the default; re-save MCP Docs settings');
    return range.fallback;
  }
  const effective = Math.min(range.max, Math.max(range.min, parsed));
  if (effective !== parsed) {
    logger.warn(
      { key, stored, effective },
      'MCP docs setting is outside the sidecar range — clamped; re-save MCP Docs settings',
    );
  }
  return effective;
}

export async function getMcpDocsSettings(): Promise<McpDocsSettings> {
  try {
    const settings = await getSettingsMap();
    return {
      enabled: settings['mcp_docs_enabled'] === 'true',
      url: settings['mcp_docs_url'] ?? DEFAULTS.url,
      domainMode: (settings['mcp_docs_domain_mode'] as 'allowlist' | 'blocklist') ?? DEFAULTS.domainMode,
      allowedDomains: parseDomainList(settings['mcp_docs_allowed_domains'], DEFAULTS.allowedDomains),
      blockedDomains: parseDomainList(settings['mcp_docs_blocked_domains'], DEFAULTS.blockedDomains),
      cacheTtl: normalizeStoredInt('mcp_docs_cache_ttl', settings['mcp_docs_cache_ttl'], {
        min: MCP_DOCS_CACHE_TTL_MIN, max: MCP_DOCS_CACHE_TTL_MAX, fallback: DEFAULTS.cacheTtl,
      }),
      maxContentLength: normalizeStoredInt('mcp_docs_max_content_length', settings['mcp_docs_max_content_length'], {
        min: MCP_DOCS_MAX_CONTENT_LENGTH_MIN, max: MCP_DOCS_MAX_CONTENT_LENGTH_MAX, fallback: DEFAULTS.maxContentLength,
      }),
    };
  } catch (err) {
    logger.warn({ err }, 'Failed to load MCP docs settings, using defaults');
    return DEFAULTS;
  }
}

export async function upsertMcpDocsSettings(
  updates: Partial<McpDocsSettings>,
): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');

    const rows: Array<{ key: McpSettingKey; value: string }> = [];

    if (updates.enabled !== undefined) {
      rows.push({ key: 'mcp_docs_enabled', value: String(updates.enabled) });
    }
    if (updates.url !== undefined) {
      rows.push({ key: 'mcp_docs_url', value: updates.url });
    }
    if (updates.domainMode !== undefined) {
      rows.push({ key: 'mcp_docs_domain_mode', value: updates.domainMode });
    }
    if (updates.allowedDomains !== undefined) {
      rows.push({ key: 'mcp_docs_allowed_domains', value: JSON.stringify(updates.allowedDomains) });
    }
    if (updates.blockedDomains !== undefined) {
      rows.push({ key: 'mcp_docs_blocked_domains', value: JSON.stringify(updates.blockedDomains) });
    }
    if (updates.cacheTtl !== undefined) {
      rows.push({ key: 'mcp_docs_cache_ttl', value: String(updates.cacheTtl) });
    }
    if (updates.maxContentLength !== undefined) {
      rows.push({ key: 'mcp_docs_max_content_length', value: String(updates.maxContentLength) });
    }

    for (const row of rows) {
      await client.query(
        `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (setting_key) DO UPDATE SET setting_value = $2, updated_at = NOW()`,
        [row.key, row.value],
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // Push domain config to Redis for the sidecar to read
  await pushDomainConfigToRedis();
}

/**
 * Push domain config to Redis so the sidecar can read it.
 * Uses the same Redis key the sidecar's domain-filter reads.
 */
async function pushDomainConfigToRedis(): Promise<void> {
  try {
    // Import dynamically to avoid circular deps with redis initialization
    const { getRedisClient } = await import('./redis-cache.js');
    const redis = getRedisClient();
    if (!redis) return;

    const settings = await getMcpDocsSettings();
    const config = {
      mode: settings.domainMode,
      allowedDomains: settings.allowedDomains,
      blockedDomains: settings.blockedDomains,
    };
    await redis.set('mcp:docs:config:domains', JSON.stringify(config));
    logger.debug('Pushed MCP domain config to Redis');
  } catch (err) {
    logger.warn({ err }, 'Failed to push domain config to Redis');
  }
}
