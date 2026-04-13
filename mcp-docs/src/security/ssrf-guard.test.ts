import { describe, it, expect } from 'vitest';
import { validateUrl, SsrfError } from './ssrf-guard.js';

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
