import { createHash } from 'crypto';
import { RESP_TYPES } from 'redis';
import { SUPPORTED_IMAGE_FORMATS, type ImageFormat } from '@compendiq/contracts';
import { getRedisClient } from './redis-cache.js';
import { logger } from '../utils/logger.js';

/**
 * #1154: short-lived staging for an image awaiting a generate/improve call.
 *
 * Content-addressed and scoped by user: `llm:img:<userId>:<sha256>`. The user
 * scope is what makes cross-user reference impossible, so a handle leak can't
 * expose another user's bytes and the 410/422 paths can't probe for them.
 *
 * The entry is NOT consumed on read — a regenerate or retry inside the TTL
 * should not require re-uploading. Expiry and the per-user cap below are the
 * only removal paths.
 *
 * **Memory shape matters here.** Redis is shared with BullMQ, the LLM response
 * cache, the embedding locks and the cache-bus, and is deployed with
 * `--maxmemory-policy noeviction` — a full instance rejects *writes*, which
 * takes down job enqueue application-wide. Two things keep staged images from
 * being able to do that:
 *
 *   1. Only the newest handle per user survives (`pruneOlderStagedImages`), so
 *      the ceiling is `users x MAX_IMAGE_BYTES`, not `uploads x
 *      MAX_IMAGE_BYTES`. The design commits to exactly one image per request
 *      and the composer shows a single preview, so a depth of 1 costs nothing.
 *   2. The bytes are stored raw, not base64 inside JSON — ~25% less memory and
 *      no encode/decode/re-encode passes over up to 10 MB per request.
 */

export const STAGED_IMAGE_TTL_SECONDS = 900; // 15 minutes

export class ImageStagingUnavailableError extends Error {
  constructor() {
    super('Image staging is unavailable because Redis is not reachable');
    this.name = 'ImageStagingUnavailableError';
  }
}

function keyFor(userId: string, handle: string): string {
  return `llm:img:${userId}:${handle}`;
}

/**
 * Stored value layout: `<format>\n<raw image bytes>`.
 *
 * One key, one TTL, one round-trip — and the header is ASCII, so the format
 * survives without a second key or a JSON envelope wrapping 10 MB of base64.
 */
const FORMAT_TERMINATOR = 0x0a; // '\n'
/** Longest supported format name is 4 chars ('jpeg'/'webp'); bound the scan anyway. */
const MAX_FORMAT_HEADER_BYTES = 16;

function encodeStoredImage(bytes: Buffer, format: ImageFormat): Buffer {
  return Buffer.concat([Buffer.from(`${format}\n`, 'ascii'), bytes]);
}

/**
 * Returns null for anything that is not a well-formed stored image. A value
 * written by an older build, truncated by a crash, or clobbered by an
 * unrelated writer must read as a cache miss (410 "attach it again"), never as
 * a 500.
 */
function decodeStoredImage(stored: Buffer): { bytes: Buffer; format: ImageFormat } | null {
  const terminator = stored.indexOf(FORMAT_TERMINATOR);
  if (terminator <= 0 || terminator > MAX_FORMAT_HEADER_BYTES) return null;

  const format = stored.subarray(0, terminator).toString('ascii');
  if (!(SUPPORTED_IMAGE_FORMATS as readonly string[]).includes(format)) return null;

  return { bytes: stored.subarray(terminator + 1), format: format as ImageFormat };
}

/**
 * Drop every staged image for this user except `keepKey`.
 *
 * SCAN, never KEYS — the namespace shares the instance with BullMQ and the
 * caches, and a blocking keyspace walk on every upload is its own outage.
 * Failures here are logged, not thrown: the image the user just uploaded is
 * already staged, and losing the prune is a memory problem, not a request one.
 */
async function pruneOlderStagedImages(userId: string, keepKey: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;

  try {
    let cursor = '0';
    do {
      const result = await redis.scan(cursor, {
        MATCH: `llm:img:${userId}:*`,
        COUNT: 100,
      });
      cursor = String(result.cursor);
      const stale = result.keys.filter((k) => k !== keepKey);
      if (stale.length > 0) await redis.del(stale);
    } while (cursor !== '0');
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to prune superseded staged images');
  }
}

export async function stageImage(
  userId: string,
  bytes: Buffer,
  format: ImageFormat,
): Promise<string> {
  const redis = getRedisClient();
  if (!redis) throw new ImageStagingUnavailableError();

  const handle = createHash('sha256').update(bytes).digest('hex');
  const key = keyFor(userId, handle);
  await redis.set(key, encodeStoredImage(bytes, format), {
    EX: STAGED_IMAGE_TTL_SECONDS,
  });

  // After the write, so a prune failure can never leave the user with nothing.
  await pruneOlderStagedImages(userId, key);

  return handle;
}

/**
 * Throws `ImageStagingUnavailableError` when Redis is unreachable, so the
 * caller can answer 503 rather than 410 — telling a user to "attach it again"
 * when the store is down sends them into a retry that cannot succeed.
 * A missing or unreadable entry is a plain `null` (a genuine 410).
 */
export async function loadStagedImage(
  userId: string,
  handle: string,
): Promise<{ bytes: Buffer; format: ImageFormat } | null> {
  const redis = getRedisClient();
  if (!redis) throw new ImageStagingUnavailableError();

  // node-redis decodes blob replies as UTF-8 by default, which would mangle
  // image bytes; this asks for the raw Buffer instead.
  const stored = await redis
    .withTypeMapping({ [RESP_TYPES.BLOB_STRING]: Buffer })
    .get(keyFor(userId, handle));
  if (!stored) return null;

  if (!Buffer.isBuffer(stored)) {
    logger.warn({ userId }, 'Staged image did not decode as a Buffer; treating as a miss');
    return null;
  }

  const decoded = decodeStoredImage(stored);
  if (!decoded) {
    logger.warn({ userId }, 'Staged image value is malformed; treating as a miss');
    return null;
  }
  return decoded;
}
