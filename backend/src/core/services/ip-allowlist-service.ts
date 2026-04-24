/**
 * IP-allowlist service (EE #111).
 *
 * Wraps an `admin_settings.ip_allowlist` JSONB singleton behind an in-process
 * cache that invalidates cluster-wide via the generic cache-bus (epic §3.1).
 *
 * Exposes three domain predicates that the onRequest hook uses on every
 * request (all sync, all O(≤10)):
 *   - isAllowed(addr)     — false iff feature enabled + addr outside CIDRs
 *   - isTrustedProxy(addr) — addr is inside the trusted_proxies list
 *   - isExemptPath(path)   — request path matches an exception prefix
 *
 * Plus the update path:
 *   - updateConfig(next, actor, req?)  — DB upsert + cache-bus publish + audit
 *
 * Plus a bootstrap read used by `app.ts` at Fastify construction:
 *   - loadTrustedProxiesFromAdminSettings()  — non-throwing one-shot read
 *
 * Safety notes:
 *   - Malformed CIDRs in the persisted config are silently dropped (via
 *     `parseCidrSafe`) so a typo cannot lock admins out or crash the service.
 *   - IPv4-mapped-IPv6 peers (`::ffff:a.b.c.d`) are normalised via
 *     `ipaddr.process()` inside `matchesAny` — this is the canonical
 *     allowlist-bypass guard (research cluster-1 item #1).
 *   - The service returns safe defaults if called before `initIpAllowlistService()`
 *     to avoid accidentally blocking traffic because startup order shifts.
 */

import { query } from '../db/postgres.js';
import { publish } from './redis-cache-bus.js';
import { makeCachedSetting } from './cached-setting.js';
import { logAuditEvent } from './audit-service.js';
import { parseCidrSafe, matchesAny, type ParsedCidr } from '../utils/trusted-proxy.js';
import type { FastifyRequest } from 'fastify';

export interface IpAllowlistConfig {
  enabled: boolean;
  cidrs: string[];
  trustedProxies: string[];
  exceptions: string[];
}

export const DEFAULT_IP_ALLOWLIST_CONFIG: IpAllowlistConfig = {
  enabled: false,
  cidrs: [],
  trustedProxies: ['127.0.0.1/32', '::1/128'],
  exceptions: ['/api/health', '/api/admin/license', '/api/auth/'],
};

let getConfig: (() => IpAllowlistConfig) | null = null;

// Memoised parsed CIDRs. Invalidated by reference check against the last
// config snapshot — `makeCachedSetting` returns a new object on each re-read,
// so reference identity is enough to detect changes without extra bookkeeping.
let cfgRef: IpAllowlistConfig | null = null;
let allowParsed: ParsedCidr[] = [];
let trustParsed: ParsedCidr[] = [];

function reparseIfStale(cfg: IpAllowlistConfig): void {
  if (cfg === cfgRef) return;
  cfgRef = cfg;
  allowParsed = cfg.cidrs
    .map(parseCidrSafe)
    .filter((c): c is ParsedCidr => c !== null);
  trustParsed = cfg.trustedProxies
    .map(parseCidrSafe)
    .filter((c): c is ParsedCidr => c !== null);
}

function currentConfig(): IpAllowlistConfig {
  return getConfig ? getConfig() : DEFAULT_IP_ALLOWLIST_CONFIG;
}

function parseRawConfig(raw: string | null): IpAllowlistConfig {
  if (!raw) return DEFAULT_IP_ALLOWLIST_CONFIG;
  try {
    const parsed = JSON.parse(raw) as Partial<IpAllowlistConfig>;
    return { ...DEFAULT_IP_ALLOWLIST_CONFIG, ...parsed };
  } catch {
    return DEFAULT_IP_ALLOWLIST_CONFIG;
  }
}

/**
 * Initialise the service: cold-load from admin_settings, subscribe to the
 * cache-bus, wire a reconnect handler. Must be called once at app startup,
 * AFTER the cache-bus has been initialised.
 *
 * Idempotent across re-calls in tests (the underlying `makeCachedSetting`
 * starts fresh each time because tests reset the mocks).
 */
export async function initIpAllowlistService(): Promise<void> {
  getConfig = await makeCachedSetting<IpAllowlistConfig>({
    key: 'ip_allowlist',
    cacheBusChannel: 'ip_allowlist:changed',
    parse: parseRawConfig,
    defaultValue: DEFAULT_IP_ALLOWLIST_CONFIG,
  });
  // Prime the parsed-CIDR caches with the cold-loaded value.
  reparseIfStale(currentConfig());
}

export function isAllowed(rawAddr: string): boolean {
  const cfg = currentConfig();
  if (!cfg.enabled) return true;
  reparseIfStale(cfg);
  return matchesAny(rawAddr, allowParsed);
}

export function isTrustedProxy(rawAddr: string): boolean {
  const cfg = currentConfig();
  reparseIfStale(cfg);
  return matchesAny(rawAddr, trustParsed);
}

export function isExemptPath(pathname: string): boolean {
  const cfg = currentConfig();
  for (const prefix of cfg.exceptions) {
    if (pathname === prefix) return true;
    if (prefix.endsWith('/') && pathname.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Persist a new config, broadcast the invalidation, and record an audit event.
 *
 * `request` is passed through to `logAuditEvent` so the audit row captures
 * the admin's IP and user-agent; it's optional so tests and non-HTTP callers
 * can use the function without constructing a fake request.
 */
export async function updateConfig(
  next: IpAllowlistConfig,
  actorUserId: string,
  request?: FastifyRequest,
): Promise<void> {
  const previous = currentConfig();

  await query(
    `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
     VALUES ('ip_allowlist', $1, NOW())
     ON CONFLICT (setting_key)
     DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = NOW()`,
    [JSON.stringify(next)],
  );

  await publish('ip_allowlist:changed', { at: Date.now() });

  await logAuditEvent(
    actorUserId,
    'IP_ALLOWLIST_CHANGED',
    'admin_settings',
    'ip_allowlist',
    { previous, next },
    request,
  );
}

/**
 * Fresh DB read of the persisted config used by the admin REST routes
 * (EE #111 Phase D). Unlike `isAllowed`/`isTrustedProxy`/`isExemptPath`,
 * the admin GET/PUT/test endpoints are cold paths — they must return the
 * authoritative persisted value regardless of whether
 * `initIpAllowlistService` has run yet (Phase D lands the routes; the
 * service init is wired in Phase E). Falls back to the default config if
 * the row is absent or the DB call fails.
 */
export async function getPersistedConfig(): Promise<IpAllowlistConfig> {
  try {
    const r = await query<{ setting_value: string }>(
      `SELECT setting_value FROM admin_settings WHERE setting_key = 'ip_allowlist'`,
    );
    return parseRawConfig(r.rows[0]?.setting_value ?? null);
  } catch {
    return DEFAULT_IP_ALLOWLIST_CONFIG;
  }
}

/**
 * One-shot bootstrap read used by `app.ts` at Fastify construction to pick
 * the initial `trustProxy` CIDRs. Runs BEFORE the cache-bus is up and
 * BEFORE `initIpAllowlistService`; must never throw (startup must not fail
 * because admin_settings is missing or the DB is flaky for a moment).
 */
export async function loadTrustedProxiesFromAdminSettings(): Promise<string[]> {
  try {
    const r = await query<{ setting_value: string }>(
      `SELECT setting_value FROM admin_settings WHERE setting_key = 'ip_allowlist'`,
    );
    const raw = r.rows[0]?.setting_value ?? null;
    return parseRawConfig(raw).trustedProxies;
  } catch {
    return DEFAULT_IP_ALLOWLIST_CONFIG.trustedProxies;
  }
}

// Test seam: reset module state between tests. Keeps the mocks' assertion
// counts accurate without leaking cached config across cases.
export function _resetForTests(): void {
  getConfig = null;
  cfgRef = null;
  allowParsed = [];
  trustParsed = [];
}
