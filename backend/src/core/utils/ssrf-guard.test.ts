import { describe, it, expect } from 'vitest';
import { validateUrl, SsrfError } from './ssrf-guard.js';

describe('SSRF Guard', () => {
  describe('valid URLs (should pass)', () => {
    it('should allow public HTTP URLs', () => {
      expect(() => validateUrl('http://confluence.example.com/rest/api')).not.toThrow();
    });

    it('should allow public HTTPS URLs', () => {
      expect(() => validateUrl('https://confluence.example.com/rest/api')).not.toThrow();
    });

    it('should allow public IP addresses', () => {
      expect(() => validateUrl('https://203.0.113.50:8443/rest/api')).not.toThrow();
    });

    it('should allow URLs with paths and query params', () => {
      expect(() => validateUrl('https://wiki.company.com/rest/api/content?limit=50')).not.toThrow();
    });

    it('should allow URLs with port numbers', () => {
      expect(() => validateUrl('https://confluence.example.com:8443/rest/api')).not.toThrow();
    });
  });

  describe('blocked protocols', () => {
    it('should block file:// protocol', () => {
      expect(() => validateUrl('file:///etc/passwd')).toThrow(SsrfError);
      expect(() => validateUrl('file:///etc/passwd')).toThrow(/protocol.*not allowed/);
    });

    it('should block ftp:// protocol', () => {
      expect(() => validateUrl('ftp://internal.server/file')).toThrow(SsrfError);
    });

    it('should block gopher:// protocol', () => {
      expect(() => validateUrl('gopher://internal.server')).toThrow(SsrfError);
    });

    it('should block dict:// protocol', () => {
      expect(() => validateUrl('dict://internal.server')).toThrow(SsrfError);
    });
  });

  describe('blocked loopback addresses', () => {
    it('should block 127.0.0.1', () => {
      expect(() => validateUrl('http://127.0.0.1/rest/api')).toThrow(SsrfError);
      expect(() => validateUrl('http://127.0.0.1/rest/api')).toThrow(/internal\/private/);
    });

    it('should block 127.x.x.x range', () => {
      expect(() => validateUrl('http://127.0.0.2/api')).toThrow(SsrfError);
      expect(() => validateUrl('http://127.255.255.255/api')).toThrow(SsrfError);
    });

    it('should block localhost hostname', () => {
      expect(() => validateUrl('http://localhost/api')).toThrow(SsrfError);
    });

    it('should block localhost.localdomain', () => {
      expect(() => validateUrl('http://localhost.localdomain/api')).toThrow(SsrfError);
    });

    it('should block IPv6 loopback ::1', () => {
      expect(() => validateUrl('http://[::1]/api')).toThrow(SsrfError);
    });

    it('should block 0.0.0.0', () => {
      expect(() => validateUrl('http://0.0.0.0/api')).toThrow(SsrfError);
    });
  });

  describe('blocked private IPv4 ranges', () => {
    it('should block 10.x.x.x (Class A private)', () => {
      expect(() => validateUrl('http://10.0.0.1/api')).toThrow(SsrfError);
      expect(() => validateUrl('http://10.255.255.255/api')).toThrow(SsrfError);
    });

    it('should block 172.16-31.x.x (Class B private)', () => {
      expect(() => validateUrl('http://172.16.0.1/api')).toThrow(SsrfError);
      expect(() => validateUrl('http://172.31.255.255/api')).toThrow(SsrfError);
    });

    it('should not block 172.15.x.x or 172.32.x.x (outside private range)', () => {
      expect(() => validateUrl('http://172.15.0.1/api')).not.toThrow();
      expect(() => validateUrl('http://172.32.0.1/api')).not.toThrow();
    });

    it('should block 192.168.x.x (Class C private)', () => {
      expect(() => validateUrl('http://192.168.0.1/api')).toThrow(SsrfError);
      expect(() => validateUrl('http://192.168.1.100/api')).toThrow(SsrfError);
      expect(() => validateUrl('http://192.168.255.255/api')).toThrow(SsrfError);
    });

    it('should block 169.254.x.x (link-local)', () => {
      expect(() => validateUrl('http://169.254.169.254/latest/meta-data')).toThrow(SsrfError);
    });

    it('should block CGNAT range 100.64.x.x', () => {
      expect(() => validateUrl('http://100.64.0.1/api')).toThrow(SsrfError);
      expect(() => validateUrl('http://100.127.255.255/api')).toThrow(SsrfError);
    });
  });

  describe('blocked private IPv6 ranges', () => {
    it('should block fd00::/8 unique local', () => {
      expect(() => validateUrl('http://[fd00::1]/api')).toThrow(SsrfError);
    });

    it('should block fc00::/7 unique local', () => {
      expect(() => validateUrl('http://[fc00::1]/api')).toThrow(SsrfError);
    });

    it('should block fe80::/10 link-local', () => {
      expect(() => validateUrl('http://[fe80::1]/api')).toThrow(SsrfError);
    });

    it('should block IPv4-mapped IPv6 with private address', () => {
      expect(() => validateUrl('http://[::ffff:127.0.0.1]/api')).toThrow(SsrfError);
      expect(() => validateUrl('http://[::ffff:192.168.1.1]/api')).toThrow(SsrfError);
      expect(() => validateUrl('http://[::ffff:10.0.0.1]/api')).toThrow(SsrfError);
    });
  });

  describe('blocked internal hostnames', () => {
    it('should block .local suffix', () => {
      expect(() => validateUrl('http://server.local/api')).toThrow(SsrfError);
    });

    it('should block .internal suffix', () => {
      expect(() => validateUrl('http://service.internal/api')).toThrow(SsrfError);
    });

    it('should block .localhost suffix', () => {
      expect(() => validateUrl('http://app.localhost/api')).toThrow(SsrfError);
    });

    it('should block metadata.google.internal', () => {
      expect(() => validateUrl('http://metadata.google.internal/computeMetadata/v1')).toThrow(SsrfError);
    });
  });

  describe('invalid URLs', () => {
    it('should throw on completely invalid URL', () => {
      expect(() => validateUrl('not-a-url')).toThrow(SsrfError);
      expect(() => validateUrl('not-a-url')).toThrow(/invalid URL/);
    });

    it('should throw on empty string', () => {
      expect(() => validateUrl('')).toThrow(SsrfError);
    });
  });

  describe('SsrfError', () => {
    it('should have correct name property', () => {
      try {
        validateUrl('http://127.0.0.1/api');
      } catch (e) {
        expect(e).toBeInstanceOf(SsrfError);
        expect((e as SsrfError).name).toBe('SsrfError');
      }
    });
  });
});
