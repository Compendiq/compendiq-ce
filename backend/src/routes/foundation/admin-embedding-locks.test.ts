import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

// Short-circuit DNS lookups performed by the SSRF guard.
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => {
    const err = new Error('getaddrinfo ENOTFOUND (mocked)') as NodeJS.ErrnoException;
    err.code = 'ENOTFOUND';
    throw err;
  }),
}));

import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';
import { buildApp } from '../../app.js';
import { generateAccessToken } from '../../core/plugins/auth.js';
import {
  acquireEmbeddingLock,
  releaseEmbeddingLock,
  forceReleaseEmbeddingLock,
} from '../../core/services/redis-cache.js';

async function createAdminAndLogin(username: string): Promise<{ token: string; userId: string }> {
  const result = await query<{ id: string }>(
    `INSERT INTO users (username, password_hash, role)
     VALUES ($1, 'fakehash', 'admin') RETURNING id`,
    [username],
  );
  const userId = result.rows[0]!.id;
  await query('INSERT INTO user_settings (user_id) VALUES ($1)', [userId]);
  const token = await generateAccessToken({ sub: userId, username, role: 'admin' });
  return { token, userId };
}

async function createMemberAndLogin(username: string): Promise<{ token: string; userId: string }> {
  const result = await query<{ id: string }>(
    `INSERT INTO users (username, password_hash, role)
     VALUES ($1, 'fakehash', 'member') RETURNING id`,
    [username],
  );
  const userId = result.rows[0]!.id;
  await query('INSERT INTO user_settings (user_id) VALUES ($1)', [userId]);
  const token = await generateAccessToken({ sub: userId, username, role: 'member' });
  return { token, userId };
}

const dbAvailable = await isDbAvailable();

let app: FastifyInstance;
let adminToken: string;
let adminUserId: string;

beforeAll(async () => {
  if (!dbAvailable) return;
  await setupTestDb();
  app = await buildApp();
  await app.ready();
}, 30_000);

afterAll(async () => {
  if (!dbAvailable) return;
  await app?.close();
  await teardownTestDb();
});

beforeEach(async () => {
  if (!dbAvailable) return;
  await truncateAllTables();
  // Clear any Redis state that may linger between cases (lock keys live there,
  // not in Postgres).
  await forceReleaseEmbeddingLock('alice');
  await forceReleaseEmbeddingLock('bob');
  await forceReleaseEmbeddingLock('__reembed_all__');
  ({ token: adminToken, userId: adminUserId } = await createAdminAndLogin('locks_admin'));
});

describe.skipIf(!dbAvailable)('GET /api/admin/embedding/locks', () => {
  // RED #11a (plan §4.6)
  it('returns an EmbeddingLockSnapshot[] for each currently-held per-user lock', async () => {
    const aliceLockId = await acquireEmbeddingLock('alice');
    expect(aliceLockId).toBeTruthy();

    try {
      const r = await app.inject({
        method: 'GET',
        url: '/api/admin/embedding/locks',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(Array.isArray(body.locks)).toBe(true);
      const alice = body.locks.find((l: { userId: string }) => l.userId === 'alice');
      expect(alice).toBeTruthy();
      expect(alice.holderEpoch).toBe(aliceLockId);
      expect(typeof alice.ttlRemainingMs).toBe('number');
      expect(alice.ttlRemainingMs).toBeGreaterThan(0);
    } finally {
      await releaseEmbeddingLock('alice', aliceLockId!);
    }
  });

  // RED #11b
  it('filters out the synthetic __reembed_all__ system lock', async () => {
    const reembedLockId = await acquireEmbeddingLock('__reembed_all__');
    try {
      const r = await app.inject({
        method: 'GET',
        url: '/api/admin/embedding/locks',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(r.statusCode).toBe(200);
      const body = r.json();
      const systemLock = body.locks.find((l: { userId: string }) => l.userId === '__reembed_all__');
      expect(systemLock).toBeUndefined();
    } finally {
      await releaseEmbeddingLock('__reembed_all__', reembedLockId!);
    }
  });

  it('returns { locks: [] } when no per-user locks are held', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/admin/embedding/locks',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().locks).toEqual([]);
  });

  // RED #11e (non-admin forbidden)
  it('returns 403 for non-admin callers', async () => {
    const { token: memberToken } = await createMemberAndLogin('locks_member');
    const r = await app.inject({
      method: 'GET',
      url: '/api/admin/embedding/locks',
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(r.statusCode).toBe(403);
  });

  it('returns 401 without auth', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/admin/embedding/locks',
    });
    expect(r.statusCode).toBe(401);
  });
});

describe.skipIf(!dbAvailable)('POST /api/admin/embedding/locks/:userId/release', () => {
  // RED #11c — force-release happy path + audit log
  it('releases an existing lock and writes an ADMIN_ACTION audit row', async () => {
    const aliceLockId = await acquireEmbeddingLock('alice');
    expect(aliceLockId).toBeTruthy();

    const r = await app.inject({
      method: 'POST',
      url: '/api/admin/embedding/locks/alice/release',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ released: true, userId: 'alice' });

    // Audit row present
    const { rows } = await query<{
      user_id: string;
      action: string;
      resource_type: string;
      resource_id: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT user_id, action, resource_type, resource_id, metadata::jsonb AS metadata
         FROM audit_log
        WHERE action = 'ADMIN_ACTION'
          AND resource_type = 'embedding_lock'
        ORDER BY created_at DESC
        LIMIT 1`,
    );
    expect(rows).toHaveLength(1);
    const audit = rows[0]!;
    expect(audit.user_id).toBe(adminUserId);
    expect(audit.resource_id).toBe('alice');
    expect(audit.metadata).toMatchObject({
      action: 'force_release_embedding_lock',
      targetUserId: 'alice',
      released: true,
    });
  });

  // RED #11d — idempotent on non-existent
  it('returns 200 { released: false } when the lock was already gone', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/admin/embedding/locks/ghost-user/release',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ released: false, userId: 'ghost-user' });

    // Still writes an audit row so deliberate no-ops are observable.
    const { rows } = await query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata::jsonb AS metadata FROM audit_log
        WHERE action = 'ADMIN_ACTION'
          AND resource_id = 'ghost-user'
        ORDER BY created_at DESC LIMIT 1`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata).toMatchObject({
      action: 'force_release_embedding_lock',
      released: false,
    });
  });

  // RED #11e — non-admin forbidden (no audit row)
  it('returns 403 for non-admin callers and writes no audit row', async () => {
    const { token: memberToken } = await createMemberAndLogin('locks_member_release');
    const r = await app.inject({
      method: 'POST',
      url: '/api/admin/embedding/locks/alice/release',
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(r.statusCode).toBe(403);

    const { rows } = await query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM audit_log
        WHERE action = 'ADMIN_ACTION'
          AND resource_type = 'embedding_lock'`,
    );
    expect(rows[0]!.c).toBe('0');
  });

  it('returns 401 without auth', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/admin/embedding/locks/alice/release',
    });
    expect(r.statusCode).toBe(401);
  });

  // userId param validation
  it('rejects empty userId (router match on trailing slash)', async () => {
    // Fastify's router will 404 a truly empty path param.
    const r = await app.inject({
      method: 'POST',
      url: '/api/admin/embedding/locks//release',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect([400, 404]).toContain(r.statusCode);
  });
});
