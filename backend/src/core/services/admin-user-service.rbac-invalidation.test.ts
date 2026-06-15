import { describe, it, expect, vi, beforeEach } from 'vitest';

// ce-svc-security-1: a role change must flush the RBAC Redis caches
// (rbac:admin/spaces/perms/global:<id>) so a demoted admin loses the
// system-admin bypass immediately instead of after the 60s TTL. These tests
// mock the DB + cache layers so the invalidation call can be asserted
// deterministically without a live Redis (the real-DB suite in
// admin-user-service.test.ts can't observe Redis key deletion).

// Fake transactional client whose query() resolves a configurable result per
// call. updateUser issues, in order: BEGIN, SELECT ... FOR UPDATE, UPDATE,
// COMMIT (no token delete unless roleChanged adds one).
function makeClient(existingRole: 'admin' | 'user', newRole: 'admin' | 'user') {
  const userRow = {
    id: 'target-id',
    username: 'demotee',
    email: null,
    display_name: null,
    role: existingRole,
    auth_provider: 'local',
    deactivated_at: null,
    deactivated_by: null,
    deactivated_reason: null,
    created_at: new Date(),
  };
  const updatedRow = { ...userRow, role: newRole };
  const query = vi.fn(async (sql: string) => {
    const text = String(sql);
    if (/FOR UPDATE/.test(text)) return { rows: [userRow], rowCount: 1 };
    if (/^\s*UPDATE users SET/.test(text)) return { rows: [updatedRow], rowCount: 1 };
    if (/pg_advisory_xact_lock/.test(text)) return { rows: [], rowCount: 0 };
    if (/SELECT id\s+FROM users/.test(text)) {
      // assertNotLastActiveAdminTx: pretend another admin exists.
      return { rows: [{ id: 'other-admin' }], rowCount: 1 };
    }
    // BEGIN / COMMIT / DELETE refresh_tokens / etc.
    return { rows: [], rowCount: 0 };
  });
  const release = vi.fn();
  return { query, release };
}

const fakeClient = { client: makeClient('admin', 'user') };

vi.mock('../db/postgres.js', () => ({
  query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  getPool: vi.fn(() => ({ connect: vi.fn(async () => fakeClient.client) })),
  runMigrations: vi.fn(),
  closePool: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('./user-security-cache.js', () => ({
  invalidateUserSecurityState: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./rbac-service.js', () => ({
  invalidateRbacCache: vi.fn().mockResolvedValue(undefined),
}));

import { updateUser } from './admin-user-service.js';
import { invalidateRbacCache } from './rbac-service.js';
import { invalidateUserSecurityState } from './user-security-cache.js';

const rbacMock = invalidateRbacCache as ReturnType<typeof vi.fn>;
const secMock = invalidateUserSecurityState as ReturnType<typeof vi.fn>;

describe('updateUser RBAC cache invalidation (ce-svc-security-1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('flushes the RBAC cache for the user when the role changes (admin -> user)', async () => {
    fakeClient.client = makeClient('admin', 'user');
    await updateUser('target-id', { role: 'user' });

    expect(rbacMock).toHaveBeenCalledTimes(1);
    expect(rbacMock).toHaveBeenCalledWith('target-id');
    // Existing #737 security-state invalidation must still run.
    expect(secMock).toHaveBeenCalledWith('target-id');
  });

  it('does NOT flush the RBAC cache when the role is unchanged', async () => {
    fakeClient.client = makeClient('user', 'user');
    await updateUser('target-id', { displayName: 'Renamed' });

    expect(rbacMock).not.toHaveBeenCalled();
  });
});
