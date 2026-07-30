import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = new Map<string, string>();
const mockRedis = {
  set: vi.fn(async (k: string, v: string) => { store.set(k, v); return 'OK'; }),
  get: vi.fn(async (k: string) => store.get(k) ?? null),
};
let redisAvailable = true;

vi.mock('./redis-cache.js', () => ({
  getRedisClient: () => (redisAvailable ? mockRedis : null),
}));

import { stageImage, loadStagedImage, STAGED_IMAGE_TTL_SECONDS } from './image-staging.js';
import { buildPng } from './test-image-fixtures.js';

beforeEach(() => {
  store.clear();
  mockRedis.set.mockClear();
  redisAvailable = true;
});

describe('image staging', () => {
  it('returns a 64-char lowercase hex handle', async () => {
    const handle = await stageImage('u1', buildPng(8, 8), 'png');
    expect(handle).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is content-addressed — identical bytes yield the same handle', async () => {
    const a = await stageImage('u1', buildPng(8, 8), 'png');
    const b = await stageImage('u1', buildPng(8, 8), 'png');
    expect(a).toBe(b);
  });

  it('gives different handles to different images', async () => {
    const a = await stageImage('u1', buildPng(8, 8), 'png');
    const b = await stageImage('u1', buildPng(16, 16), 'png');
    expect(a).not.toBe(b);
  });

  it('scopes the key by user id', async () => {
    const handle = await stageImage('u1', buildPng(8, 8), 'png');
    expect(mockRedis.set.mock.calls[0]![0]).toBe(`llm:img:u1:${handle}`);
  });

  it('sets the TTL', async () => {
    await stageImage('u1', buildPng(8, 8), 'png');
    expect(mockRedis.set.mock.calls[0]![2]).toEqual({ EX: STAGED_IMAGE_TTL_SECONDS });
  });

  it('round-trips bytes and format', async () => {
    const png = buildPng(8, 8);
    const handle = await stageImage('u1', png, 'png');
    const loaded = await loadStagedImage('u1', handle);
    expect(loaded!.format).toBe('png');
    expect(loaded!.bytes.equals(png)).toBe(true);
  });

  /** One user must never be able to reference another's staged bytes. */
  it('does not load another user\'s handle', async () => {
    const handle = await stageImage('u1', buildPng(8, 8), 'png');
    expect(await loadStagedImage('u2', handle)).toBeNull();
  });

  it('returns null for an unknown handle', async () => {
    expect(await loadStagedImage('u1', 'f'.repeat(64))).toBeNull();
  });

  it('does not consume the entry on load, so a retry works', async () => {
    const handle = await stageImage('u1', buildPng(8, 8), 'png');
    expect(await loadStagedImage('u1', handle)).not.toBeNull();
    expect(await loadStagedImage('u1', handle)).not.toBeNull();
  });

  it('throws when Redis is unavailable', async () => {
    redisAvailable = false;
    await expect(stageImage('u1', buildPng(8, 8), 'png')).rejects.toThrow(/unavailable/i);
  });

  it('returns null on load when Redis is unavailable', async () => {
    redisAvailable = false;
    expect(await loadStagedImage('u1', 'a'.repeat(64))).toBeNull();
  });
});
