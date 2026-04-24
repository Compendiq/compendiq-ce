/**
 * Cached-setting factory (v0.4 epic §3.5).
 *
 * Wraps a row in `admin_settings` behind an in-process cache that invalidates
 * via the cluster-wide cache-bus. Intended for hot-path settings that are
 * read on every request (e.g. IP allowlist, sync-conflict policy) where a
 * per-request DB round-trip would be wasteful.
 *
 * Usage:
 *
 *   const getIpAllowlist = await makeCachedSetting<IpAllowlistConfig>({
 *     key: 'ip_allowlist',
 *     cacheBusChannel: 'ip_allowlist:changed',
 *     parse: (raw) => raw ? { ...DEFAULT, ...JSON.parse(raw) } : DEFAULT,
 *     defaultValue: DEFAULT,
 *   });
 *
 *   // later, on every request:
 *   const cfg = getIpAllowlist();
 *
 * Semantics:
 *   - Cold-load at factory time (async): the returned getter has a fresh
 *     value before any request runs.
 *   - Invalidation via cache-bus: publishers (e.g. admin PUT routes) call
 *     `publish('ip_allowlist:changed', ...)` after writing to Postgres. All
 *     pods re-read on receipt.
 *   - Reconnect recovery: when the cache-bus subscriber reconnects after a
 *     transient disconnect, re-read from DB unconditionally (Redis pub/sub
 *     does not replay missed messages).
 *   - Soft-fail: DB errors during cold-load or re-read are logged; the
 *     cached value stays at the last-known value (or defaultValue on first
 *     failure). The getter never throws.
 */

import { query } from '../db/postgres.js';
import { logger } from '../utils/logger.js';
import { subscribe, onReconnect, type CacheBusChannel } from './redis-cache-bus.js';

export interface CachedSettingOptions<T> {
  key: string;
  cacheBusChannel: CacheBusChannel;
  parse: (raw: string | null) => T;
  defaultValue: T;
}

export async function makeCachedSetting<T>(opts: CachedSettingOptions<T>): Promise<() => T> {
  let cached: T = opts.defaultValue;

  async function loadFromDb(phase: 'cold-load' | 're-read'): Promise<void> {
    try {
      const r = await query<{ setting_value: string }>(
        `SELECT setting_value FROM admin_settings WHERE setting_key = $1`,
        [opts.key],
      );
      const raw = r.rows[0]?.setting_value ?? null;
      try {
        cached = opts.parse(raw);
      } catch (err) {
        logger.warn(
          { err, key: opts.key, phase },
          'cached-setting: parse failed — keeping previous value',
        );
      }
    } catch (err) {
      logger.warn(
        { err, key: opts.key, phase },
        phase === 'cold-load'
          ? 'cached-setting: cold-load failed — using defaultValue'
          : 'cached-setting: re-read failed — keeping previous value',
      );
    }
  }

  await loadFromDb('cold-load');

  subscribe(opts.cacheBusChannel, () => loadFromDb('re-read'));
  onReconnect(() => loadFromDb('re-read'));

  return () => cached;
}
