import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { lookup } from 'node:dns/promises';
import { validateUrl, validateUrlWithDns, SsrfError } from './ssrf-guard.js';

// ESM named exports can't be spied with vi.spyOn, so mock the module. The
// hoisted factory replaces dns.promises.lookup with a controllable mock fn.
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}));

const lookupMock = vi.mocked(lookup);

describe('ssrf-guard', () => {
  it('allows valid public URLs', () => {
    expect(() => validateUrl('https://docs.example.com/api')).not.toThrow();
    expect(() => validateUrl('https://developer.mozilla.org/en-US/docs')).not.toThrow();
    expect(() => validateUrl('http://example.com')).not.toThrow();
  });

  it('blocks private IPv4 addresses', () => {
    expect(() => validateUrl('http://10.0.0.1')).toThrow(SsrfError);
    expect(() => validateUrl('http://172.16.0.1')).toThrow(SsrfError);
    expect(() => validateUrl('http://192.168.1.1')).toThrow(SsrfError);
    expect(() => validateUrl('http://127.0.0.1')).toThrow(SsrfError);
    expect(() => validateUrl('http://0.0.0.0')).toThrow(SsrfError);
    expect(() => validateUrl('http://169.254.169.254')).toThrow(SsrfError);
  });

  it('blocks CGNAT range 100.64.0.0/10 correctly', () => {
    // Lower boundary — blocked (CGNAT)
    expect(() => validateUrl('http://100.64.0.1')).toThrow(SsrfError);
    // Upper boundary — blocked (CGNAT)
    expect(() => validateUrl('http://100.127.255.255')).toThrow(SsrfError);
    // Just above upper boundary — public, must NOT be blocked
    expect(() => validateUrl('http://100.128.0.1')).not.toThrow();
    expect(() => validateUrl('http://100.129.0.1')).not.toThrow();
    // Well outside range — public
    expect(() => validateUrl('http://100.200.0.1')).not.toThrow();
  });

  it('blocks localhost and internal hostnames', () => {
    expect(() => validateUrl('http://localhost')).toThrow(SsrfError);
    expect(() => validateUrl('http://localhost.localdomain')).toThrow(SsrfError);
    expect(() => validateUrl('http://metadata.google.internal')).toThrow(SsrfError);
  });

  it('blocks internal domain suffixes', () => {
    expect(() => validateUrl('http://myservice.local')).toThrow(SsrfError);
    expect(() => validateUrl('http://api.internal')).toThrow(SsrfError);
    expect(() => validateUrl('http://db.localhost')).toThrow(SsrfError);
    expect(() => validateUrl('http://myapp.corp')).toThrow(SsrfError);
  });

  it('blocks non-HTTP protocols', () => {
    expect(() => validateUrl('ftp://example.com')).toThrow(SsrfError);
    expect(() => validateUrl('file:///etc/passwd')).toThrow(SsrfError);
    expect(() => validateUrl('javascript:alert(1)')).toThrow(SsrfError);
  });

  it('blocks IPv6 loopback', () => {
    expect(() => validateUrl('http://[::1]')).toThrow(SsrfError);
  });

  it('rejects invalid URLs', () => {
    expect(() => validateUrl('not-a-url')).toThrow(SsrfError);
    expect(() => validateUrl('')).toThrow(SsrfError);
  });

  it('returns parsed URL for valid URLs', () => {
    const parsed = validateUrl('https://docs.example.com/api?q=test');
    expect(parsed.hostname).toBe('docs.example.com');
    expect(parsed.protocol).toBe('https:');
  });
});

describe('validateUrlWithDns — DNS-resolving guard', () => {
  beforeEach(() => {
    lookupMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('blocks a public hostname whose A record points at cloud metadata', async () => {
    // Classic SSRF: attacker-controlled domain resolves to the metadata IP.
    lookupMock.mockResolvedValue([{ address: '169.254.169.254', family: 4 }] as never);

    await expect(validateUrlWithDns('https://evil.example.com')).rejects.toThrow(SsrfError);
    await expect(validateUrlWithDns('https://evil.example.com')).rejects.toThrow(/169\.254\.169\.254/);
  });

  it('blocks a public hostname that resolves to loopback', async () => {
    lookupMock.mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as never);
    await expect(validateUrlWithDns('https://rebind.example.com')).rejects.toThrow(SsrfError);
  });

  it('blocks a public hostname that resolves to an RFC1918 address', async () => {
    lookupMock.mockResolvedValue([{ address: '10.1.2.3', family: 4 }] as never);
    await expect(validateUrlWithDns('https://internal.example.com')).rejects.toThrow(SsrfError);
  });

  it('blocks when ANY resolved address is private (mixed A records)', async () => {
    lookupMock.mockResolvedValue([
      { address: '93.184.216.34', family: 4 }, // public
      { address: '192.168.1.5', family: 4 },   // private — must trip the guard
    ] as never);
    await expect(validateUrlWithDns('https://multi.example.com')).rejects.toThrow(SsrfError);
  });

  it('blocks a public hostname that resolves to an IPv6 ULA', async () => {
    lookupMock.mockResolvedValue([{ address: 'fd00::1', family: 6 }] as never);
    await expect(validateUrlWithDns('https://v6.example.com')).rejects.toThrow(SsrfError);
  });

  it('allows a public hostname that resolves to a public address', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
    const parsed = await validateUrlWithDns('https://docs.example.com/api');
    expect(parsed.hostname).toBe('docs.example.com');
  });

  it('still enforces the sync checks before resolving (literal private IP)', async () => {
    await expect(validateUrlWithDns('http://169.254.169.254')).rejects.toThrow(SsrfError);
    // Literal-IP URLs are rejected by the sync pass — no DNS lookup needed.
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('does not block when DNS resolution fails (handled by the HTTP client later)', async () => {
    lookupMock.mockRejectedValue(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
    const parsed = await validateUrlWithDns('https://does-not-resolve.example.com');
    expect(parsed.hostname).toBe('does-not-resolve.example.com');
  });
});
