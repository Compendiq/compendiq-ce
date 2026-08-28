import { describe, expect, it, vi, beforeEach } from 'vitest';
import { assertSafeS3Endpoint, objectKeyFor } from './backup-s3.js';

const addAllowed = vi.fn();
const assertNonSsrf = vi.fn().mockResolvedValue(undefined);

vi.mock('../utils/ssrf-guard.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/ssrf-guard.js')>('../utils/ssrf-guard.js');
  return {
    ...actual,
    addAllowedBaseUrl: (...args: unknown[]) => addAllowed(...args),
    assertNonSsrfUrl: (...args: unknown[]) => assertNonSsrf(...args),
  };
});

describe('assertSafeS3Endpoint', () => {
  beforeEach(() => {
    addAllowed.mockClear();
    assertNonSsrf.mockClear();
  });

  it('rejects cloud metadata addresses without allowlisting them', async () => {
    await expect(assertSafeS3Endpoint('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(
      /metadata/i,
    );
    expect(addAllowed).not.toHaveBeenCalled();
  });

  it('rejects file URLs', async () => {
    await expect(assertSafeS3Endpoint('file:///etc/passwd')).rejects.toThrow();
  });

  it('allowlists a public HTTPS endpoint then SSRF-checks it', async () => {
    await assertSafeS3Endpoint('https://s3.amazonaws.com');
    expect(addAllowed).toHaveBeenCalled();
    expect(assertNonSsrf).toHaveBeenCalled();
  });
});

describe('objectKeyFor', () => {
  it('prefixes the timestamped archive name', () => {
    const key = objectKeyFor('compendiq-backups/', new Date('2026-08-28T12:00:00.000Z'));
    expect(key).toBe('compendiq-backups/compendiq-backup-20260828T120000Z.enc');
  });
});
