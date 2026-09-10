/**
 * Per-user Notion import job status.
 *
 * `POST /api/notion/import` must not wait for paced Notion traffic: nginx
 * caps `/api/` at `proxy_read_timeout 300`, and closing that connection
 * cancels nothing. Status is Redis-backed with an in-memory fallback so a
 * single-process test or a Redis blip still answers GET.
 *
 * `importing` is not a 24h mutex. A separate lock key uses SET NX plus a
 * 10-minute safety TTL (same shape as Confluence `SYNC_LOCK_TTL`). Renew,
 * release, and terminal status writes are Lua compare-and-swap on that token
 * — a lapsed walk must not extend, delete, or overwrite a newer run. Redis
 * SET NX throwing fail-closes. A missing Redis status key is idle — leftover
 * memory must not 409 after the TTL.
 */
import { randomUUID } from 'node:crypto';
import type { NotionImportItem } from '@compendiq/contracts';
import { getRedisClient } from '../../../core/services/redis-cache.js';
import { logger } from '../../../core/utils/logger.js';

const STATUS_PREFIX = 'notion:import:status:';
const LOCK_PREFIX = 'notion:import:lock:';
const STATUS_TTL_SEC = 24 * 60 * 60;
/** Safety TTL; heartbeat slides it forward for a long Knowledge Base walk. */
export const NOTION_IMPORT_LOCK_TTL_SEC = 600;
const LOCK_RENEW_INTERVAL_MS = Math.floor((NOTION_IMPORT_LOCK_TTL_SEC / 3) * 1000);

/** Lua: only delete the lock if the caller owns it (value matches). */
const RELEASE_LOCK_SCRIPT =
  `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

/** Lua: only extend lock + importing-status TTL while this caller still owns the lock. */
const RENEW_LOCK_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then redis.call("expire", KEYS[1], ARGV[2]) redis.call("expire", KEYS[2], ARGV[2]) return 1 else return 0 end`;

/** Lua: write complete/error only while this caller still owns the lock. */
const WRITE_STATUS_IF_OWNED_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then redis.call("set", KEYS[2], ARGV[2], "EX", ARGV[3]) return 1 else return 0 end`;

export type NotionImportJobStatus =
  | { status: 'idle' }
  | { status: 'importing' }
  | { status: 'complete'; items: NotionImportItem[] }
  | { status: 'error'; error: string };

type LocalLock = { token: string; expiresAt: number };

const localStatus = new Map<string, NotionImportJobStatus>();
const localLocks = new Map<string, LocalLock>();

function statusKey(userId: string): string {
  return `${STATUS_PREFIX}${userId}`;
}

function lockKey(userId: string): string {
  return `${LOCK_PREFIX}${userId}`;
}

function ttlFor(status: NotionImportJobStatus): number {
  return status.status === 'importing' ? NOTION_IMPORT_LOCK_TTL_SEC : STATUS_TTL_SEC;
}

function localLockHeld(userId: string): boolean {
  const lock = localLocks.get(userId);
  if (!lock) return false;
  if (lock.expiresAt <= Date.now()) {
    localLocks.delete(userId);
    return false;
  }
  return true;
}

function memoryStatus(userId: string): NotionImportJobStatus {
  if (localLockHeld(userId)) return { status: 'importing' };
  const stored = localStatus.get(userId);
  if (!stored || stored.status === 'importing') {
    localStatus.delete(userId);
    return { status: 'idle' };
  }
  return stored;
}

export async function getNotionImportStatus(userId: string): Promise<NotionImportJobStatus> {
  const redis = getRedisClient();
  if (redis) {
    try {
      const [lock, raw] = await Promise.all([redis.get(lockKey(userId)), redis.get(statusKey(userId))]);
      if (lock) {
        const importing = { status: 'importing' as const };
        localStatus.set(userId, importing);
        localLocks.set(userId, {
          token: lock,
          expiresAt: Date.now() + NOTION_IMPORT_LOCK_TTL_SEC * 1000,
        });
        return importing;
      }
      if (raw) {
        const parsed = JSON.parse(raw) as NotionImportJobStatus;
        if (parsed.status === 'importing') {
          localStatus.delete(userId);
          localLocks.delete(userId);
          try {
            await redis.del(statusKey(userId));
          } catch (err) {
            logger.error({ err, userId }, 'Failed to drop stale Notion import status');
          }
          return { status: 'idle' };
        }
        localStatus.set(userId, parsed);
        localLocks.delete(userId);
        return parsed;
      }
      localStatus.delete(userId);
      localLocks.delete(userId);
      return { status: 'idle' };
    } catch (err) {
      logger.error({ err, userId }, 'Failed to read Notion import status from Redis');
    }
  }
  return memoryStatus(userId);
}

export async function tryStartNotionImport(userId: string): Promise<string | null> {
  const token = randomUUID();
  const redis = getRedisClient();
  if (redis) {
    try {
      const result = await redis.set(lockKey(userId), token, {
        NX: true,
        EX: NOTION_IMPORT_LOCK_TTL_SEC,
      });
      if (result === null) return null;
      await writeStatus(userId, { status: 'importing' });
      localLocks.set(userId, { token, expiresAt: Date.now() + NOTION_IMPORT_LOCK_TTL_SEC * 1000 });
      return token;
    } catch (err) {
      logger.error({ err, userId }, 'Failed to acquire Notion import lock');
      return null;
    }
  }
  if (localLockHeld(userId)) return null;
  localLocks.set(userId, { token, expiresAt: Date.now() + NOTION_IMPORT_LOCK_TTL_SEC * 1000 });
  localStatus.set(userId, { status: 'importing' });
  return token;
}

export async function setNotionImportStatus(
  userId: string,
  status: NotionImportJobStatus,
  token?: string,
): Promise<boolean> {
  if (status.status !== 'importing' && token !== undefined) {
    return writeStatusIfOwned(userId, status, token);
  }
  if (status.status !== 'importing') {
    localLocks.delete(userId);
  } else if (!localLockHeld(userId)) {
    localLocks.set(userId, {
      token: randomUUID(),
      expiresAt: Date.now() + NOTION_IMPORT_LOCK_TTL_SEC * 1000,
    });
  }
  await writeStatus(userId, status);
  return true;
}

async function writeStatus(userId: string, status: NotionImportJobStatus): Promise<void> {
  localStatus.set(userId, status);
  const redis = getRedisClient();
  if (!redis) return;
  try {
    await redis.set(statusKey(userId), JSON.stringify(status), { EX: ttlFor(status) });
  } catch (err) {
    logger.error({ err, userId }, 'Failed to write Notion import status to Redis');
  }
}

/** Write complete/error only while `token` still owns the lock. */
async function writeStatusIfOwned(
  userId: string,
  status: NotionImportJobStatus,
  token: string,
): Promise<boolean> {
  const redis = getRedisClient();
  if (redis) {
    try {
      const result = await redis.eval(WRITE_STATUS_IF_OWNED_SCRIPT, {
        keys: [lockKey(userId), statusKey(userId)],
        arguments: [token, JSON.stringify(status), String(ttlFor(status))],
      });
      if (result === 1 || result === '1') {
        localStatus.set(userId, status);
        return true;
      }
      return false;
    } catch (err) {
      logger.error({ err, userId }, 'Failed to write Notion import status to Redis');
    }
  }
  const lock = localLocks.get(userId);
  if (!lock || lock.token !== token || lock.expiresAt <= Date.now()) return false;
  localStatus.set(userId, status);
  return true;
}

export async function renewNotionImportLock(userId: string, token: string): Promise<void> {
  const redis = getRedisClient();
  if (redis) {
    try {
      const result = await redis.eval(RENEW_LOCK_SCRIPT, {
        keys: [lockKey(userId), statusKey(userId)],
        arguments: [token, String(NOTION_IMPORT_LOCK_TTL_SEC)],
      });
      if (result === 1 || result === '1') {
        const lock = localLocks.get(userId);
        if (lock?.token === token) {
          lock.expiresAt = Date.now() + NOTION_IMPORT_LOCK_TTL_SEC * 1000;
        }
      }
    } catch (err) {
      logger.error({ err, userId }, 'Failed to renew Notion import lock');
    }
    return;
  }
  const lock = localLocks.get(userId);
  if (lock?.token === token) {
    lock.expiresAt = Date.now() + NOTION_IMPORT_LOCK_TTL_SEC * 1000;
  }
}

export function startNotionImportHeartbeat(userId: string, token: string): () => void {
  const handle = setInterval(() => {
    void renewNotionImportLock(userId, token);
  }, LOCK_RENEW_INTERVAL_MS);
  handle.unref();
  return () => clearInterval(handle);
}

export async function releaseNotionImportLock(userId: string, token: string): Promise<void> {
  const lock = localLocks.get(userId);
  if (lock?.token === token) localLocks.delete(userId);
  const redis = getRedisClient();
  if (!redis) return;
  try {
    await redis.eval(RELEASE_LOCK_SCRIPT, {
      keys: [lockKey(userId)],
      arguments: [token],
    });
  } catch (err) {
    logger.error({ err, userId }, 'Failed to release Notion import lock');
  }
}

/** Test-only. Production status keys expire via TTL. */
export function resetNotionImportStatusForTests(): void {
  localStatus.clear();
  localLocks.clear();
}
