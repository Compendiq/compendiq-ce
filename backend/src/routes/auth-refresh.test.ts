import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../test-db-helper.js';
import { query } from '../db/postgres.js';
import {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
  revokeToken,
  revokeTokenFamily,
  revokeAllUserTokens,
  cleanupExpiredTokens,
  verifyToken,
} from '../plugins/auth.js';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('Refresh Token Rotation and Revocation', () => {
  let testUserId: string;

  const testPayload = () => ({
    sub: testUserId,
    username: 'testuser',
    role: 'user' as const,
  });

  beforeAll(async () => {
    await setupTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    // Create test user
    const result = await query<{ id: string }>(
      "INSERT INTO users (username, password_hash, role) VALUES ('testuser', 'fakehash', 'user') RETURNING id",
    );
    testUserId = result.rows[0].id;
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  describe('generateRefreshToken', () => {
    it('should generate a token with JTI and family', async () => {
      const result = await generateRefreshToken(testPayload());
      expect(result.token).toBeTruthy();
      expect(result.jti).toBeTruthy();
      expect(result.family).toBeTruthy();
    });

    it('should store the JTI in the database', async () => {
      const { jti } = await generateRefreshToken(testPayload());
      const dbResult = await query<{ jti: string; revoked: boolean }>(
        'SELECT jti, revoked FROM refresh_tokens WHERE jti = $1',
        [jti],
      );
      expect(dbResult.rows).toHaveLength(1);
      expect(dbResult.rows[0].jti).toBe(jti);
      expect(dbResult.rows[0].revoked).toBe(false);
    });

    it('should create a new family when none provided', async () => {
      const result1 = await generateRefreshToken(testPayload());
      const result2 = await generateRefreshToken(testPayload());
      expect(result1.family).not.toBe(result2.family);
    });

    it('should use the provided family for rotation', async () => {
      const firstToken = await generateRefreshToken(testPayload());
      const secondToken = await generateRefreshToken(testPayload(), firstToken.family);
      expect(secondToken.family).toBe(firstToken.family);
    });

    it('should generate unique JTIs', async () => {
      const t1 = await generateRefreshToken(testPayload());
      const t2 = await generateRefreshToken(testPayload());
      expect(t1.jti).not.toBe(t2.jti);
    });
  });

  describe('verifyRefreshToken', () => {
    it('should verify a valid refresh token', async () => {
      const { token } = await generateRefreshToken(testPayload());
      const payload = await verifyRefreshToken(token);
      expect(payload.sub).toBe(testUserId);
      expect(payload.username).toBe('testuser');
      expect(payload.jti).toBeTruthy();
      expect(payload.family).toBeTruthy();
    });

    it('should reject a revoked token', async () => {
      const { token, jti } = await generateRefreshToken(testPayload());
      await revokeToken(jti);
      // Attempting to use a revoked token should trigger family revocation
      await expect(verifyRefreshToken(token)).rejects.toThrow(/reuse detected/);
    });

    it('should revoke entire family on reuse detection', async () => {
      // Create a token family with 3 tokens
      const t1 = await generateRefreshToken(testPayload());
      await generateRefreshToken(testPayload(), t1.family);
      await generateRefreshToken(testPayload(), t1.family);

      // Revoke t1 (simulating it was already used/rotated)
      await revokeToken(t1.jti);

      // Attempting to use revoked t1 should revoke entire family
      await expect(verifyRefreshToken(t1.token)).rejects.toThrow(/reuse detected/);

      // All tokens in family should now be revoked
      const familyTokens = await query<{ revoked: boolean }>(
        'SELECT revoked FROM refresh_tokens WHERE family = $1',
        [t1.family],
      );
      expect(familyTokens.rows.every((r) => r.revoked)).toBe(true);
    });
  });

  describe('revokeToken', () => {
    it('should mark a single token as revoked', async () => {
      const { jti } = await generateRefreshToken(testPayload());
      await revokeToken(jti);

      const result = await query<{ revoked: boolean }>(
        'SELECT revoked FROM refresh_tokens WHERE jti = $1',
        [jti],
      );
      expect(result.rows[0].revoked).toBe(true);
    });
  });

  describe('revokeTokenFamily', () => {
    it('should revoke all tokens in a family', async () => {
      const t1 = await generateRefreshToken(testPayload());
      await generateRefreshToken(testPayload(), t1.family);
      await generateRefreshToken(testPayload(), t1.family);

      await revokeTokenFamily(t1.family);

      const result = await query<{ revoked: boolean }>(
        'SELECT revoked FROM refresh_tokens WHERE family = $1',
        [t1.family],
      );
      expect(result.rows).toHaveLength(3);
      expect(result.rows.every((r) => r.revoked)).toBe(true);
    });
  });

  describe('revokeAllUserTokens', () => {
    it('should revoke all tokens for a user (logout)', async () => {
      // Create multiple families
      await generateRefreshToken(testPayload());
      await generateRefreshToken(testPayload());
      await generateRefreshToken(testPayload());

      await revokeAllUserTokens(testUserId);

      const result = await query<{ revoked: boolean }>(
        'SELECT revoked FROM refresh_tokens WHERE user_id = $1',
        [testUserId],
      );
      expect(result.rows.length).toBe(3);
      expect(result.rows.every((r) => r.revoked)).toBe(true);
    });
  });

  describe('cleanupExpiredTokens', () => {
    it('should delete expired tokens', async () => {
      await generateRefreshToken(testPayload());

      // Manually expire the token
      await query(
        "UPDATE refresh_tokens SET expires_at = NOW() - INTERVAL '1 day' WHERE user_id = $1",
        [testUserId],
      );

      const deleted = await cleanupExpiredTokens();
      expect(deleted).toBe(1);

      const remaining = await query(
        'SELECT COUNT(*) as count FROM refresh_tokens WHERE user_id = $1',
        [testUserId],
      );
      expect(parseInt(remaining.rows[0].count, 10)).toBe(0);
    });

    it('should not delete non-expired tokens', async () => {
      await generateRefreshToken(testPayload());
      const deleted = await cleanupExpiredTokens();
      expect(deleted).toBe(0);
    });
  });

  describe('Token rotation flow (integration)', () => {
    it('should support full rotation cycle', async () => {
      // 1. Login: generate initial tokens
      const initial = await generateRefreshToken(testPayload());

      // 2. Verify the refresh token works
      const verified = await verifyRefreshToken(initial.token);
      expect(verified.sub).toBe(testUserId);

      // 3. Rotate: revoke old, issue new in same family
      await revokeToken(initial.jti);
      const rotated = await generateRefreshToken(testPayload(), initial.family);

      // 4. New token should work
      const verifiedNew = await verifyRefreshToken(rotated.token);
      expect(verifiedNew.sub).toBe(testUserId);
      expect(verifiedNew.family).toBe(initial.family);

      // 5. Old token should trigger reuse detection
      await expect(verifyRefreshToken(initial.token)).rejects.toThrow(/reuse detected/);
    });

    it('should generate valid access tokens', async () => {
      const accessToken = await generateAccessToken(testPayload());
      const payload = await verifyToken(accessToken);
      expect(payload.sub).toBe(testUserId);
      expect(payload.username).toBe('testuser');
    });
  });

  describe('Logout with expired access token (refresh cookie fallback)', () => {
    it('should allow user identification from refresh token when access token is unavailable', async () => {
      // Simulate the logout flow when access token has expired:
      // 1. Generate refresh token (as if user was logged in)
      const { token: refreshToken } = await generateRefreshToken(testPayload());

      // 2. Verify refresh token to extract user ID (fallback path)
      const payload = await verifyRefreshToken(refreshToken);
      expect(payload.sub).toBe(testUserId);

      // 3. Revoke all user tokens (logout)
      await revokeAllUserTokens(payload.sub);

      // 4. Verify all tokens are revoked
      const result = await query<{ revoked: boolean }>(
        'SELECT revoked FROM refresh_tokens WHERE user_id = $1',
        [testUserId],
      );
      expect(result.rows.every((r) => r.revoked)).toBe(true);
    });

    it('should revoke the specific refresh token JTI during logout fallback', async () => {
      const { token: refreshToken } = await generateRefreshToken(testPayload());

      // Verify and get payload with JTI
      const payload = await verifyRefreshToken(refreshToken);

      // Revoke specific JTI (as the logout route does before revoking all)
      await revokeToken(payload.jti);

      // Then revoke all user tokens
      await revokeAllUserTokens(payload.sub);

      // Verify the specific JTI is revoked
      const result = await query<{ revoked: boolean }>(
        'SELECT revoked FROM refresh_tokens WHERE jti = $1',
        [payload.jti],
      );
      expect(result.rows[0].revoked).toBe(true);
    });
  });
});
