import { describe, it, expect } from 'vitest';
import {
  generateCodeVerifier,
  generateCodeChallenge,
  generateRandomState,
} from './oidc-service.js';

// We test the pure, stateless helpers directly.
// Functions that require DB/Redis/network are tested at the route level with mocks.

describe('oidc-service', () => {
  describe('generateCodeVerifier', () => {
    it('returns a URL-safe base64 string', () => {
      const verifier = generateCodeVerifier();
      expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('returns a string of at least 43 characters (PKCE minimum)', () => {
      const verifier = generateCodeVerifier();
      expect(verifier.length).toBeGreaterThanOrEqual(43);
    });

    it('generates unique values', () => {
      const a = generateCodeVerifier();
      const b = generateCodeVerifier();
      expect(a).not.toBe(b);
    });
  });

  describe('generateCodeChallenge', () => {
    it('returns a URL-safe base64 SHA-256 hash', () => {
      const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
      const challenge = generateCodeChallenge(verifier);
      expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('produces a consistent hash for the same input', () => {
      const verifier = 'test-verifier-string';
      const a = generateCodeChallenge(verifier);
      const b = generateCodeChallenge(verifier);
      expect(a).toBe(b);
    });

    it('produces different hashes for different inputs', () => {
      const a = generateCodeChallenge('verifier-a');
      const b = generateCodeChallenge('verifier-b');
      expect(a).not.toBe(b);
    });

    it('matches the RFC 7636 S256 test vector', () => {
      // RFC 7636 Appendix B test vector
      const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
      const expectedChallenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
      const challenge = generateCodeChallenge(verifier);
      expect(challenge).toBe(expectedChallenge);
    });
  });

  describe('generateRandomState', () => {
    it('returns a URL-safe base64 string', () => {
      const state = generateRandomState();
      expect(state).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('returns a string of reasonable length for security', () => {
      const state = generateRandomState();
      // 32 bytes = 43 chars in base64url
      expect(state.length).toBeGreaterThanOrEqual(40);
    });

    it('generates unique values', () => {
      const a = generateRandomState();
      const b = generateRandomState();
      expect(a).not.toBe(b);
    });
  });
});
