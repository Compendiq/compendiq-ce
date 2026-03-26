import { query } from '../db/postgres.js';
import { logAuditEvent } from './audit-service.js';

// ─── Rate limit categories ────────────────────────────────────────────────────

export interface RateLimitConfig {
  max: number;
  timeWindow: string;
}

export interface RateLimits {
  global: RateLimitConfig;
  auth: RateLimitConfig;
  admin: RateLimitConfig;
  llmStream: RateLimitConfig;
  llmEmbedding: RateLimitConfig;
  oidc: RateLimitConfig;
}

// ─── Defaults (hardcoded fallbacks) ───────────────────────────────────────────

const DEFAULTS: RateLimits = {
  global:       { max: 100, timeWindow: '1 minute' },
  auth:         { max: 5,   timeWindow: '1 minute' },
  admin:        { max: 20,  timeWindow: '1 minute' },
  llmStream:    { max: 10,  timeWindow: '1 minute' },
  llmEmbedding: { max: 5,   timeWindow: '1 minute' },
  oidc:         { max: 10,  timeWindow: '1 minute' },
};

// Security floor: auth rate limits cannot go below this to prevent brute-force
const AUTH_MIN_FLOOR = 3;

// ─── DB keys ──────────────────────────────────────────────────────────────────

const RATE_LIMIT_KEYS = [
  'rate_limit_global_max',
  'rate_limit_auth_max',
  'rate_limit_admin_max',
  'rate_limit_llm_stream_max',
  'rate_limit_llm_embedding_max',
  'rate_limit_oidc_max',
] as const;

// ─── In-process TTL cache ─────────────────────────────────────────────────────

const CACHE_TTL_MS = 60_000;
let cache: { value: RateLimits; expiresAt: number } | null = null;

// ─── Getter ───────────────────────────────────────────────────────────────────

export async function getRateLimits(): Promise<RateLimits> {
  if (cache && Date.now() < cache.expiresAt) {
    return cache.value;
  }

  const result = await query<{ setting_key: string; setting_value: string }>(
    `SELECT setting_key, setting_value FROM admin_settings WHERE setting_key = ANY($1::text[])`,
    [RATE_LIMIT_KEYS as unknown as string[]],
  );

  const map: Record<string, string> = {};
  for (const row of result.rows) {
    map[row.setting_key] = row.setting_value;
  }

  const value: RateLimits = {
    global:       { max: parseInt(map['rate_limit_global_max'] ?? '', 10) || DEFAULTS.global.max, timeWindow: '1 minute' },
    auth:         { max: Math.max(AUTH_MIN_FLOOR, parseInt(map['rate_limit_auth_max'] ?? '', 10) || DEFAULTS.auth.max), timeWindow: '1 minute' },
    admin:        { max: parseInt(map['rate_limit_admin_max'] ?? '', 10) || DEFAULTS.admin.max, timeWindow: '1 minute' },
    llmStream:    { max: parseInt(map['rate_limit_llm_stream_max'] ?? '', 10) || DEFAULTS.llmStream.max, timeWindow: '1 minute' },
    llmEmbedding: { max: parseInt(map['rate_limit_llm_embedding_max'] ?? '', 10) || DEFAULTS.llmEmbedding.max, timeWindow: '1 minute' },
    oidc:         { max: parseInt(map['rate_limit_oidc_max'] ?? '', 10) || DEFAULTS.oidc.max, timeWindow: '1 minute' },
  };

  cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

// ─── Setter ───────────────────────────────────────────────────────────────────

export type RateLimitUpdate = Partial<Record<keyof RateLimits, number>>;

const KEY_MAP: Record<keyof RateLimits, string> = {
  global: 'rate_limit_global_max',
  auth: 'rate_limit_auth_max',
  admin: 'rate_limit_admin_max',
  llmStream: 'rate_limit_llm_stream_max',
  llmEmbedding: 'rate_limit_llm_embedding_max',
  oidc: 'rate_limit_oidc_max',
};

export async function upsertRateLimits(updates: RateLimitUpdate, userId?: string): Promise<void> {
  // Enforce auth floor
  if (updates.auth !== undefined && updates.auth < AUTH_MIN_FLOOR) {
    updates.auth = AUTH_MIN_FLOOR;
  }

  for (const [category, max] of Object.entries(updates)) {
    if (max === undefined) continue;
    const key = KEY_MAP[category as keyof RateLimits];
    if (!key) continue;

    await query(
      `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (setting_key) DO UPDATE SET setting_value = $2, updated_at = NOW()`,
      [key, String(max)],
    );
  }

  // Invalidate cache
  cache = null;

  if (userId) {
    await logAuditEvent(
      userId,
      'ADMIN_ACTION',
      'admin_settings',
      undefined,
      { action: 'update_rate_limits', changedCategories: Object.keys(updates) },
    );
  }
}

/** Exposed for testing */
export function _resetCache(): void {
  cache = null;
}
