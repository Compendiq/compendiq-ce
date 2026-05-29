import { describe, it, expect } from 'vitest';
import { OidcConfigSchema } from './oidc.js';

describe('OidcConfigSchema', () => {
  it('parses a full payload', () => {
    const parsed = OidcConfigSchema.parse({
      enabled: true,
      issuer: 'https://idp.example.com',
      name: 'OrgSSO',
      enterpriseRequired: false,
    });
    expect(parsed.enabled).toBe(true);
    expect(parsed.name).toBe('OrgSSO');
    expect(parsed.enterpriseRequired).toBe(false);
  });

  it('accepts null issuer/name (EE serializes unset fields as null)', () => {
    const parsed = OidcConfigSchema.parse({
      enabled: false,
      issuer: null,
      name: null,
      enterpriseRequired: true,
    });
    expect(parsed.issuer).toBeNull();
    expect(parsed.enterpriseRequired).toBe(true);
  });

  it('fails open: tolerates omitted optional fields so a minor EE shape drift still enables the button', () => {
    // Only `enabled` is guaranteed; issuer/name/enterpriseRequired may be absent.
    const parsed = OidcConfigSchema.parse({ enabled: true });
    expect(parsed.enabled).toBe(true);
    expect(parsed.enterpriseRequired).toBe(false); // default — does not gate the button off
    expect(parsed.issuer).toBeUndefined();
    expect(parsed.name).toBeUndefined();
  });

  it('still requires enabled (the gating field) — fails closed if absent', () => {
    expect(() => OidcConfigSchema.parse({ issuer: null, name: null })).toThrow();
  });

  it('rejects a wrong-typed enabled', () => {
    expect(() => OidcConfigSchema.parse({ enabled: 'yes' })).toThrow();
  });
});
