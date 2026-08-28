import { Readable } from 'node:stream';
import type * as SsrfGuard from '../utils/ssrf-guard.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addAllowedBaseUrlSilent,
  clearAllowedBaseUrls,
} from '../utils/ssrf-guard.js';
import {
  assertSafeS3Endpoint,
  deleteBackupObjects,
  listBackupObjects,
  objectKeyFor,
  pruneBackupObjects,
  testS3Connection,
  uploadBackupObject,
} from './backup-s3.js';

interface TestAgentOptions {
  connect?: {
    lookup?: (
      hostname: string,
      options: { all?: boolean; family?: number },
      callback: (...args: unknown[]) => void,
    ) => void;
  };
}

interface TestRequestOptions {
  headers: Record<string, string>;
  dispatcher?: unknown;
}

const lookup = vi.hoisted(() => vi.fn());
const addAllowed = vi.hoisted(() => vi.fn());
const undiciRequest = vi.hoisted(() => vi.fn());
const agentClose = vi.hoisted(() => vi.fn());
const agentOptions = vi.hoisted(() => [] as TestAgentOptions[]);

vi.mock('node:dns/promises', () => ({ lookup }));

vi.mock('undici', () => ({
  Agent: class {
    constructor(options: TestAgentOptions) {
      agentOptions.push(options);
    }

    close = agentClose;
  },
  request: undiciRequest,
}));

vi.mock('../utils/ssrf-guard.js', async () => {
  const actual = await vi.importActual<typeof SsrfGuard>('../utils/ssrf-guard.js');
  return {
    ...actual,
    addAllowedBaseUrl: addAllowed,
  };
});

function target(overrides: Partial<Parameters<typeof testS3Connection>[0]> = {}) {
  return {
    endpoint: 'https://s3.example.test',
    bucket: 'backups',
    region: 'us-east-1',
    accessKey: 'access',
    secretKey: 'secret',
    prefix: 'compendiq-backups/',
    forcePathStyle: false,
    ...overrides,
  };
}

function xmlResponse(
  text: string,
  headers: Record<string, string> = {},
  statusCode = 200,
) {
  return { statusCode, headers, body: { text: vi.fn().mockResolvedValue(text) } };
}

function requestOptionsAt(index: number): TestRequestOptions {
  // Vitest intentionally erases mock argument types; production request options are checked separately.
  return undiciRequest.mock.calls[index]![1] as TestRequestOptions;
}

describe('backup S3 transport', () => {
  beforeEach(() => {
    clearAllowedBaseUrls();
    lookup.mockReset();
    lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    addAllowed.mockClear();
    undiciRequest.mockReset();
    agentClose.mockReset();
    agentClose.mockResolvedValue(undefined);
    agentOptions.length = 0;
    undiciRequest.mockResolvedValue(xmlResponse(''));
  });

  afterEach(() => {
    clearAllowedBaseUrls();
    vi.useRealTimers();
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

  it('rejects a private endpoint even when another subsystem allowlisted its origin', async () => {
    addAllowedBaseUrlSilent('http://10.0.0.2:9000');
    await expect(assertSafeS3Endpoint('http://10.0.0.2:9000')).rejects.toThrow(/private|internal/i);
  });

  it('rejects file URLs', async () => {
    await expect(assertSafeS3Endpoint('file:///etc/passwd')).rejects.toThrow();
  });

  it.each([
    ['IPv4 benchmarking', 'http://198.18.0.1'],
    ['IPv4 documentation', 'http://203.0.113.10'],
    ['IPv6 multicast', 'http://[ff02::1]'],
  ])('rejects non-global-unicast %s literals', async (_label, endpoint) => {
    await expect(assertSafeS3Endpoint(endpoint)).rejects.toThrow(/globally routable|public/i);
  });

  it('rejects non-global-unicast DNS answers', async () => {
    lookup.mockResolvedValue([{ address: '198.18.0.1', family: 4 }]);
    await expect(assertSafeS3Endpoint('https://backup.example.test')).rejects.toThrow(
      /globally routable|public/i,
    );
  });

  it('validates an empty delete operation before returning', async () => {
    await expect(
      deleteBackupObjects(
        target({ endpoint: 'http://127.0.0.1:9000', forcePathStyle: true }),
        [],
      ),
    ).rejects.toThrow(/private|internal/i);
  });

  it('validates a crafted virtual-host request URL before I/O', async () => {
    await expect(
      testS3Connection(target({ bucket: '127.0.0.1:9000/' })),
    ).rejects.toThrow(/private|internal/i);
    expect(undiciRequest).not.toHaveBeenCalled();
  });

  it('pins validated DNS answers into the request dispatcher and closes it after body consumption', async () => {
    lookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ]);
    const bodyText = vi.fn().mockResolvedValue('');
    undiciRequest.mockResolvedValue({ statusCode: 200, headers: {}, body: { text: bodyText } });

    await testS3Connection(target());

    expect(lookup).toHaveBeenCalledTimes(2);
    expect(agentOptions).toHaveLength(1);
    const pinnedLookup = agentOptions[0]!.connect?.lookup;
    expect(pinnedLookup).toBeTypeOf('function');
    const callback = vi.fn();
    pinnedLookup!('s3.example.test', { all: true }, callback);
    expect(callback).toHaveBeenCalledWith(null, [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ]);
    expect(requestOptionsAt(0)).toMatchObject({ dispatcher: expect.anything() });
    expect(bodyText).toHaveBeenCalledBefore(agentClose);
    expect(agentClose).toHaveBeenCalledOnce();
  });

  it('targets the bucket root exactly for path-style list requests', async () => {
    await testS3Connection(target({ forcePathStyle: true }));
    expect(undiciRequest.mock.calls[0]![0]).toBe(
      'https://s3.example.test/backups?list-type=2&max-keys=1',
    );
  });

  it('rejects redirects instead of following or treating them as success', async () => {
    undiciRequest.mockResolvedValue(xmlResponse('redirect', { location: 'https://attacker.example.test' }, 307));

    await expect(testS3Connection(target())).rejects.toThrow(/307/);
    expect(undiciRequest).toHaveBeenCalledOnce();
  });

  it('rejects undocumented non-200 2xx responses', async () => {
    undiciRequest.mockResolvedValue(xmlResponse('', {}, 201));
    await expect(testS3Connection(target())).rejects.toThrow(/201/);
  });

  it('signs the same singly encoded object path that is sent on the wire', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-28T12:00:00.000Z'));
    undiciRequest
      .mockResolvedValueOnce(xmlResponse('<InitiateMultipartUploadResult><UploadId>u1</UploadId></InitiateMultipartUploadResult>'))
      .mockResolvedValueOnce(xmlResponse('', { etag: '"part-1"' }))
      .mockResolvedValueOnce(xmlResponse('<CompleteMultipartUploadResult/>'));

    await uploadBackupObject(target(), 'folder/a b%name.enc', Readable.from([Buffer.from('x')]));

    expect(undiciRequest.mock.calls[0]![0]).toContain('/folder/a%20b%25name.enc');
    expect(requestOptionsAt(0).headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=access/20260828/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=d4031b76fa919f5704c9d7edd39fdcff6ac22748c299c890d5eb73e44c5ce360',
    );
  });

  it('rejects an HTTP 200 embedded CompleteMultipartUpload error', async () => {
    undiciRequest
      .mockResolvedValueOnce(xmlResponse('<InitiateMultipartUploadResult><UploadId>u1</UploadId></InitiateMultipartUploadResult>'))
      .mockResolvedValueOnce(xmlResponse('', { etag: '"part-1"' }))
      .mockResolvedValueOnce(xmlResponse('<Error><Code>InternalError</Code></Error>'))
      .mockResolvedValueOnce(xmlResponse(''));

    await expect(
      uploadBackupObject(target(), 'backup.enc', Readable.from([Buffer.from('x')])),
    ).rejects.toThrow(/CompleteMultipartUpload.*InternalError/i);
  });

  it.each([
    ['create multipart', 301, '<InitiateMultipartUploadResult><UploadId>u1</UploadId></InitiateMultipartUploadResult>'],
    ['upload part', 302, ''],
    ['complete multipart', 303, '<CompleteMultipartUploadResult/>'],
  ])('rejects redirect responses from %s', async (phase, status, body) => {
    const responses = phase === 'create multipart'
      ? [xmlResponse(body, {}, status)]
      : phase === 'upload part'
        ? [
            xmlResponse('<InitiateMultipartUploadResult><UploadId>u1</UploadId></InitiateMultipartUploadResult>'),
            xmlResponse(body, { etag: '"part-1"' }, status),
            xmlResponse(''),
          ]
        : [
            xmlResponse('<InitiateMultipartUploadResult><UploadId>u1</UploadId></InitiateMultipartUploadResult>'),
            xmlResponse('', { etag: '"part-1"' }),
            xmlResponse(body, {}, status),
            xmlResponse(''),
          ];
    responses.forEach((response) => undiciRequest.mockResolvedValueOnce(response));

    await expect(
      uploadBackupObject(target(), 'backup.enc', Readable.from([Buffer.from('x')])),
    ).rejects.toThrow(new RegExp(String(status)));
  });

  it('rejects ListObjects redirects', async () => {
    undiciRequest.mockResolvedValue(xmlResponse('', {}, 301));
    await expect(listBackupObjects(target())).rejects.toThrow(/301/);
  });

  it('sends and signs Content-MD5 for DeleteObjects and rejects per-object errors', async () => {
    undiciRequest.mockResolvedValueOnce(
      xmlResponse('<DeleteResult><Error><Key>a.enc</Key><Code>AccessDenied</Code></Error></DeleteResult>'),
    );

    await expect(deleteBackupObjects(target(), ['a.enc'])).rejects.toThrow(/AccessDenied/);
    expect(requestOptionsAt(0).headers['content-md5']).toBe('kl+/xQvtI9cFYEM1l51gQQ==');
    expect(requestOptionsAt(0).headers.authorization).toContain(
      'SignedHeaders=content-md5;host;x-amz-content-sha256;x-amz-date',
    );
  });

  it('prunes only generated backup basenames under the configured prefix', async () => {
    undiciRequest
      .mockResolvedValueOnce(
        xmlResponse(
          '<ListBucketResult>' +
            '<Contents><Key>shared/compendiq-backup-20260820T000000Z.enc</Key><LastModified>2026-08-20T00:00:00Z</LastModified><Size>1</Size></Contents>' +
            '<Contents><Key>shared/customer-secret.enc</Key><LastModified>2026-08-01T00:00:00Z</LastModified><Size>1</Size></Contents>' +
            '<Contents><Key>shared/nested/compendiq-backup-20260819T000000Z.enc</Key><LastModified>2026-08-19T00:00:00Z</LastModified><Size>1</Size></Contents>' +
          '</ListBucketResult>',
        ),
      )
      .mockResolvedValueOnce(xmlResponse('<DeleteResult/>'));

    await expect(
      pruneBackupObjects(target({ prefix: 'shared/' }), 0, 1, new Date('2026-08-28T00:00:00Z')),
    ).resolves.toEqual(['shared/compendiq-backup-20260820T000000Z.enc']);
  });
});

describe('objectKeyFor', () => {
  it('prefixes the timestamped archive name', () => {
    const key = objectKeyFor('compendiq-backups/', new Date('2026-08-28T12:00:00.000Z'));
    expect(key).toBe('compendiq-backups/compendiq-backup-20260828T120000Z.enc');
  });
});
