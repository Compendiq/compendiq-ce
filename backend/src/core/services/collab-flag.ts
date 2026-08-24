/**
 * Cached reader for `admin_settings.collab_editing_enabled` (#1444).
 *
 * Same contract as `makeCachedSetting`: cold-load, cache-bus invalidation on
 * `collab:enabled:changed`, reconnect reload, soft-fail default **false**.
 * Turning the flag off tombstones every in-memory room with 4403.
 */
import { query } from '../db/postgres.js';
import { logger } from '../utils/logger.js';
import { subscribe, onReconnect } from './redis-cache-bus.js';

const SETTING_KEY = 'collab_editing_enabled';

let cached = false;

function parseFlag(raw: string | null): boolean {
  if (raw === null) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

async function loadFromDb(phase: 'cold-load' | 're-read'): Promise<boolean> {
  try {
    const r = await query<{ setting_value: string }>(
      `SELECT setting_value FROM admin_settings WHERE setting_key = $1`,
      [SETTING_KEY],
    );
    cached = parseFlag(r.rows[0]?.setting_value ?? null);
  } catch (err) {
    logger.warn(
      { err, key: SETTING_KEY, phase },
      phase === 'cold-load'
        ? 'collab-flag: cold-load failed — using defaultValue false'
        : 'collab-flag: re-read failed — keeping previous value',
    );
  }
  return cached;
}

export function isCollabEditingEnabled(): boolean {
  return cached;
}

export async function refreshCollabFlag(): Promise<boolean> {
  const enabled = await loadFromDb('re-read');
  if (!enabled) {
    const { tombstoneAllCollabRooms } = await import('./collab-room-service.js');
    await tombstoneAllCollabRooms(4403, 'flag_off');
  }
  return enabled;
}

export async function initCollabFlag(): Promise<void> {
  await loadFromDb('cold-load');
  subscribe('collab:enabled:changed', () => {
    void refreshCollabFlag();
  });
  onReconnect(() => { void loadFromDb('re-read'); });
}
