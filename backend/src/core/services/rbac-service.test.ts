import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the database
vi.mock('../db/postgres.js', () => ({
  query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  getPool: vi.fn().mockReturnValue({}),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

// Mock redis-cache (getRedisClient returns null by default — no caching)
vi.mock('./redis-cache.js', () => ({
  getRedisClient: vi.fn().mockReturnValue(null),
  setRedisClient: vi.fn(),
}));

// Mock logger
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { query as mockQuery } from '../db/postgres.js';
import { getRedisClient } from './redis-cache.js';
import { userHasPermission, getUserSpaceRole, getUserAccessibleSpaces, isSystemAdmin, invalidateRbacCache } from './rbac-service.js';

describe('RBAC service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (mockQuery as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [], rowCount: 0 });
    (getRedisClient as ReturnType<typeof vi.fn>).mockReturnValue(null);
  });

  describe('isSystemAdmin', () => {
    it('should return true for admin users', async () => {
      const queryMock = mockQuery as ReturnType<typeof vi.fn>;
      queryMock.mockResolvedValueOnce({ rows: [{ id: 1 }] });

      const result = await isSystemAdmin('admin-id');
      expect(result).toBe(true);
    });

    it('should return false for non-admin users', async () => {
      const queryMock = mockQuery as ReturnType<typeof vi.fn>;
      queryMock.mockResolvedValueOnce({ rows: [] });

      const result = await isSystemAdmin('user-id');
      expect(result).toBe(false);
    });
  });

  describe('userHasPermission', () => {
    it('should grant permission to admin users', async () => {
      const queryMock = mockQuery as ReturnType<typeof vi.fn>;
      queryMock.mockResolvedValueOnce({ rows: [{ id: 1 }] }); // admin check passes

      const result = await userHasPermission('admin-id', 'edit', 'SPACE1');
      expect(result).toBe(true);
    });

    it('should deny permission when user has no role in space', async () => {
      const queryMock = mockQuery as ReturnType<typeof vi.fn>;
      queryMock.mockResolvedValueOnce({ rows: [] }); // not admin
      queryMock.mockResolvedValueOnce({ rows: [] }); // no direct assignment
      queryMock.mockResolvedValueOnce({ rows: [] }); // no group assignment

      const result = await userHasPermission('user-id', 'edit', 'SPACE1');
      expect(result).toBe(false);
    });

    it('should grant permission via direct assignment', async () => {
      const queryMock = mockQuery as ReturnType<typeof vi.fn>;
      queryMock.mockResolvedValueOnce({ rows: [] }); // not admin
      queryMock.mockResolvedValueOnce({ rows: [{ permissions: ['read', 'comment', 'edit', 'delete'] }] });

      const result = await userHasPermission('user-id', 'edit', 'SPACE1');
      expect(result).toBe(true);
    });

    it('should deny permission when direct role lacks the requested permission', async () => {
      const queryMock = mockQuery as ReturnType<typeof vi.fn>;
      queryMock.mockResolvedValueOnce({ rows: [] }); // not admin
      queryMock.mockResolvedValueOnce({ rows: [{ permissions: ['read'] }] }); // only read
      queryMock.mockResolvedValueOnce({ rows: [] }); // no group assignment

      const result = await userHasPermission('user-id', 'edit', 'SPACE1');
      expect(result).toBe(false);
    });

    it('should grant permission via group membership', async () => {
      const queryMock = mockQuery as ReturnType<typeof vi.fn>;
      queryMock.mockResolvedValueOnce({ rows: [] }); // not admin
      queryMock.mockResolvedValueOnce({ rows: [] }); // no direct assignment
      queryMock.mockResolvedValueOnce({ rows: [{ permissions: ['read'] }] }); // group grants read

      const result = await userHasPermission('user-id', 'read', 'SPACE1');
      expect(result).toBe(true);
    });

    it('should deny permission without space key for non-admin', async () => {
      const queryMock = mockQuery as ReturnType<typeof vi.fn>;
      queryMock.mockResolvedValueOnce({ rows: [] }); // not admin

      const result = await userHasPermission('user-id', 'read');
      expect(result).toBe(false);
    });

    it('should grant admin permission even without space key', async () => {
      const queryMock = mockQuery as ReturnType<typeof vi.fn>;
      queryMock.mockResolvedValueOnce({ rows: [{ id: 1 }] }); // admin check passes

      const result = await userHasPermission('admin-id', 'edit');
      expect(result).toBe(true);
    });

    it('should check page-level ACE when pageId is provided and inherit_perms is false', async () => {
      const queryMock = mockQuery as ReturnType<typeof vi.fn>;
      queryMock.mockResolvedValueOnce({ rows: [] }); // not admin
      queryMock.mockResolvedValueOnce({ rows: [{ inherit_perms: false }] }); // page has custom ACEs
      queryMock.mockResolvedValueOnce({ rows: [{ permission: 'edit' }] }); // ACE grants edit

      const result = await userHasPermission('user-id', 'edit', 'SPACE1', 42);
      expect(result).toBe(true);
    });

    it('should deny page-level permission when ACE does not match', async () => {
      const queryMock = mockQuery as ReturnType<typeof vi.fn>;
      queryMock.mockResolvedValueOnce({ rows: [] }); // not admin
      queryMock.mockResolvedValueOnce({ rows: [{ inherit_perms: false }] }); // page has custom ACEs
      queryMock.mockResolvedValueOnce({ rows: [] }); // no ACE match

      const result = await userHasPermission('user-id', 'edit', 'SPACE1', 42);
      expect(result).toBe(false);
    });

    it('should guard group-based principal_id::INTEGER cast with regex (#409)', async () => {
      const queryMock = mockQuery as ReturnType<typeof vi.fn>;
      queryMock.mockResolvedValueOnce({ rows: [] }); // not admin
      queryMock.mockResolvedValueOnce({ rows: [] }); // no direct assignment
      queryMock.mockResolvedValueOnce({ rows: [] }); // no group assignment

      await userHasPermission('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'read', 'SPACE1');

      // The group-based query (third call) should have the regex guard
      const groupSql = queryMock.mock.calls[2][0] as string;
      expect(groupSql).toContain("principal_id ~ '^\\d+$'");
      expect(groupSql).toContain('principal_id::INTEGER');
    });

    it('should fall through to space check when page inherits perms', async () => {
      const queryMock = mockQuery as ReturnType<typeof vi.fn>;
      queryMock.mockResolvedValueOnce({ rows: [] }); // not admin
      queryMock.mockResolvedValueOnce({ rows: [{ inherit_perms: true }] }); // page inherits
      queryMock.mockResolvedValueOnce({ rows: [{ permissions: ['read', 'edit'] }] }); // direct space assignment

      const result = await userHasPermission('user-id', 'edit', 'SPACE1', 42);
      expect(result).toBe(true);
    });
  });

  describe('getUserSpaceRole', () => {
    it('should return highest role name for user in space', async () => {
      const queryMock = mockQuery as ReturnType<typeof vi.fn>;
      queryMock.mockResolvedValueOnce({ rows: [{ name: 'editor' }] });

      const role = await getUserSpaceRole('user-id', 'SPACE1');
      expect(role).toBe('editor');
    });

    it('should return null when user has no role in space', async () => {
      const queryMock = mockQuery as ReturnType<typeof vi.fn>;
      queryMock.mockResolvedValueOnce({ rows: [] });

      const role = await getUserSpaceRole('user-id', 'SPACE1');
      expect(role).toBeNull();
    });

    it('should guard principal_id::INTEGER cast with regex (#409)', async () => {
      const queryMock = mockQuery as ReturnType<typeof vi.fn>;
      queryMock.mockResolvedValueOnce({ rows: [] });

      await getUserSpaceRole('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'SPACE1');

      const sqlArg = queryMock.mock.calls[0][0] as string;
      expect(sqlArg).toContain("principal_id ~ '^\\d+$'");
    });
  });

  describe('getUserAccessibleSpaces', () => {
    it('should return all spaces for admin users', async () => {
      const queryMock = mockQuery as ReturnType<typeof vi.fn>;
      queryMock.mockResolvedValueOnce({ rows: [{ id: 1 }] }); // admin check
      queryMock.mockResolvedValueOnce({ rows: [
        { space_key: 'DEV' },
        { space_key: 'OPS' },
        { space_key: 'HR' },
      ] });

      const spaces = await getUserAccessibleSpaces('admin-id');
      expect(spaces).toEqual(['DEV', 'OPS', 'HR']);
    });

    it('should return spaces from RBAC assignments (not user_space_selections)', async () => {
      const queryMock = mockQuery as ReturnType<typeof vi.fn>;
      queryMock.mockResolvedValueOnce({ rows: [] }); // not admin
      queryMock.mockResolvedValueOnce({ rows: [
        { space_key: 'DEV' },
        { space_key: 'OPS' },
      ] });

      const spaces = await getUserAccessibleSpaces('user-id');
      expect(spaces).toEqual(['DEV', 'OPS']);
    });

    it('should return empty array when user has no access', async () => {
      const queryMock = mockQuery as ReturnType<typeof vi.fn>;
      queryMock.mockResolvedValueOnce({ rows: [] }); // not admin
      queryMock.mockResolvedValueOnce({ rows: [] }); // no assignments

      const spaces = await getUserAccessibleSpaces('user-id');
      expect(spaces).toEqual([]);
    });

    it('should query space_role_assignments only (not user_space_selections)', async () => {
      const queryMock = mockQuery as ReturnType<typeof vi.fn>;
      queryMock.mockResolvedValueOnce({ rows: [] }); // not admin
      queryMock.mockResolvedValueOnce({ rows: [] }); // no assignments

      await getUserAccessibleSpaces('user-id');

      // The second call (after admin check) should be the spaces query
      const sqlArg = queryMock.mock.calls[1][0] as string;
      expect(sqlArg).toContain('space_role_assignments');
      expect(sqlArg).not.toContain('user_space_selections');
    });

    it('should guard principal_id::int cast with regex to prevent UUID cast crash (#409)', async () => {
      const queryMock = mockQuery as ReturnType<typeof vi.fn>;
      queryMock.mockResolvedValueOnce({ rows: [] }); // not admin
      queryMock.mockResolvedValueOnce({ rows: [{ space_key: 'DEV' }] });

      await getUserAccessibleSpaces('a1b2c3d4-e5f6-7890-abcd-ef1234567890');

      // The spaces query must include a regex guard before the ::int cast
      const sqlArg = queryMock.mock.calls[1][0] as string;
      expect(sqlArg).toContain("principal_id ~ '^\\d+$'");
      expect(sqlArg).toContain('principal_id::int');
    });
  });

  describe('invalidateRbacCache', () => {
    it('should not throw when Redis is unavailable', async () => {
      // Redis client is null (mocked)
      await expect(invalidateRbacCache('user-id')).resolves.not.toThrow();
    });
  });
});
