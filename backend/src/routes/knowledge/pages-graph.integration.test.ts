/**
 * Integration tests for the #360 graph filter query params.
 *
 * The companion file `pages-graph.test.ts` exercises the routes against
 * a mocked DB so we can assert what arrives at the `query()` boundary.
 * That suite proves the `edgeTypes` whitelist filter at the schema layer.
 *
 * THIS file additionally pins the security contract end-to-end against a
 * real PostgreSQL instance (per CLAUDE.md "Backend DB tests: Use real
 * PostgreSQL"). The injection-style values are passed through Fastify,
 * Zod, the route handler, the connection pool, and finally the SQL
 * planner — and the tables remain intact and untampered.
 *
 * The suite auto-skips on a fresh dev box without the test DB reachable.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createClient } from 'redis';

// SSRF guard performs a DNS lookup at app boot; short-circuit it so the
// test runner doesn't try to resolve external hosts.
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

async function checkRedisReachable(): Promise<boolean> {
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const probe = createClient({ url });
  probe.on('error', () => { /* swallow */ });
  try {
    await probe.connect();
    await probe.ping();
    await probe.quit();
    return true;
  } catch {
    try { await probe.quit(); } catch { /* best effort */ }
    return false;
  }
}

const dbAvailable = await isDbAvailable();
const redisAvailable = dbAvailable ? await checkRedisReachable() : false;
const canRun = dbAvailable && redisAvailable;

let app: FastifyInstance;

async function createUserAndLogin(username: string): Promise<{ token: string; userId: string }> {
  const r = await query<{ id: string }>(
    `INSERT INTO users (username, password_hash, role)
     VALUES ($1, 'fakehash', 'user') RETURNING id`,
    [username],
  );
  const userId = r.rows[0]!.id;
  await query('INSERT INTO user_settings (user_id) VALUES ($1)', [userId]);
  const token = await generateAccessToken({ sub: userId, username, role: 'user' });
  return { token, userId };
}

async function grantSpaceRead(userId: string, spaceKey: string): Promise<void> {
  await query(
    `INSERT INTO roles (name, display_name, is_system, permissions)
     VALUES ('graph_test_reader', 'Graph Test Reader', FALSE, ARRAY['read'])
     ON CONFLICT (name) DO NOTHING`,
  );
  const roleRes = await query<{ id: number }>(
    "SELECT id FROM roles WHERE name = 'graph_test_reader' LIMIT 1",
  );
  const roleId = roleRes.rows[0]!.id;

  await query(
    `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
     VALUES ($1, 'user', $2, $3)
     ON CONFLICT DO NOTHING`,
    [spaceKey, userId, roleId],
  );
}

async function insertPage(spaceKey: string, confluenceId: string, title: string): Promise<number> {
  const r = await query<{ id: number }>(
    `INSERT INTO pages (
        confluence_id, space_key, title, body_storage, body_html, body_text,
        version, source, visibility, last_synced
     ) VALUES ($1, $2, $3, '<p></p>', '<p></p>', '', 1, 'confluence', 'shared', NOW())
     RETURNING id`,
    [confluenceId, spaceKey, title],
  );
  return r.rows[0]!.id;
}

async function insertRelationship(
  pageA: number,
  pageB: number,
  type: string,
  score: number,
): Promise<void> {
  await query(
    `INSERT INTO page_relationships (page_id_1, page_id_2, relationship_type, score)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING`,
    [Math.min(pageA, pageB), Math.max(pageA, pageB), type, score],
  );
}

beforeAll(async () => {
  if (!canRun) return;
  await setupTestDb();
  app = await buildApp();
  await app.ready();
}, 60_000);

afterAll(async () => {
  if (!canRun) return;
  await app?.close();
  await teardownTestDb();
});

beforeEach(async () => {
  if (!canRun) return;
  await truncateAllTables();
});

describe.skipIf(!canRun)('GET /api/pages/:id/graph/local — #360 edgeTypes whitelist (real DB)', () => {
  it('happy path — only the requested edgeTypes survive in the response', async () => {
    const { token, userId } = await createUserAndLogin('graph_local_happy');
    await grantSpaceRead(userId, 'DEV');

    // Three pages, three relationship types — verifying that filtering the
    // CTE drops the label_overlap edge while keeping embedding_similarity
    // and explicit_link. (We stick to the three types currently allowed by
    // the DB CHECK constraint; `parent_child` is a route-layer addition
    // from this PR but a CHECK migration for it is out of scope here.)
    const center = await insertPage('DEV', 'cf-center', 'Center');
    const sibling = await insertPage('DEV', 'cf-sibling', 'Sibling');
    const cousin = await insertPage('DEV', 'cf-cousin', 'Cousin');

    await insertRelationship(center, sibling, 'embedding_similarity', 0.9);
    await insertRelationship(center, cousin, 'label_overlap', 0.5);
    await insertRelationship(sibling, cousin, 'explicit_link', 0.7);

    const r = await app.inject({
      method: 'GET',
      url: `/api/pages/${center}/graph/local?edgeTypes=embedding_similarity,explicit_link`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body) as { edges: Array<{ type: string }> };
    const types = body.edges.map((e) => e.type).sort();
    // The label_overlap edge MUST be excluded.
    expect(types).not.toContain('label_overlap');
    expect(types.every((t) => t === 'embedding_similarity' || t === 'explicit_link')).toBe(true);
  });

  it('attacker-supplied edgeTypes (whitelist breach attempt) does NOT modify or drop tables', async () => {
    const { token, userId } = await createUserAndLogin('graph_local_security');
    await grantSpaceRead(userId, 'DEV');

    const center = await insertPage('DEV', 'cf-c1', 'Center');
    const neighbor = await insertPage('DEV', 'cf-n1', 'Neighbor');
    await insertRelationship(center, neighbor, 'embedding_similarity', 0.85);

    // Sanity: the table is populated before the request.
    const beforeCount = await query<{ count: string }>('SELECT COUNT(*)::text AS count FROM pages');
    expect(parseInt(beforeCount.rows[0]!.count, 10)).toBeGreaterThanOrEqual(2);

    // Pile every shape of injection we can think of into edgeTypes. Each
    // value is a string in the comma-separated list, so it lands in the
    // Zod transform's `.split(',')` and gets filtered against the
    // whitelist. None of them are valid edge types — the array reaching
    // SQL must be empty (=> null => no filter).
    const evilEdgeTypes = [
      "embedding_similarity'; DROP TABLE pages--",
      'embedding_similarity OR 1=1',
      'embedding_similarity); TRUNCATE pages;--',
      'foo',
      'bar',
    ].join(',');

    const r = await app.inject({
      method: 'GET',
      url: `/api/pages/${center}/graph/local?edgeTypes=${encodeURIComponent(evilEdgeTypes)}`,
      headers: { authorization: `Bearer ${token}` },
    });

    // Request must succeed (Zod doesn't 400 — invalid values are silently
    // dropped per the transform), and the DB must be intact.
    expect(r.statusCode).toBe(200);

    const afterCount = await query<{ count: string }>('SELECT COUNT(*)::text AS count FROM pages');
    expect(afterCount.rows[0]!.count).toBe(beforeCount.rows[0]!.count);

    // Tables that an injection might target must still exist.
    const tableCheck = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN ('pages', 'page_relationships')`,
    );
    expect(tableCheck.rows[0]!.count).toBe('2');
  });

  it('mixed valid + invalid edgeTypes — only the whitelisted values filter the result', async () => {
    const { token, userId } = await createUserAndLogin('graph_local_mixed');
    await grantSpaceRead(userId, 'DEV');

    const center = await insertPage('DEV', 'cf-mc', 'Center');
    const a = await insertPage('DEV', 'cf-ma', 'A');
    const b = await insertPage('DEV', 'cf-mb', 'B');

    await insertRelationship(center, a, 'embedding_similarity', 0.9);
    await insertRelationship(center, b, 'label_overlap', 0.6);

    const r = await app.inject({
      method: 'GET',
      url: `/api/pages/${center}/graph/local?edgeTypes=embedding_similarity,evil_type,label_overlap`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body) as { edges: Array<{ type: string }> };
    const types = body.edges.map((e) => e.type);
    // Both valid types pass through; `evil_type` simply has no matches in
    // the table — but, more importantly, it never reached SQL.
    expect(types.sort()).toEqual(['embedding_similarity', 'label_overlap']);
  });

  it('omitted edgeTypes returns the full neighborhood (default behaviour)', async () => {
    const { token, userId } = await createUserAndLogin('graph_local_default');
    await grantSpaceRead(userId, 'DEV');

    const center = await insertPage('DEV', 'cf-dc', 'Center');
    const x = await insertPage('DEV', 'cf-dx', 'X');
    const y = await insertPage('DEV', 'cf-dy', 'Y');
    await insertRelationship(center, x, 'embedding_similarity', 0.9);
    await insertRelationship(center, y, 'label_overlap', 0.6);

    const r = await app.inject({
      method: 'GET',
      url: `/api/pages/${center}/graph/local`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body) as { edges: Array<{ type: string }> };
    expect(body.edges.length).toBe(2);
  });
});

describe.skipIf(!canRun)('GET /api/pages/graph — #360 multi-spaceKey (real DB)', () => {
  it('intersects the requested spaceKeys with RBAC-accessible spaces', async () => {
    const { token, userId } = await createUserAndLogin('graph_multi_space');
    await grantSpaceRead(userId, 'DEV');
    await grantSpaceRead(userId, 'OPS');
    // SECRET is intentionally NOT granted — the intersection must drop it
    // even though the user supplies it.

    await insertPage('DEV', 'cf-dev-1', 'Dev Page');
    await insertPage('OPS', 'cf-ops-1', 'Ops Page');
    await insertPage('SECRET', 'cf-sec-1', 'Secret Page');

    const r = await app.inject({
      method: 'GET',
      url: '/api/pages/graph?spaceKey=DEV,SECRET',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body) as { nodes: Array<{ spaceKey: string; title: string }> };

    const seenSpaces = new Set(body.nodes.map((n) => n.spaceKey));
    expect(seenSpaces.has('DEV')).toBe(true);
    // Crucially, SECRET pages MUST NOT appear in the response — the
    // intersection blocked the un-granted space at the route layer.
    expect(seenSpaces.has('SECRET')).toBe(false);
    // OPS wasn't requested, so it shouldn't appear either.
    expect(seenSpaces.has('OPS')).toBe(false);
  });

  it('two requested spaces, both granted — both appear', async () => {
    const { token, userId } = await createUserAndLogin('graph_multi_space_both');
    await grantSpaceRead(userId, 'DEV');
    await grantSpaceRead(userId, 'OPS');

    await insertPage('DEV', 'cf-d1', 'D1');
    await insertPage('OPS', 'cf-o1', 'O1');

    const r = await app.inject({
      method: 'GET',
      url: '/api/pages/graph?spaceKey=DEV,OPS',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body) as { nodes: Array<{ spaceKey: string }> };
    const spaces = new Set(body.nodes.map((n) => n.spaceKey));
    expect(spaces.has('DEV')).toBe(true);
    expect(spaces.has('OPS')).toBe(true);
  });
});
