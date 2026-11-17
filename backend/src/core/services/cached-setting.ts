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
 *   - Serialized and coalesced (#1758): every read goes through one
 *     `createCoalescedReloader`, so overlapping bus events and reconnects
 *     never let an older read overwrite a newer one; a read that hangs is
 *     abandoned after RELOAD_READ_TIMEOUT_MS and never applied.
 */

import { query } from '../db/postgres.js';
import { logger } from '../utils/logger.js';
import { createCoalescedReloader } from './coalesced-reload.js';
import { subscribe, onReconnect, type CacheBusChannel } from './redis-cache-bus.js';

interface CachedSettingOptions<T> {
  key: string;
  cacheBusChannel: CacheBusChannel;
  parse: (raw: string | null) => T;
  defaultValue: T;
}

/** A `parse` error, kept apart from a failed SELECT so each keeps its own log line. */
class ParseFailure {
  constructor(readonly err: unknown) {}
}

export async function makeCachedSetting<T>(opts: CachedSettingOptions<T>): Promise<() => T> {
  let cached: T = opts.defaultValue;

  const reload = createCoalescedReloader<T, 'cold-load' | 're-read'>({
    read: async () => {
      const r = await query<{ setting_value: string }>(
        `SELECT setting_value FROM admin_settings WHERE setting_key = $1`,
        [opts.key],
      );
      const raw = r.rows[0]?.setting_value ?? null;
      try {
        return opts.parse(raw);
      } catch (err) {
        throw new ParseFailure(err);
      }
    },
    apply: (value) => {
      cached = value;
    },
    onFailure: (err, phase) => {
      if (err instanceof ParseFailure) {
        logger.warn(
          { err: err.err, key: opts.key, phase },
          'cached-setting: parse failed — keeping previous value',
        );
        return;
      }
      logger.warn(
        { err, key: opts.key, phase },
        phase === 'cold-load'
          ? 'cached-setting: cold-load failed — using defaultValue'
          : 'cached-setting: re-read failed — keeping previous value',
      );
    },
  });

  await reload('cold-load');

  subscribe(opts.cacheBusChannel, async () => { await reload('re-read'); });
  onReconnect(async () => { await reload('re-read'); });

  return () => cached;
}
