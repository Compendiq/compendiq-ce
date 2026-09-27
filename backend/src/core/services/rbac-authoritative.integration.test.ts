import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type RedisClientType } from 'redis';
import { getPool, query } from '../db/postgres.js';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { setRedisClient } from './redis-cache.js';
import { runWithRbacScope } from './rbac-request-scope.js';
import {
  getUserAccessibleSpaces,
  getUserAccessibleSpacesMemoized,
  isSystemAdmin,
  userCanAccessPage,
  userHasPermission,
} from './rbac-service.js';

const available = await isDbAvailable() && await isRedisAvailable();

describe.skipIf(!available)('transaction-authoritative page permissions', () => {
  const redis = createClient({
    url: process.env.REDIS_URL,
    socket: { reconnectStrategy: false, connectTimeout: 1_000 },
  });
  let actorId: string;
  let pageId: number;
  let roleId: number;

  beforeAll(async () => {
    await setupTestDb();
    await redis.connect();
    setRedisClient(redis as RedisClientType);
  });

  afterAll(async () => {
    if (redis.isOpen) await redis.quit();
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    await redis.flushDb();
    const actor = await query<{ id: string }>(
      "INSERT INTO users (username, password_hash, role) VALUES ('authority-reader', 'x', 'user') RETURNING id",
    );
    actorId = actor.rows[0]!.id;
    const role = await query<{ id: number }>(
      "INSERT INTO roles (name, display_name, permissions) VALUES ('baseline-manager', 'Manager', ARRAY['read', 'manage']) RETURNING id",
    );
    roleId = role.rows[0]!.id;
    await query("INSERT INTO spaces (space_key, space_name) VALUES ('BASELINE', 'Baseline')");
    const page = await query<{ id: number }>(
      `INSERT INTO pages (confluence_id, source, space_key, title, body_storage, body_html, body_text, inherit_perms)
       VALUES ('authority-page', 'confluence', 'BASELINE', 'Authority', '', '<p>Authority</p>', 'Authority', TRUE)
       RETURNING id`,
    );
    pageId = page.rows[0]!.id;
  });

  it('observes an uncommitted admin revocation without trusting or poisoning Redis', async () => {
    await query("UPDATE users SET role = 'admin' WHERE id = $1", [actorId]);
    expect(await isSystemAdmin(actorId)).toBe(true);
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query("UPDATE users SET role = 'user' WHERE id = $1", [actorId]);
      expect(await isSystemAdmin(actorId, client)).toBe(false);
      expect(await userHasPermission(actorId, 'manage', 'BASELINE', pageId, client)).toBe(false);
      expect(await userCanAccessPage(actorId, pageId, client)).toBe(false);
      expect(await getUserAccessibleSpaces(actorId, client)).toEqual([]);
      expect(await isSystemAdmin(actorId)).toBe(true);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    expect(await isSystemAdmin(actorId)).toBe(true);
  });

  it('rejects revoked group authority despite both Redis and request-scoped grants', async () => {
    const group = await query<{ id: number }>(
      "INSERT INTO groups (name) VALUES ('baseline-reviewers') RETURNING id",
    );
    await query('INSERT INTO group_memberships (group_id, user_id) VALUES ($1, $2)', [group.rows[0]!.id, actorId]);
    await query(
      `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
       VALUES ('BASELINE', 'group', $1, $2)`,
      [String(group.rows[0]!.id), roleId],
    );
    await runWithRbacScope(actorId, async () => {
      expect(await getUserAccessibleSpacesMemoized(actorId)).toEqual(['BASELINE']);
      expect(await userHasPermission(actorId, 'manage', 'BASELINE', pageId)).toBe(true);
      expect(await userCanAccessPage(actorId, pageId)).toBe(true);
      const client = await getPool().connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM group_memberships WHERE user_id = $1', [actorId]);
        expect(await userHasPermission(actorId, 'manage', 'BASELINE', pageId, client)).toBe(false);
        expect(await userCanAccessPage(actorId, pageId, client)).toBe(false);
        expect(await getUserAccessibleSpaces(actorId, client)).toEqual([]);
        // Transaction-local decisions must not escape into the shared readers.
        expect(await getUserAccessibleSpacesMemoized(actorId)).toEqual(['BASELINE']);
        expect(await userHasPermission(actorId, 'manage', 'BASELINE', pageId)).toBe(true);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });
  });

  it('honours a transaction-local page ACE override instead of a cached space grant', async () => {
    await query(
      `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
       VALUES ('BASELINE', 'user', $1, $2)`,
      [actorId, roleId],
    );
    expect(await userHasPermission(actorId, 'manage', 'BASELINE', pageId)).toBe(true);
    expect(await userCanAccessPage(actorId, pageId)).toBe(true);
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE pages SET inherit_perms = FALSE WHERE id = $1', [pageId]);
      expect(await userHasPermission(actorId, 'manage', 'BASELINE', pageId, client)).toBe(false);
      expect(await userCanAccessPage(actorId, pageId, client)).toBe(false);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    expect(await userCanAccessPage(actorId, pageId)).toBe(true);
  });
});
