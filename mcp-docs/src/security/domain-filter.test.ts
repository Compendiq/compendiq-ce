import { describe, it, expect, beforeEach } from 'vitest';
import { isDomainAllowed, resetDomainConfigCache, type DomainConfig } from './domain-filter.js';

describe('domain-filter', () => {
  beforeEach(() => {
    resetDomainConfigCache();
  });

  describe('blocklist mode', () => {
    const config: DomainConfig = {
      mode: 'blocklist',
      allowedDomains: ['*'],
      blockedDomains: ['evil.com', '*.malware.org'],
    };

    it('allows non-blocked domains', () => {
      expect(isDomainAllowed('docs.example.com', config)).toBe(true);
      expect(isDomainAllowed('developer.mozilla.org', config)).toBe(true);
    });

    it('blocks exact match', () => {
      expect(isDomainAllowed('evil.com', config)).toBe(false);
    });

    it('blocks wildcard match', () => {
      expect(isDomainAllowed('sub.malware.org', config)).toBe(false);
      expect(isDomainAllowed('malware.org', config)).toBe(false);
    });

    it('allows unrelated domains', () => {
      expect(isDomainAllowed('notmalware.org', config)).toBe(true);
    });
  });

  describe('allowlist mode', () => {
    const config: DomainConfig = {
      mode: 'allowlist',
      allowedDomains: ['docs.example.com', '*.mozilla.org'],
      blockedDomains: [],
    };

    it('allows exact match', () => {
      expect(isDomainAllowed('docs.example.com', config)).toBe(true);
    });

    it('allows wildcard match', () => {
      expect(isDomainAllowed('developer.mozilla.org', config)).toBe(true);
      expect(isDomainAllowed('mozilla.org', config)).toBe(true);
    });

    it('blocks non-allowed domains', () => {
      expect(isDomainAllowed('evil.com', config)).toBe(false);
      expect(isDomainAllowed('other.example.com', config)).toBe(false);
    });
  });

  describe('wildcard allow-all', () => {
    const config: DomainConfig = {
      mode: 'allowlist',
      allowedDomains: ['*'],
      blockedDomains: [],
    };

    it('allows everything with * wildcard', () => {
      expect(isDomainAllowed('anything.com', config)).toBe(true);
      expect(isDomainAllowed('any.subdomain.example.com', config)).toBe(true);
    });
  });
});
