import { describe, expect, it } from 'vitest';
import { prefixedRedisChannel, vitestRedisChannelPrefix } from './prefixed-redis-channel.js';

describe('vitestRedisChannelPrefix', () => {
  it('is empty in production so live channel names stay unchanged', () => {
    expect(vitestRedisChannelPrefix({ VITEST: undefined, VITEST_POOL_ID: '3' })).toBe('');
    expect(vitestRedisChannelPrefix({})).toBe('');
  });

  it('scopes the prefix to the Vitest pool slot, not the incrementing worker id', () => {
    expect(
      vitestRedisChannelPrefix({ VITEST: 'true', VITEST_POOL_ID: '3', VITEST_WORKER_ID: '29' }),
    ).toBe('vitest:w3:');
  });

  it('is empty when Vitest has not assigned a pool slot', () => {
    expect(vitestRedisChannelPrefix({ VITEST: 'true' })).toBe('');
    expect(vitestRedisChannelPrefix({ VITEST: 'true', VITEST_POOL_ID: 'undefined' })).toBe('');
  });
});

describe('prefixedRedisChannel', () => {
  it('leaves the channel alone outside Vitest workers', () => {
    expect(prefixedRedisChannel('collab:doc:12', {})).toBe('collab:doc:12');
  });

  it('prefixes pub/sub channels so Redis logical DBs cannot isolate them', () => {
    expect(
      prefixedRedisChannel('collab:doc:12', { VITEST: 'true', VITEST_POOL_ID: '2' }),
    ).toBe('vitest:w2:collab:doc:12');
  });
});
