import { describe, it, expect } from 'vitest';
import {
  LoginPageConfigResponseSchema,
  LoginPageConfigSchema,
  LoginPageVariantSchema,
  RegistrationPolicySchema,
} from './auth.js';

describe('RegistrationPolicySchema (issue #1051)', () => {
  it('accepts { allowRegistration: true }', () => {
    const parsed = RegistrationPolicySchema.parse({ allowRegistration: true });
    expect(parsed.allowRegistration).toBe(true);
  });

  it('accepts { allowRegistration: false }', () => {
    const parsed = RegistrationPolicySchema.parse({ allowRegistration: false });
    expect(parsed.allowRegistration).toBe(false);
  });

  it('rejects a missing allowRegistration (fail-closed gating field)', () => {
    expect(() => RegistrationPolicySchema.parse({})).toThrow();
  });

  it('rejects a non-boolean allowRegistration', () => {
    expect(() => RegistrationPolicySchema.parse({ allowRegistration: 'yes' })).toThrow();
  });
});

describe('LoginPageConfigSchema', () => {
  it.each(['local-loop', 'change-desk'] as const)('accepts %s', (variant) => {
    expect(LoginPageVariantSchema.parse(variant)).toBe(variant);
    expect(LoginPageConfigSchema.parse({ variant })).toEqual({ variant });
  });

  it('rejects unknown variants', () => {
    expect(() => LoginPageConfigSchema.parse({ variant: 'other' })).toThrow();
  });
});

describe('LoginPageConfigResponseSchema', () => {
  it.each(['community', 'enterprise'] as const)('carries the %s edition', (edition) => {
    expect(LoginPageConfigResponseSchema.parse({ variant: 'local-loop', edition })).toEqual({
      variant: 'local-loop',
      edition,
    });
  });

  // An EE deployment pins the CE frontend by image tag while its backend is
  // built from an older CE release, so the SPA routinely talks to a backend
  // that predates `edition`. Requiring it would throw and take `variant` — the
  // whole point of the endpoint — down with it.
  it('parses a response from a backend predating the edition field', () => {
    const parsed = LoginPageConfigResponseSchema.parse({ variant: 'change-desk' });
    expect(parsed.variant).toBe('change-desk');
    expect(parsed.edition ?? null).toBeNull();
  });

  it('rejects an unknown edition rather than badging the page with it', () => {
    expect(() =>
      LoginPageConfigResponseSchema.parse({ variant: 'local-loop', edition: 'ultimate' }),
    ).toThrow();
  });
});
