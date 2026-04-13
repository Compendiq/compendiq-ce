import { describe, it, expect, afterEach, vi } from 'vitest';

const mockLookup = vi.hoisted(() => vi.fn());

vi.mock('node:dns/promises', () => ({
  lookup: mockLookup,
}));

import {
  validateUrl,
  validateUrlWithDns,
  SsrfError,
  addAllowedBaseUrl,
  removeAllowedBaseUrl,
  replaceAllowedBaseUrls,
  clearAllowedBaseUrls,
  getAllowedBaseUrlCount,
} from './ssrf-guard.js';

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

    it('should block CGNAT range 100.64.0.0/10 (100.64-127.x.x)', () => {
      expect(() => validateUrl('http://100.64.0.1/api')).toThrow(SsrfError);
      expect(() => validateUrl('http://100.127.255.255/api')).toThrow(SsrfError);
    });

    it('should NOT block IPs just above CGNAT range (100.128+)', () => {
      expect(() => validateUrl('http://100.128.0.1/api')).not.toThrow();
      expect(() => validateUrl('http://100.129.0.1/api')).not.toThrow();
      expect(() => validateUrl('http://100.200.0.1/api')).not.toThrow();
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

  describe('allowlist mechanism (#480)', () => {
    afterEach(() => {
      clearAllowedBaseUrls();
    });

    it('should allow a private IP URL after adding its base URL to the allowlist', () => {
      expect(() => validateUrl('http://10.0.0.5:8090/rest/api/space')).toThrow(SsrfError);
      addAllowedBaseUrl('http://10.0.0.5:8090');
      expect(() => validateUrl('http://10.0.0.5:8090/rest/api/space')).not.toThrow();
      expect(() => validateUrl('http://10.0.0.5:8090/rest/api/content?limit=50')).not.toThrow();
    });

    it('should still block non-allowlisted private IPs', () => {
      addAllowedBaseUrl('http://10.0.0.5:8090');
      expect(() => validateUrl('http://10.0.0.6:8090/rest/api')).toThrow(SsrfError);
      expect(() => validateUrl('http://10.0.0.5:9090/rest/api')).toThrow(SsrfError);
    });

    it('should only exempt the exact origin (protocol + host + port)', () => {
      addAllowedBaseUrl('http://192.168.1.100:8090');
      expect(() => validateUrl('https://192.168.1.100:8090/api')).toThrow(SsrfError);
      expect(() => validateUrl('http://192.168.1.100/api')).toThrow(SsrfError);
    });

    it('should handle base URLs with trailing slashes and paths', () => {
      addAllowedBaseUrl('http://172.16.0.10:8090/confluence/');
      expect(() => validateUrl('http://172.16.0.10:8090/rest/api/space')).not.toThrow();
    });

    it('should re-enable blocking after removeAllowedBaseUrl', () => {
      addAllowedBaseUrl('http://10.0.0.5:8090');
      expect(() => validateUrl('http://10.0.0.5:8090/rest/api')).not.toThrow();
      removeAllowedBaseUrl('http://10.0.0.5:8090');
      expect(() => validateUrl('http://10.0.0.5:8090/rest/api')).toThrow(SsrfError);
    });

    it('should clear all allowed URLs with clearAllowedBaseUrls', () => {
      addAllowedBaseUrl('http://10.0.0.5:8090');
      addAllowedBaseUrl('http://192.168.1.100:8443');
      expect(getAllowedBaseUrlCount()).toBe(2);
      clearAllowedBaseUrls();
      expect(getAllowedBaseUrlCount()).toBe(0);
      expect(() => validateUrl('http://10.0.0.5:8090/api')).toThrow(SsrfError);
    });

    it('should still block disallowed protocols even for allowlisted origins', () => {
      addAllowedBaseUrl('http://10.0.0.5:8090');
      expect(() => validateUrl('ftp://10.0.0.5:8090/file')).toThrow(SsrfError);
      expect(() => validateUrl('ftp://10.0.0.5:8090/file')).toThrow(/protocol.*not allowed/);
    });

    it('should allow internal TLD hostnames when allowlisted', () => {
      expect(() => validateUrl('http://confluence.corp:8090/rest/api')).toThrow(SsrfError);
      addAllowedBaseUrl('http://confluence.corp:8090');
      expect(() => validateUrl('http://confluence.corp:8090/rest/api')).not.toThrow();
    });

    it('should gracefully handle invalid URLs passed to addAllowedBaseUrl', () => {
      addAllowedBaseUrl('not-a-url');
      addAllowedBaseUrl('');
      expect(getAllowedBaseUrlCount()).toBe(0);
    });

    it('should replace all allowed URLs with replaceAllowedBaseUrls', () => {
      addAllowedBaseUrl('http://10.0.0.5:8090');
      addAllowedBaseUrl('http://192.168.1.100:8443');
      expect(getAllowedBaseUrlCount()).toBe(2);

      // Replace with a completely different set
      replaceAllowedBaseUrls(['http://172.16.0.10:8090', 'http://10.0.0.99:8090']);
      expect(getAllowedBaseUrlCount()).toBe(2);

      // Old origins are gone
      expect(() => validateUrl('http://10.0.0.5:8090/api')).toThrow(SsrfError);
      expect(() => validateUrl('http://192.168.1.100:8443/api')).toThrow(SsrfError);

      // New origins work
      expect(() => validateUrl('http://172.16.0.10:8090/api')).not.toThrow();
      expect(() => validateUrl('http://10.0.0.99:8090/api')).not.toThrow();
    });

    it('should handle empty array in replaceAllowedBaseUrls (clears all)', () => {
      addAllowedBaseUrl('http://10.0.0.5:8090');
      expect(getAllowedBaseUrlCount()).toBe(1);

      replaceAllowedBaseUrls([]);
      expect(getAllowedBaseUrlCount()).toBe(0);
      expect(() => validateUrl('http://10.0.0.5:8090/api')).toThrow(SsrfError);
    });
  });

  describe('validateUrlWithDns (#583 DNS rebinding mitigation)', () => {
    afterEach(() => {
      clearAllowedBaseUrls();
      mockLookup.mockReset();
    });

    it('should pass for public URLs that resolve to public IPs', async () => {
      mockLookup.mockResolvedValue({ address: '93.184.216.34', family: 4 });

      await expect(validateUrlWithDns('https://example.com/api')).resolves.toBeUndefined();
    });

    it('should reject when DNS resolves to a private IP (127.x.x.x)', async () => {
      mockLookup.mockResolvedValue({ address: '127.0.0.1', family: 4 });

      await expect(validateUrlWithDns('https://evil-rebind.example.com/api')).rejects.toThrow(SsrfError);
      await expect(validateUrlWithDns('https://evil-rebind.example.com/api')).rejects.toThrow(/DNS resolved to blocked IP/);
    });

    it('should reject when DNS resolves to a private IP (10.x.x.x)', async () => {
      mockLookup.mockResolvedValue({ address: '10.0.0.1', family: 4 });

      await expect(validateUrlWithDns('https://rebind.example.com/api')).rejects.toThrow(SsrfError);
    });

    it('should reject when DNS resolves to 169.254.x.x (link-local)', async () => {
      mockLookup.mockResolvedValue({ address: '169.254.169.254', family: 4 });

      await expect(validateUrlWithDns('https://metadata.example.com')).rejects.toThrow(SsrfError);
    });

    it('should skip DNS check for allowlisted origins', async () => {
      mockLookup.mockResolvedValue({ address: '10.0.0.5', family: 4 });

      addAllowedBaseUrl('http://10.0.0.5:8090');
      await expect(validateUrlWithDns('http://10.0.0.5:8090/rest/api')).resolves.toBeUndefined();

      // dns.lookup should NOT have been called for allowlisted URL
      expect(mockLookup).not.toHaveBeenCalled();
    });

    it('should still enforce sync checks (protocol, hostname patterns)', async () => {
      // file:// should be caught by the sync validateUrl() before DNS check
      await expect(validateUrlWithDns('file:///etc/passwd')).rejects.toThrow(SsrfError);
      await expect(validateUrlWithDns('file:///etc/passwd')).rejects.toThrow(/protocol.*not allowed/);
    });

    it('should gracefully handle DNS lookup failures (ENOTFOUND)', async () => {
      mockLookup.mockRejectedValue(new Error('ENOTFOUND'));

      // DNS failure should not throw — the HTTP client handles it later
      await expect(validateUrlWithDns('https://nonexistent.example.com/api')).resolves.toBeUndefined();
    });
  });
});
