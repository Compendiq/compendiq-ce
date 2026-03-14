import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the database
vi.mock('../db/postgres.js', () => ({
  query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  getPool: vi.fn().mockReturnValue({}),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

import { query as mockQuery } from '../db/postgres.js';
import { userHasPermission, getUserSpaceRole } from './rbac-service.js';

describe('RBAC service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (mockQuery as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [], rowCount: 0 });
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
});
