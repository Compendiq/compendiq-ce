import { describe, it, expect } from 'vitest';
import { persistAuthState, uniqueUsername } from './auth';

describe('e2e auth helpers (#1449)', () => {
  it('persists user + isAuthenticated at version 1 without an access token', () => {
    const raw = persistAuthState({
      id: '11111111-1111-4111-8111-111111111111',
      username: 'alice',
      role: 'user',
    });
    const parsed = JSON.parse(raw) as {
      version: number;
      state: Record<string, unknown>;
    };
    expect(parsed.version).toBe(1);
    expect(parsed.state.isAuthenticated).toBe(true);
    expect(parsed.state.user).toMatchObject({ username: 'alice', role: 'user' });
    expect(parsed.state).not.toHaveProperty('accessToken');
  });

  it('keeps generated usernames inside the register max of 50', () => {
    expect(uniqueUsername('c7flag_with_a_longish_prefix').length).toBeLessThanOrEqual(50);
    expect(uniqueUsername('c7a').length).toBeGreaterThanOrEqual(8);
  });
});
