import { describe, it, expect } from 'vitest';
import { RegistrationPolicySchema } from './auth.js';

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
