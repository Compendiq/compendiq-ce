import type * as SsrfGuard from '../utils/ssrf-guard.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertSafeS3Endpoint, deleteBackupObjects, objectKeyFor } from './backup-s3.js';

const lookup = vi.hoisted(() => vi.fn());
const addAllowed = vi.hoisted(() => vi.fn());

vi.mock('node:dns/promises', () => ({ lookup }));

vi.mock('../utils/ssrf-guard.js', async () => {
  const actual = await vi.importActual<typeof SsrfGuard>('../utils/ssrf-guard.js');
  return {
    ...actual,
    addAllowedBaseUrl: addAllowed,
  };
});

describe('assertSafeS3Endpoint', () => {
  beforeEach(() => {
    lookup.mockReset();
    lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    addAllowed.mockClear();
  });

  it.each([
    ['IPv4 loopback', 'http://127.0.0.1:9000', /private|internal/i],
    ['IPv6 loopback', 'http://[::1]:9000', /private|internal/i],
    ['RFC 1918', 'http://10.0.0.2:9000', /private|internal/i],
    ['cloud metadata', 'http://169.254.169.254/latest', /metadata|private/i],
    ['internal hostname', 'http://minio.internal', /private|internal/i],
  ])('rejects %s endpoints without allowlisting them', async (_label, endpoint, message) => {
    await expect(assertSafeS3Endpoint(endpoint)).rejects.toThrow(message);
    expect(addAllowed).not.toHaveBeenCalled();
  });

  it('rejects a public hostname when DNS resolves it to a private address', async () => {
    lookup.mockResolvedValue([{ address: '10.0.0.2', family: 4 }]);

    await expect(assertSafeS3Endpoint('https://backup.example.test')).rejects.toThrow(/blocked|private/i);

    expect(lookup).toHaveBeenCalledWith('backup.example.test', { all: true });
    expect(addAllowed).not.toHaveBeenCalled();
  });

  it('rejects file URLs', async () => {
    await expect(assertSafeS3Endpoint('file:///etc/passwd')).rejects.toThrow();
  });

  it('validates an empty delete operation before returning', async () => {
    await expect(
      deleteBackupObjects(
        {
          endpoint: 'http://127.0.0.1:9000',
          bucket: 'backups',
          region: 'us-east-1',
          accessKey: 'access',
          secretKey: 'secret',
          prefix: 'compendiq-backups/',
          forcePathStyle: true,
        },
        [],
      ),
    ).rejects.toThrow(/private|internal/i);
  });
});

describe('objectKeyFor', () => {
  it('prefixes the timestamped archive name', () => {
    const key = objectKeyFor('compendiq-backups/', new Date('2026-08-28T12:00:00.000Z'));
    expect(key).toBe('compendiq-backups/compendiq-backup-20260828T120000Z.enc');
  });
});
