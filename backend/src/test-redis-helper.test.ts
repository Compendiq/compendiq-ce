import { describe, it, expect } from 'vitest';
import { isRedisAvailable } from './test-redis-helper.js';

describe('isRedisAvailable', () => {
  it(
    'resolves false for an unreachable Redis without hanging',
    async () => {
      // Port 1 is never a Redis. With node-redis defaults this would retry
      // forever (the bug this helper exists to prevent); the helper must
      // fail fast instead. The vitest timeout on this test IS the assertion
      // that no infinite reconnect loop is possible.
      await expect(isRedisAvailable('redis://127.0.0.1:1')).resolves.toBe(false);
    },
    10_000,
  );

  it('resolves false for a malformed URL instead of throwing', async () => {
    await expect(isRedisAvailable('not-a-redis-url')).resolves.toBe(false);
  });

  it('returns a boolean for the default env-derived URL', async () => {
    // CI has no Redis (false); workstations with the dev stack have one
    // (true). Either way the call must settle quickly and never throw.
    const result = await isRedisAvailable();
    expect(typeof result).toBe('boolean');
  });
});
