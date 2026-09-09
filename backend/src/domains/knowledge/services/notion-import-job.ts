/**
 * Per-user Notion import job status.
 *
 * `POST /api/notion/import` must not wait for paced Notion traffic: nginx
 * caps `/api/` at `proxy_read_timeout 300`, and closing that connection
 * cancels nothing. Status is Redis-backed with an in-memory fallback so a
 * single-process test or a Redis blip still answers GET.
 */
import type { NotionImportItem } from '@compendiq/contracts';
import { getRedisClient } from '../../../core/services/redis-cache.js';
import { logger } from '../../../core/utils/logger.js';

const STATUS_PREFIX = 'notion:import:status:';
const STATUS_TTL_SEC = 24 * 60 * 60;

export type NotionImportJobStatus =
  | { status: 'idle' }
  | { status: 'importing' }
  | { status: 'complete'; items: NotionImportItem[] }
  | { status: 'error'; error: string };

const local = new Map<string, NotionImportJobStatus>();

export async function getNotionImportStatus(userId: string): Promise<NotionImportJobStatus> {
  const redis = getRedisClient();
  if (redis) {
    try {
      const raw = await redis.get(`${STATUS_PREFIX}${userId}`);
      if (raw) {
        const parsed = JSON.parse(raw) as NotionImportJobStatus;
        local.set(userId, parsed);
        return parsed;
      }
    } catch (err) {
      logger.error({ err, userId }, 'Failed to read Notion import status from Redis');
    }
  }
  return local.get(userId) ?? { status: 'idle' };
}

export async function setNotionImportStatus(
  userId: string,
  status: NotionImportJobStatus,
): Promise<void> {
  local.set(userId, status);
  const redis = getRedisClient();
  if (!redis) return;
  try {
    await redis.set(`${STATUS_PREFIX}${userId}`, JSON.stringify(status), { EX: STATUS_TTL_SEC });
  } catch (err) {
    logger.error({ err, userId }, 'Failed to write Notion import status to Redis');
  }
}

/** Test-only. Production status keys expire via TTL. */
export function resetNotionImportStatusForTests(): void {
  local.clear();
}
