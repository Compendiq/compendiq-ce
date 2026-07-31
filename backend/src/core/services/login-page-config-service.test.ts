import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

vi.mock('../utils/logger.js', () => ({
  logger: { warn: vi.fn() },
}));

import {
  DEFAULT_LOGIN_PAGE_VARIANT,
  getLoginPageVariant,
  setLoginPageVariant,
} from './login-page-config-service.js';

describe('login-page-config-service', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [] });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('prefers a persisted admin setting over the environment', async () => {
    vi.stubEnv('LOGIN_PAGE_VARIANT', 'local-loop');
    mockQuery.mockResolvedValue({ rows: [{ setting_value: 'change-desk' }] });

    expect(await getLoginPageVariant()).toBe('change-desk');
  });

  it('uses the deployment setting when no valid row exists', async () => {
    vi.stubEnv('LOGIN_PAGE_VARIANT', 'change-desk');
    mockQuery.mockResolvedValue({ rows: [{ setting_value: 'invalid' }] });

    expect(await getLoginPageVariant()).toBe('change-desk');
  });

  it('falls back to Local Loop for absent or invalid configuration', async () => {
    vi.stubEnv('LOGIN_PAGE_VARIANT', 'invalid');

    expect(await getLoginPageVariant()).toBe(DEFAULT_LOGIN_PAGE_VARIANT);
  });

  it('still returns the configured fallback when the database is unavailable', async () => {
    vi.stubEnv('LOGIN_PAGE_VARIANT', 'change-desk');
    mockQuery.mockRejectedValue(new Error('database unavailable'));

    expect(await getLoginPageVariant()).toBe('change-desk');
  });

  it('persists an admin selection with an upsert', async () => {
    await setLoginPageVariant('change-desk');

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admin_settings'),
      ['login_page_variant', 'change-desk'],
    );
  });
});
