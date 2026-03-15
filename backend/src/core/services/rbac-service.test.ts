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
import { userHasPermission, getUserSpaceRole, getUserAccessibleSpaces, invalidatePermissionCache } from './rbac-service.js';

describe('RBAC service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (mockQuery as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [], rowCount: 0 });
    (getRedisClient as ReturnType<typeof vi.fn>).mockReturnValue(null);
  });

  describe('userHasPermission', () => {
    it('should grant permission to admin users', async () => {
      const queryMock = mockQuery as ReturnType<typeof vi.fn>;
      queryMock.mockResolvedValueOnce({ rows: [{ id: 1 }] }); // admin check passes

      const result = await userHasPermission('admin-id', 'edit', 'SPACE1');
      expect(result).toBe(true);
      expect(queryMock).toHaveBeenCalledTimes(1); // only admin check, no further queries
    });

    it('should deny permission when user has no role in space', async () => {
      const queryMock = mockQuery as ReturnType<typeof vi.fn>;
      queryMock.mockResolvedValueOnce({ rows: [] }); // not admin
      queryMock.mockResolvedValueOnce({ rows: [] }); // no direct assignment
      queryMock.mockResolvedValueOnce({ rows: [] }); // no group assignment

      const result = await userHasPermission('user-id', 'edit', 'SPACE1');
      expect(result).toBe(false);
      expect(queryMock).toHaveBeenCalledTimes(3);
    });

    it('should grant permission via direct assignment', async () => {
      const queryMock = mockQuery as ReturnType<typeof vi.fn>;
      queryMock.mockResolvedValueOnce({ rows: [] }); // not admin
      queryMock.mockResolvedValueOnce({ rows: [{ permissions: ['read', 'comment', 'edit', 'delete'] }] });

      const result = await userHasPermission('user-id', 'edit', 'SPACE1');
      expect(result).toBe(true);
      expect(queryMock).toHaveBeenCalledTimes(2); // admin check + direct check
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
      expect(queryMock).toHaveBeenCalledTimes(1); // only admin check
    });

    it('should grant admin permission even without space key', async () => {
      const queryMock = mockQuery as ReturnType<typeof vi.fn>;
      queryMock.mockResolvedValueOnce({ rows: [{ id: 1 }] }); // admin check passes

      const result = await userHasPermission('admin-id', 'edit');
      expect(result).toBe(true);
    });

    it('should use Redis cache when available', async () => {
      const mockRedis = {
        get: vi.fn().mockResolvedValue('1'), // cached as granted
        set: vi.fn().mockResolvedValue('OK'),
      };
      (getRedisClient as ReturnType<typeof vi.fn>).mockReturnValue(mockRedis);

      const queryMock = mockQuery as ReturnType<typeof vi.fn>;
      queryMock.mockResolvedValueOnce({ rows: [] }); // not admin

      const result = await userHasPermission('user-id', 'edit', 'SPACE1');
      expect(result).toBe(true);
      // Should read from cache, not query direct/group checks
      expect(mockRedis.get).toHaveBeenCalledWith('rbac:perm:user-id:SPACE1:edit');
      expect(queryMock).toHaveBeenCalledTimes(1); // only admin check
    });

    it('should fall back to DB when Redis cache misses', async () => {
      const mockRedis = {
        get: vi.fn().mockResolvedValue(null), // cache miss
        set: vi.fn().mockResolvedValue('OK'),
      };
      (getRedisClient as ReturnType<typeof vi.fn>).mockReturnValue(mockRedis);

      const queryMock = mockQuery as ReturnType<typeof vi.fn>;
      queryMock.mockResolvedValueOnce({ rows: [] }); // not admin
      queryMock.mockResolvedValueOnce({ rows: [{ permissions: ['read', 'edit'] }] }); // direct

      const result = await userHasPermission('user-id', 'edit', 'SPACE1');
      expect(result).toBe(true);
      // Should cache the result
      expect(mockRedis.set).toHaveBeenCalledWith(
        'rbac:perm:user-id:SPACE1:edit',
        '1',
        { EX: 60 },
      );
    });

    it('should cache denied results too', async () => {
      const mockRedis = {
        get: vi.fn().mockResolvedValue(null), // cache miss
        set: vi.fn().mockResolvedValue('OK'),
      };
      (getRedisClient as ReturnType<typeof vi.fn>).mockReturnValue(mockRedis);

      const queryMock = mockQuery as ReturnType<typeof vi.fn>;
      queryMock.mockResolvedValueOnce({ rows: [] }); // not admin
      queryMock.mockResolvedValueOnce({ rows: [] }); // no direct
      queryMock.mockResolvedValueOnce({ rows: [] }); // no group

      const result = await userHasPermission('user-id', 'edit', 'SPACE1');
      expect(result).toBe(false);
      expect(mockRedis.set).toHaveBeenCalledWith(
        'rbac:perm:user-id:SPACE1:edit',
        '0',
        { EX: 60 },
      );
    });

    it('should return false from cached denial', async () => {
      const mockRedis = {
        get: vi.fn().mockResolvedValue('0'), // cached as denied
        set: vi.fn().mockResolvedValue('OK'),
      };
      (getRedisClient as ReturnType<typeof vi.fn>).mockReturnValue(mockRedis);

      const queryMock = mockQuery as ReturnType<typeof vi.fn>;
      queryMock.mockResolvedValueOnce({ rows: [] }); // not admin

      const result = await userHasPermission('user-id', 'edit', 'SPACE1');
      expect(result).toBe(false);
      expect(queryMock).toHaveBeenCalledTimes(1); // only admin check
    });

    it('should gracefully handle Redis errors on read', async () => {
      const mockRedis = {
        get: vi.fn().mockRejectedValue(new Error('Redis down')),
        set: vi.fn().mockResolvedValue('OK'),
      };
      (getRedisClient as ReturnType<typeof vi.fn>).mockReturnValue(mockRedis);

      const queryMock = mockQuery as ReturnType<typeof vi.fn>;
      queryMock.mockResolvedValueOnce({ rows: [] }); // not admin
      queryMock.mockResolvedValueOnce({ rows: [{ permissions: ['edit'] }] }); // direct

      // Should still work by falling back to DB
      const result = await userHasPermission('user-id', 'edit', 'SPACE1');
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
  });

  describe('getUserAccessibleSpaces', () => {
    it('should return space keys from direct and group assignments', async () => {
      const queryMock = mockQuery as ReturnType<typeof vi.fn>;
      queryMock.mockResolvedValueOnce({
        rows: [{ space_key: 'ENG' }, { space_key: 'HR' }],
      });

      const spaces = await getUserAccessibleSpaces('user-id');
      expect(spaces).toEqual(['ENG', 'HR']);
    });

    it('should return empty array when user has no space assignments', async () => {
      const queryMock = mockQuery as ReturnType<typeof vi.fn>;
      queryMock.mockResolvedValueOnce({ rows: [] });

      const spaces = await getUserAccessibleSpaces('user-id');
      expect(spaces).toEqual([]);
    });

    it('should query space_role_assignments only (not user_space_selections)', async () => {
      const queryMock = mockQuery as ReturnType<typeof vi.fn>;
      queryMock.mockResolvedValueOnce({ rows: [] });

      await getUserAccessibleSpaces('user-id');

      // Verify the SQL does NOT reference user_space_selections
      const sqlArg = queryMock.mock.calls[0][0] as string;
      expect(sqlArg).toContain('space_role_assignments');
      expect(sqlArg).not.toContain('user_space_selections');
    });
  });

  describe('invalidatePermissionCache', () => {
    it('should scan and delete all cached permissions for a user', async () => {
      const mockRedis = {
        scan: vi.fn()
          .mockResolvedValueOnce({ cursor: 0, keys: ['rbac:perm:user-1:ENG:read', 'rbac:perm:user-1:HR:edit'] }),
        del: vi.fn().mockResolvedValue(2),
      };
      (getRedisClient as ReturnType<typeof vi.fn>).mockReturnValue(mockRedis);

      await invalidatePermissionCache('user-1');

      expect(mockRedis.scan).toHaveBeenCalledWith('0', { MATCH: 'rbac:perm:user-1:*', COUNT: 100 });
      expect(mockRedis.del).toHaveBeenCalledWith(['rbac:perm:user-1:ENG:read', 'rbac:perm:user-1:HR:edit']);
    });

    it('should be a no-op when Redis is not available', async () => {
      (getRedisClient as ReturnType<typeof vi.fn>).mockReturnValue(null);

      // Should not throw
      await invalidatePermissionCache('user-1');
    });
  });
});
