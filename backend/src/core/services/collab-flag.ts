/**
 * Cached reader for `admin_settings.collab_editing_enabled` (#1444).
 *
 * Same contract as `makeCachedSetting`: cold-load, cache-bus invalidation on
 * `collab:enabled:changed`, reconnect reload, soft-fail default **false**.
 * Every read goes through one serialized, coalesced reloader (#1758), so an
 * older read never overwrites a newer one.
 * Turning the flag off tombstones every in-memory room with 4403.
 */
import { query } from '../db/postgres.js';
import { logger } from '../utils/logger.js';
import { createCoalescedReloader } from './coalesced-reload.js';
import { subscribe, onReconnect } from './redis-cache-bus.js';

const SETTING_KEY = 'collab_editing_enabled';

let cached = false;

function parseFlag(raw: string | null): boolean {
  if (raw === null) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

const reload = createCoalescedReloader<boolean, 'cold-load' | 're-read'>({
  read: async () => {
    const r = await query<{ setting_value: string }>(
      `SELECT setting_value FROM admin_settings WHERE setting_key = $1`,
      [SETTING_KEY],
    );
    return parseFlag(r.rows[0]?.setting_value ?? null);
  },
  apply: (value) => {
    cached = value;
  },
  onFailure: (err, phase) => {
    logger.warn(
      { err, key: SETTING_KEY, phase },
      phase === 'cold-load'
        ? 'collab-flag: cold-load failed — using defaultValue false'
        : 'collab-flag: re-read failed — keeping previous value',
    );
  },
});

export function isCollabEditingEnabled(): boolean {
  return cached;
}

/**
 * Re-read the flag and resolve with it. The read started at or after this
 * call, so a writer that awaits this observes its own row; a failed read
 * yields the previous value. When the result is `false`, every room is
 * tombstoned before this resolves — once per call, outside the serialized
 * reload (`PUT /admin/settings` relies on that before it answers).
 */
export async function refreshCollabFlag(): Promise<boolean> {
  const outcome = await reload('re-read');
  const enabled = outcome.ok ? outcome.value : cached;
  if (!enabled) {
    const { tombstoneAllCollabRooms } = await import('./collab-room-service.js');
    await tombstoneAllCollabRooms(4403, 'flag_off');
  }
  return enabled;
}

export async function initCollabFlag(): Promise<void> {
  await reload('cold-load');
  subscribe('collab:enabled:changed', () => {
    void refreshCollabFlag();
  });
  onReconnect(() => { void refreshCollabFlag(); });
}
