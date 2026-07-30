import { createHash } from 'crypto';
import type { ImageFormat } from '@compendiq/contracts';
import { getRedisClient } from './redis-cache.js';

/**
 * #1154: short-lived staging for an image awaiting a generate/improve call.
 *
 * Content-addressed and scoped by user: `llm:img:<userId>:<sha256>`. The user
 * scope is what makes cross-user reference impossible, so a handle leak can't
 * expose another user's bytes and the 410/422 paths can't probe for them.
 *
 * The entry is NOT consumed on read — a regenerate or retry inside the TTL
 * should not require re-uploading. Expiry is the only removal path.
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

interface StoredImage {
  format: ImageFormat;
  base64: string;
}

export async function stageImage(
  userId: string,
  bytes: Buffer,
  format: ImageFormat,
): Promise<string> {
  const redis = getRedisClient();
  if (!redis) throw new ImageStagingUnavailableError();

  const handle = createHash('sha256').update(bytes).digest('hex');
  const payload: StoredImage = { format, base64: bytes.toString('base64') };
  await redis.set(keyFor(userId, handle), JSON.stringify(payload), {
    EX: STAGED_IMAGE_TTL_SECONDS,
  });
  return handle;
}

export async function loadStagedImage(
  userId: string,
  handle: string,
): Promise<{ bytes: Buffer; format: ImageFormat } | null> {
  const redis = getRedisClient();
  if (!redis) return null;

  const raw = await redis.get(keyFor(userId, handle));
  if (!raw) return null;

  const parsed = JSON.parse(raw) as StoredImage;
  return { bytes: Buffer.from(parsed.base64, 'base64'), format: parsed.format };
}
