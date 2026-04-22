import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

import {
  setupTestDb,
  truncateAllTables,
  teardownTestDb,
  isDbAvailable,
} from '../../test-db-helper.js';
import { query } from '../db/postgres.js';
import { buildApp } from '../../app.js';
import { generateAccessToken } from './auth.js';

/**
 * Integration tests for the `requireAdmin` decorator's audit-logging behaviour.
 *
 * Scope (#264):
 *   - Path A: unauthenticated request → `ADMIN_ACCESS_DENIED` row with user_id=NULL,
 *     metadata.reason='unauthenticated'. Status 401.
 *   - Path B: authenticated non-admin → `ADMIN_ACCESS_DENIED` row with user_id=<caller>,
 *     metadata.reason='not_admin'. Status 403.
 *   - Admin success → no `ADMIN_ACCESS_DENIED` row.
 *
 * Routes targeted:
 *   - `GET /api/admin/audit-log` — registered under `adminRoutes`, which uses
 *     `fastify.addHook('onRequest', fastify.requireAdmin)` (admin.ts:48). Both the
 *     authentication failure (Path A) and the role-check failure (Path B) therefore
 *     flow through the decorator, so both code paths are exercised from this single
 *     route. This is the ONLY CE pattern where unauthenticated requests reach
 *     `requireAdmin`; routes using `addHook('onRequest', authenticate)` + `preHandler:
 *     requireAdmin` short-circuit at the onRequest stage before the decorator runs.
 */

async function createUser(username: string, role: 'admin' | 'user'): Promise<string> {
  const result = await query<{ id: string }>(
    `INSERT INTO users (username, password_hash, role)
     VALUES ($1, 'fakehash', $2) RETURNING id`,
    [username, role],
  );
  return result.rows[0]!.id;
}

const dbAvailable = await isDbAvailable();

let app: FastifyInstance;

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
});

describe.skipIf(!dbAvailable)('requireAdmin — ADMIN_ACCESS_DENIED audit', () => {
  // RED #1 — non-admin → 403 + audit row with reason 'not_admin'
  it('writes ADMIN_ACCESS_DENIED when a non-admin is rejected', async () => {
    const userId = await createUser('denied_nonadmin', 'user');
    const token = await generateAccessToken({ sub: userId, username: 'denied_nonadmin', role: 'user' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/audit-log',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(403);

    const rows = await query<{
      user_id: string | null;
      action: string;
      resource_type: string | null;
      resource_id: string | null;
      metadata: Record<string, unknown>;
    }>(
      `SELECT user_id, action, resource_type, resource_id, metadata::jsonb AS metadata
         FROM audit_log
        WHERE action = 'ADMIN_ACCESS_DENIED'
        ORDER BY created_at DESC
        LIMIT 1`,
    );
    expect(rows.rows).toHaveLength(1);
    const row = rows.rows[0]!;
    expect(row.user_id).toBe(userId);
    expect(row.resource_type).toBe('route');
    expect(row.resource_id).toMatch(/^GET .+\/admin\/audit-log$/);
    expect(row.metadata).toMatchObject({ decision: 'denied', reason: 'not_admin' });
  });

  // RED #2 — unauth → 401 + audit row with user_id=NULL, reason 'unauthenticated'
  it('writes ADMIN_ACCESS_DENIED with user_id=null when the caller is unauthenticated', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/audit-log',
    });

    expect(res.statusCode).toBe(401);

    const rows = await query<{
      user_id: string | null;
      resource_type: string | null;
      resource_id: string | null;
      metadata: Record<string, unknown>;
    }>(
      `SELECT user_id, resource_type, resource_id, metadata::jsonb AS metadata
         FROM audit_log
        WHERE action = 'ADMIN_ACCESS_DENIED'
        ORDER BY created_at DESC
        LIMIT 1`,
    );
    expect(rows.rows).toHaveLength(1);
    const row = rows.rows[0]!;
    expect(row.user_id).toBeNull();
    expect(row.resource_type).toBe('route');
    expect(row.resource_id).toMatch(/^GET .+\/admin\/audit-log$/);
    expect(row.metadata).toMatchObject({ decision: 'denied', reason: 'unauthenticated' });
  });

  // RED #3 — admin success does NOT write ADMIN_ACCESS_DENIED
  it('does not write ADMIN_ACCESS_DENIED for a successful admin request', async () => {
    const adminId = await createUser('admin_ok', 'admin');
    const token = await generateAccessToken({ sub: adminId, username: 'admin_ok', role: 'admin' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/audit-log',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);

    const r = await query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM audit_log WHERE action = 'ADMIN_ACCESS_DENIED'`,
    );
    expect(r.rows[0]!.c).toBe('0');
  });

  // Completes in well under the default Fastify/Node HTTP timeout — the audit
  // write is inline `await`, and `logAuditEvent` is wrapped in try/catch so a
  // pathological DB failure cannot deadlock the response. This guards against
  // a future refactor that accidentally swallows the response past the wait.
  it('returns 403 promptly even when a denied-attempt audit is emitted', async () => {
    const userId = await createUser('denied_timing', 'user');
    const token = await generateAccessToken({ sub: userId, username: 'denied_timing', role: 'user' });

    const t0 = Date.now();
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/audit-log',
      headers: { authorization: `Bearer ${token}` },
    });
    const elapsed = Date.now() - t0;

    expect(res.statusCode).toBe(403);
    // Comfortable margin — a local query round-trip is single-digit ms in CI.
    // If this ever gets flaky, bump to 5000 before assuming a regression.
    expect(elapsed).toBeLessThan(2000);
  });
});
