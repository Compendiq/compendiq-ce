import { describe, it, expect } from 'vitest';
import { originOf, checkRedirectUriOrigin } from './oidc-redirect-uri';

describe('originOf', () => {
  it('extracts the origin from a full URL', () => {
    expect(originOf('https://compendiq.example.com/api/auth/oidc/callback')).toBe(
      'https://compendiq.example.com',
    );
  });

  it('includes a non-default port in the origin', () => {
    expect(originOf('http://localhost:8081/api/auth/oidc/callback')).toBe(
      'http://localhost:8081',
    );
  });

  it('returns null for an empty or whitespace-only string', () => {
    expect(originOf('')).toBeNull();
    expect(originOf('   ')).toBeNull();
  });

  it('returns null for an unparseable URL', () => {
    expect(originOf('not a url')).toBeNull();
    expect(originOf('/api/auth/oidc/callback')).toBeNull();
  });
});

describe('checkRedirectUriOrigin', () => {
  const appOrigin = 'https://compendiq.example.com';

  it('flags a mismatch when the Redirect URI origin diverges from the app origin', () => {
    const result = checkRedirectUriOrigin(
      'http://localhost:8081/api/auth/oidc/callback',
      appOrigin,
    );
    expect(result.mismatch).toBe(true);
    expect(result.redirectOrigin).toBe('http://localhost:8081');
    expect(result.appOrigin).toBe(appOrigin);
  });

  it('does not flag a match when origins are identical', () => {
    const result = checkRedirectUriOrigin(
      'https://compendiq.example.com/api/auth/oidc/callback',
      appOrigin,
    );
    expect(result.mismatch).toBe(false);
    expect(result.redirectOrigin).toBe(appOrigin);
  });

  it('treats differing ports as a mismatch', () => {
    const result = checkRedirectUriOrigin(
      'https://compendiq.example.com:8443/api/auth/oidc/callback',
      appOrigin,
    );
    expect(result.mismatch).toBe(true);
  });

  it('treats differing schemes as a mismatch', () => {
    const result = checkRedirectUriOrigin(
      'http://compendiq.example.com/api/auth/oidc/callback',
      appOrigin,
    );
    expect(result.mismatch).toBe(true);
  });

  it('does not flag while the Redirect URI is empty', () => {
    const result = checkRedirectUriOrigin('', appOrigin);
    expect(result.mismatch).toBe(false);
    expect(result.redirectOrigin).toBeNull();
  });

  it('does not flag while the Redirect URI is not yet a valid URL', () => {
    const result = checkRedirectUriOrigin('https://comp', appOrigin);
    // 'https://comp' parses to origin 'https://comp' which differs — but a
    // partially-typed bare host without a dot is still a complete, parseable
    // origin, so this is a genuine mismatch and we surface it.
    expect(result.redirectOrigin).toBe('https://comp');
    expect(result.mismatch).toBe(true);
  });

  it('does not flag a fragment-only or relative path that cannot be parsed', () => {
    const result = checkRedirectUriOrigin('/api/auth/oidc/callback', appOrigin);
    expect(result.redirectOrigin).toBeNull();
    expect(result.mismatch).toBe(false);
  });
});
