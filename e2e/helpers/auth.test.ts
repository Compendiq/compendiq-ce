import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { persistAuthState, uniqueUsername } from './auth';
import { COLLAB_E2E_SKIP_NO_ADMIN } from './collab';

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

describe('collab Playwright project isolation (#1449)', () => {
  const config = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../playwright.config.ts'),
    'utf8',
  );

  it('runs collab-editing only in a workers:1 project the default suite ignores', () => {
    expect(config).toMatch(/name:\s*'chromium'/);
    expect(config).toMatch(/testIgnore:\s*\/collab-editing\//);
    expect(config).toMatch(/name:\s*'collab'/);
    expect(config).toMatch(/testMatch:\s*\/collab-editing\//);
    expect(config).toMatch(/fullyParallel:\s*false/);
    expect(config).toMatch(/workers:\s*1/);
  });

  it('names the admin env vars the skip copy tells an operator to set', () => {
    expect(COLLAB_E2E_SKIP_NO_ADMIN).toMatch(/COLLAB_E2E_ADMIN/);
    expect(COLLAB_E2E_SKIP_NO_ADMIN).toMatch(/COLLAB_E2E_PASSWORD/);
    expect(COLLAB_E2E_SKIP_NO_ADMIN).toMatch(/empty DB/);
  });
});
