import { describe, it, expect } from 'vitest';
import { unsafeDisableTlsVerification } from './unsafe-tls.js';

describe('unsafeDisableTlsVerification', () => {
  it('returns { rejectUnauthorized: false }', () => {
    expect(unsafeDisableTlsVerification()).toEqual({ rejectUnauthorized: false });
  });

  it('returns a fresh object on each call (no shared mutable state)', () => {
    const a = unsafeDisableTlsVerification();
    const b = unsafeDisableTlsVerification();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});
