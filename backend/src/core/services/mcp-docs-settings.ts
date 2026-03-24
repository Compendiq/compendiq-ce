/**
 * MCP Docs admin settings — stored in admin_settings table.
 * Same pattern as admin-settings-service.ts for LLM settings.
 */

import { query, getPool } from '../db/postgres.js';
import { logger } from '../utils/logger.js';

export interface McpDocsSettings {
  enabled: boolean;
  url: string;
  domainMode: 'allowlist' | 'blocklist';
  allowedDomains: string[];
  blockedDomains: string[];
  cacheTtl: number;
  maxContentLength: number;
}

const DEFAULTS: McpDocsSettings = {
  enabled: false,
  url: process.env.MCP_DOCS_URL ?? 'http://mcp-docs:3100/mcp',
  domainMode: 'blocklist',
  allowedDomains: ['*'],
  blockedDomains: [],
  cacheTtl: 3600,
  maxContentLength: 50_000,
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

export async function getMcpDocsSettings(): Promise<McpDocsSettings> {
  try {
    const settings = await getSettingsMap();
    return {
      enabled: settings['mcp_docs_enabled'] === 'true',
      url: settings['mcp_docs_url'] ?? DEFAULTS.url,
      domainMode: (settings['mcp_docs_domain_mode'] as 'allowlist' | 'blocklist') ?? DEFAULTS.domainMode,
      allowedDomains: settings['mcp_docs_allowed_domains']
        ? JSON.parse(settings['mcp_docs_allowed_domains'])
        : DEFAULTS.allowedDomains,
      blockedDomains: settings['mcp_docs_blocked_domains']
        ? JSON.parse(settings['mcp_docs_blocked_domains'])
        : DEFAULTS.blockedDomains,
      cacheTtl: parseInt(settings['mcp_docs_cache_ttl'] ?? String(DEFAULTS.cacheTtl), 10),
      maxContentLength: parseInt(settings['mcp_docs_max_content_length'] ?? String(DEFAULTS.maxContentLength), 10),
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
