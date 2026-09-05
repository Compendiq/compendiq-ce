import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { readFileSync } from 'node:fs';
import { createClient } from 'redis';
import { ZodError } from 'zod';
import type { PageConnections } from '@compendiq/contracts';
import { RELATIONSHIP_ADVISORY_LOCK_ID } from '../../core/db/advisory-locks.js';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../../test-db-helper.js';
import { getPool, query } from '../../core/db/postgres.js';
import { isRedisAvailable } from '../../test-redis-helper.js';
import { ensureDeterministicRelationships } from '../../domains/llm/services/deterministic-relationships.js';
import { registerKnowledgeRelationshipProducers } from '../../domains/knowledge/services/relationship-producers.js';
import { pagesCrudRoutes } from './pages-crud.js';
import { computePageRelationships } from '../../domains/llm/services/embedding-service.js';
import { pagesConnectionRoutes } from './pages-connections.js';
import { pagesEmbeddingRoutes } from './pages-embeddings.js';

const dbAvailable = await isDbAvailable();
const redisAvailable = await isRedisAvailable();
let currentUserId = '';
let otherUserId = '';

interface PageFixture {
  id: number;
  title: string;
  source?: 'standalone' | 'confluence';
  confluenceId?: string | null;
  spaceKey?: string | null;
  ownerId?: string;
  visibility?: 'shared' | 'private';
  bodyHtml?: string;
  parentId?: string | null;
  labels?: string[];
  inheritPerms?: boolean;
}

async function seedPage(fixture: PageFixture): Promise<void> {
  const source = fixture.source ?? 'standalone';
  await query(
    `INSERT INTO pages
       (id, confluence_id, source, space_key, title, body_text, body_storage,
        body_html, created_by_user_id, visibility, parent_id, labels,
        inherit_perms, version, embedding_dirty, embedding_status, last_synced)
     VALUES ($1, $2, $3, $4, $5, 'text', '', $6, $7, $8, $9, $10,
             $11, 1, TRUE, 'not_embedded', NOW())`,
    [
      fixture.id,
      fixture.confluenceId ?? null,
      source,
      fixture.spaceKey ?? (source === 'confluence' ? 'DEV' : null),
      fixture.title,
      fixture.bodyHtml ?? '<p>body</p>',
      fixture.ownerId ?? currentUserId,
      fixture.visibility ?? 'shared',
      fixture.parentId ?? null,
      fixture.labels ?? [],
      fixture.inheritPerms ?? true,
    ],
  );
}

async function seedRelationship(
  left: number,
  right: number,
  type: 'embedding_similarity' | 'label_overlap' | 'explicit_link' | 'parent_child',
  score = 1,
): Promise<void> {
  await query(
    `INSERT INTO page_relationships
       (page_id_1, page_id_2, relationship_type, score)
     VALUES ($1, $2, $3, $4)`,
    [left, right, type, score],
  );
}

async function assignViewer(userId: string, spaceKey = 'DEV'): Promise<void> {
  const role = await query<{ id: number }>(
    `INSERT INTO roles (name, display_name, is_system, permissions)
     VALUES ('viewer', 'Viewer', TRUE, ARRAY['read'])
     ON CONFLICT (name) DO UPDATE SET permissions = EXCLUDED.permissions
     RETURNING id`,
  );
  await query(
    `INSERT INTO space_role_assignments
       (space_key, principal_type, principal_id, role_id)
     VALUES ($1, 'user', $2, $3)`,
    [spaceKey, userId, role.rows[0]!.id],
  );
}

describe.skipIf(!dbAvailable)('Connections and local graph API', () => {
  let app: FastifyInstance;

  const redis = createClient({
    url: process.env.REDIS_URL,
    socket: { reconnectStrategy: false, connectTimeout: 1_000 },
  });
  beforeAll(async () => {
    await setupTestDb();
    registerKnowledgeRelationshipProducers();
    if (redisAvailable) await redis.connect();
    app = Fastify({ logger: false });
    await app.register(sensible);
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof ZodError) {
        return reply.status(400).send({ error: 'Validation failed' });
      }
      return reply.status(error.statusCode ?? 500).send({ error: error.message });
    });
    app.decorate('authenticate', async (request: {
      userId: string;
      username: string;
      userRole: 'user' | 'admin';
    }) => {
      request.userId = currentUserId;
      request.username = 'connections-user';
      request.userRole = 'user';
    });
    app.decorate('requireAdmin', async (request: {
      userId: string;
      username: string;
      userRole: 'user' | 'admin';
    }) => {
      request.userId = currentUserId;
      request.username = 'connections-user';
      request.userRole = 'admin';
    });
    app.decorate('redis', redis as never);
    await app.register(pagesCrudRoutes, { prefix: '/api' });
    await app.register(pagesConnectionRoutes, { prefix: '/api' });
    await app.register(pagesEmbeddingRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    if (redis.isOpen) await redis.quit();
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    const user = await query<{ id: string }>(
      `INSERT INTO users (username, password_hash, role)
       VALUES ('connections_user', 'x', 'user') RETURNING id`,
    );
    const other = await query<{ id: string }>(
      `INSERT INTO users (username, password_hash, role)
       VALUES ('connections_other', 'x', 'user') RETURNING id`,
    );
    currentUserId = user.rows[0]!.id;
    otherUserId = other.rows[0]!.id;
    await query(
      `INSERT INTO spaces (space_key, space_name, source)
       VALUES ('DEV', 'Development', 'confluence')`,
    );
    await assignViewer(currentUserId);
  });

  async function connections(id: number): Promise<PageConnections> {
    const response = await app.inject({ method: 'GET', url: `/api/pages/${id}/connections` });
    expect(response.statusCode).toBe(200);
    return response.json<PageConnections>();
  }

  it.skipIf(!redisAvailable)('materializes API-created articles and edits without any embedding provider', async () => {
    async function create(title: string, bodyHtml = '', parentId?: number, labels: string[] = []) {
      const response = await app.inject({
        method: 'POST', url: '/api/pages',
        payload: { source: 'standalone', title, bodyHtml, parentId: parentId?.toString(), labels },
      });
      expect(response.statusCode).toBe(200);
      return response.json<{ id: number }>().id;
    }
    const parent = await create('Parent');
    const linked = await create('Linked');
    const related = await create('Related', '', undefined, ['runbook', 'operations']);
    const child = await create('Child', `<a href="/pages/${linked}">linked</a>`, parent, ['runbook']);

    expect(await connections(child)).toEqual({
      linked: [{ pageId: String(linked), title: 'Linked', reasons: [{ type: 'explicit_link', direction: 'outgoing' }] }],
      section: [{ pageId: String(parent), title: 'Parent', reasons: [{ type: 'parent_child', direction: 'parent' }] }],
      related: [{ pageId: String(related), title: 'Related', reasons: [{ type: 'label_overlap', labels: ['runbook'], score: 0.5 }] }],
    });
    const graph = await app.inject({ method: 'GET', url: `/api/pages/${parent}/graph/local?hops=2` });
    expect(graph.statusCode).toBe(200);
    expect(graph.json().nodes.map((node: { id: string }) => node.id).sort()).toEqual(
      [parent, linked, related, child].map(String).sort(),
    );
    const edited = await app.inject({
      method: 'PUT', url: `/api/pages/${child}`,
      payload: { title: 'Child', bodyHtml: '<p>Link removed in editor</p>', version: 1 },
    });
    expect(edited.statusCode).toBe(200);
    expect((await connections(child)).linked).toEqual([]);
    expect((await query('SELECT id FROM llm_providers')).rows).toEqual([]);
    expect((await query('SELECT page_id FROM page_embeddings')).rows).toEqual([]);
  });

  it('backfills existing never-embedded articles on upgrade', async () => {
    await seedPage({ id: 1000, title: 'Existing parent', labels: ['existing'] });
    await seedPage({ id: 1001, title: 'Existing child', parentId: '1000' });
    await seedPage({ id: 1002, title: 'Existing related', labels: ['existing'] });
    // Simulate the pre-111 corpus: no dirty records and no materialized edges.
    await query('DELETE FROM deterministic_relationship_dirty');
    await query(readFileSync(new URL('../../core/db/migrations/111_deterministic_relationship_freshness.sql', import.meta.url), 'utf8'));
    const result = await connections(1000);
    expect(result.section.map((item) => item.pageId)).toEqual(['1001']);
    expect(result.related.map((item) => item.pageId)).toEqual(['1002']);
    expect((await query('SELECT page_id FROM page_embeddings')).rows).toEqual([]);
  });

  it('refreshes body, label and hierarchy writes while preserving unrelated persisted semantic scores', async () => {
    await seedPage({ id: 1100, title: 'Source', labels: ['alpha'], parentId: '1103', bodyHtml: '<a href="/pages/1101">one</a>' });
    await seedPage({ id: 1101, title: 'One', bodyHtml: '<a href="/pages/1100">source</a>' });
    await seedPage({ id: 1102, title: 'Two', labels: ['alpha'] });
    await seedPage({ id: 1103, title: 'Old parent' });
    await seedPage({ id: 1104, title: 'New parent' });
    await seedPage({ id: 1105, title: 'Semantic source' });
    await seedPage({ id: 1106, title: 'Semantic target' });
    await seedRelationship(1105, 1106, 'embedding_similarity', 0.8125);
    expect((await connections(1100)).linked[0]!.reasons).toEqual([
      { type: 'explicit_link', direction: 'outgoing' },
      { type: 'explicit_link', direction: 'incoming' },
    ]);

    await query(
      `UPDATE pages SET body_html = '<a href="/pages/1102">two</a>', parent_id = '1104' WHERE id = 1100`,
    );
    await query("UPDATE pages SET labels = ARRAY['beta'] WHERE id = 1102");
    const changed = await connections(1100);
    expect(changed.linked).toEqual([
      { pageId: '1101', title: 'One', reasons: [{ type: 'explicit_link', direction: 'incoming' }] },
      { pageId: '1102', title: 'Two', reasons: [{ type: 'explicit_link', direction: 'outgoing' }] },
    ]);
    expect(changed.section.map((item) => item.pageId)).toEqual(['1104']);
    expect(changed.related).toEqual([]);
    expect((await connections(1103)).section).toEqual([]);
    // An old-title invalidation requires a full deterministic rebuild too.
    await query("UPDATE pages SET title = 'Renamed target' WHERE id = 1102");
    expect((await connections(1105)).related[0]!.reasons).toEqual([
      { type: 'embedding_similarity', score: 0.8125 },
    ]);
    expect((await query("SELECT page_id_1 FROM page_relationships WHERE relationship_type = 'label_overlap'")).rows).toEqual([]);
  });

  it('re-resolves old titles and deleted/restored identities, including newly ambiguous titles', async () => {
    await seedPage({ id: 1200, title: 'Referrer', bodyHtml: '<a href="#confluence-page:Destination">destination</a>' });
    await seedPage({ id: 1201, title: 'Destination' });
    expect((await connections(1200)).linked.map((item) => item.pageId)).toEqual(['1201']);
    await seedPage({ id: 1202, title: 'Destination' });
    expect((await connections(1200)).linked).toEqual([]);
    await query("UPDATE pages SET title = 'Other title' WHERE id = 1202");
    expect((await connections(1200)).linked.map((item) => item.pageId)).toEqual(['1201']);
    await query("UPDATE pages SET deleted_at = NOW() WHERE id = 1201");
    expect((await connections(1200)).linked).toEqual([]);
    await query("UPDATE pages SET deleted_at = NULL WHERE id = 1201");
    expect((await connections(1200)).linked.map((item) => item.pageId)).toEqual(['1201']);
    await query("UPDATE pages SET title = 'Destination' WHERE id = 1202");
    expect((await connections(1200)).linked).toEqual([]);
    await query('DELETE FROM pages WHERE id = 1201');
    expect((await connections(1200)).linked.map((item) => item.pageId)).toEqual(['1202']);
  });

  it('never treats a synced parent internal id as an alternative Confluence key', async () => {
    await seedPage({ id: 1300, title: 'Unrelated synced page', source: 'confluence', confluenceId: '7777' });
    await seedPage({ id: 1301, title: 'Actual parent', source: 'confluence', confluenceId: '1300' });
    await seedPage({ id: 1302, title: 'Child', parentId: '1300' });
    expect((await connections(1302)).section).toEqual([
      { pageId: '1301', title: 'Actual parent', reasons: [{ type: 'parent_child', direction: 'parent' }] },
    ]);
    expect((await connections(1300)).section).toEqual([]);
    // The reader must also reject old/bad persisted rows, not just trust producer order.
    await seedRelationship(1300, 1302, 'parent_child');
    expect((await connections(1302)).section.map((item) => item.pageId)).toEqual(['1301']);
  });

  it('suppresses cross-namespace ambiguity in both producer and reader, then restores unique parenthood', async () => {
    await seedPage({ id: 1400, title: 'Local parent' });
    await seedPage({ id: 1402, title: 'Child', parentId: '1400' });
    expect((await connections(1402)).section.map((item) => item.pageId)).toEqual(['1400']);
    await seedPage({ id: 1401, title: 'Synced collision', source: 'confluence', confluenceId: '1400' });
    expect((await connections(1402)).section).toEqual([]);
    expect((await query("SELECT page_id_1 FROM page_relationships WHERE relationship_type = 'parent_child'")).rows).toEqual([]);
    await seedRelationship(1400, 1402, 'parent_child');
    await seedRelationship(1401, 1402, 'parent_child');
    expect((await connections(1402)).section).toEqual([]);
    await query("UPDATE pages SET confluence_id = 'new-key' WHERE id = 1401");
    expect((await connections(1402)).section.map((item) => item.pageId)).toEqual(['1400']);
    // Source, not the mere presence of a Confluence id, decides the key.
    await query("UPDATE pages SET confluence_id = 'legacy-id' WHERE id = 1400");
    expect((await connections(1402)).section.map((item) => item.pageId)).toEqual(['1400']);
    await query("UPDATE pages SET source = 'confluence', space_key = 'DEV' WHERE id = 1400");
    expect((await connections(1402)).section).toEqual([]);
    await query("UPDATE pages SET parent_id = 'legacy-id' WHERE id = 1402");
    expect((await connections(1402)).section.map((item) => item.pageId)).toEqual(['1400']);
  });

  it('keeps failed materialization pending, refuses unauthorized work and makes clean reads idempotent', async () => {
    await seedPage({ id: 1500, title: 'Source', labels: ['match'] });
    await seedPage({ id: 1501, title: 'Target', labels: ['match'] });
    await seedPage({ id: 1502, title: 'Denied', visibility: 'private', ownerId: otherUserId });
    await query(`CREATE FUNCTION reject_relationship_test() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'relationship materialization rejected'; END $$;
      CREATE TRIGGER reject_relationship_test BEFORE INSERT ON page_relationships
      FOR EACH ROW EXECUTE FUNCTION reject_relationship_test()`);
    try {
      expect((await app.inject({ method: 'GET', url: '/api/pages/1502/connections' })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: '/api/pages/1500/connections' })).statusCode).toBe(500);
      expect((await app.inject({ method: 'GET', url: '/api/pages/1500/graph/local' })).statusCode).toBe(500);
      expect((await query('SELECT page_id FROM deterministic_relationship_dirty WHERE page_id = 1500')).rows).toEqual([{ page_id: 1500 }]);
    } finally {
      await query('DROP TRIGGER reject_relationship_test ON page_relationships; DROP FUNCTION reject_relationship_test()');
    }
    const settled = await connections(1500);
    expect(settled.related.map((item) => item.pageId)).toEqual(['1501']);
    await query(`CREATE FUNCTION reject_relationship_test() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'clean reads must not recompute'; END $$;
      CREATE TRIGGER reject_relationship_test BEFORE INSERT ON page_relationships
      FOR EACH ROW EXECUTE FUNCTION reject_relationship_test()`);
    try {
      await query("UPDATE pages SET embedding_status = 'failed', labels = labels WHERE id = 1500");
      expect(await connections(1500)).toEqual(settled);
      expect((await query('SELECT page_id FROM deterministic_relationship_dirty')).rows).toEqual([]);
    } finally {
      await query('DROP TRIGGER reject_relationship_test ON page_relationships; DROP FUNCTION reject_relationship_test()');
    }
  });

  it('retains a mutation committed while materialization is in flight', async () => {
    await seedPage({ id: 1600, title: 'Source', labels: ['before'] });
    await seedPage({ id: 1601, title: 'Before target', labels: ['before'] });
    await seedPage({ id: 1602, title: 'After target', labels: ['after'] });
    const blocker = await getPool().connect();
    const pauseLock = 1_314_999;
    let running: Promise<void> | undefined;
    await query(`CREATE FUNCTION pause_relationship_test() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(${pauseLock}); RETURN NEW; END $$;
      CREATE TRIGGER pause_relationship_test BEFORE INSERT ON page_relationships
      FOR EACH ROW EXECUTE FUNCTION pause_relationship_test()`);
    try {
      await blocker.query('SELECT pg_advisory_lock($1)', [pauseLock]);
      running = ensureDeterministicRelationships();
      await expect.poll(async () => (await query<{ waiting: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory'
         AND objid = $1 AND NOT granted) AS waiting`, [pauseLock],
      )).rows[0]!.waiting).toBe(true);
      await query("UPDATE pages SET labels = ARRAY['after'] WHERE id = 1600");
      await blocker.query('SELECT pg_advisory_unlock($1)', [pauseLock]);
      await running;
      expect((await query('SELECT page_id FROM deterministic_relationship_dirty')).rows).toEqual([{ page_id: 1600 }]);
      expect((await connections(1600)).related.map((item) => item.pageId)).toEqual(['1602']);
    } finally {
      await blocker.query('SELECT pg_advisory_unlock_all()');
      await running?.catch(() => {});
      blocker.release();
      await query('DROP TRIGGER pause_relationship_test ON page_relationships; DROP FUNCTION pause_relationship_test()');
    }
  });

  it('serializes semantic and deterministic recomputation', async () => {
    await seedPage({ id: 1700, title: 'Source', labels: ['match'] });
    await seedPage({ id: 1701, title: 'Target', labels: ['match'] });
    const blocker = await getPool().connect();
    let deterministic: Promise<void> | undefined;
    let semantic: Promise<number> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock($1)', [RELATIONSHIP_ADVISORY_LOCK_ID]);
      deterministic = ensureDeterministicRelationships();
      semantic = computePageRelationships([1700]);
      await expect.poll(async () => (await query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM pg_locks
         WHERE locktype = 'advisory' AND objid = $1 AND NOT granted`,
        [RELATIONSHIP_ADVISORY_LOCK_ID],
      )).rows[0]!.count).toBe(2);
      await blocker.query('COMMIT');
      await Promise.all([deterministic, semantic]);
      expect((await connections(1700)).related.map((item) => item.pageId)).toEqual(['1701']);
      expect((await query('SELECT page_id FROM deterministic_relationship_dirty')).rows).toEqual([]);
    } finally {
      await blocker.query('ROLLBACK');
      await Promise.allSettled([deterministic, semantic]);
      blocker.release();
    }
  });

  it('rolls page mutations and their invalidation back together', async () => {
    await seedPage({ id: 1800, title: 'Source', labels: ['match'] });
    await seedPage({ id: 1801, title: 'Target', labels: ['match'] });
    const before = await connections(1800);
    const writer = await getPool().connect();
    try {
      await writer.query('BEGIN');
      await writer.query("UPDATE pages SET labels = ARRAY['different'] WHERE id = 1800");
      await writer.query('ROLLBACK');
      expect(await connections(1800)).toEqual(before);
      expect((await query('SELECT page_id FROM deterministic_relationship_dirty')).rows).toEqual([]);
    } finally {
      await writer.query('ROLLBACK');
      writer.release();
    }
  });

  it('persists standalone and Confluence hierarchy edges from both parent-id forms', async () => {
    await seedPage({ id: 900, title: 'Local parent' });
    await seedPage({ id: 901, title: 'Local child', parentId: '900' });
    await seedPage({
      id: 902,
      title: 'Confluence parent',
      source: 'confluence',
      confluenceId: 'conf-parent',
    });
    await seedPage({
      id: 903,
      title: 'Confluence child',
      source: 'confluence',
      confluenceId: 'conf-child',
      parentId: 'conf-parent',
    });

    await computePageRelationships();

    const relationships = await query<{ page_id_1: number; page_id_2: number }>(
      `SELECT page_id_1, page_id_2
         FROM page_relationships
        WHERE relationship_type = 'parent_child'
        ORDER BY page_id_1`,
    );
    expect(relationships.rows).toEqual([
      { page_id_1: 900, page_id_2: 901 },
      { page_id_1: 902, page_id_2: 903 },
    ]);
  });

  it('groups live link and local hierarchy directions without requiring embeddings', async () => {
    await seedPage({
      id: 100,
      title: 'Source',
      bodyHtml: '<p><a href="/pages/10">outgoing</a></p>',
      parentId: '50',
      labels: ['shared', 'source-only'],
    });
    await seedPage({ id: 10, title: 'Outgoing' });
    await seedPage({ id: 200, title: 'Incoming', bodyHtml: '<a href="/pages/100">source</a>' });
    await seedPage({ id: 50, title: 'Local parent' });
    await seedPage({ id: 150, title: 'Local child', parentId: '100' });
    await seedPage({ id: 300, title: 'Strong related', labels: ['shared', 'target-only'] });
    for (const [id, score] of [[301, 0.89], [302, 0.89], [303, 0.87], [304, 0.86], [305, 0.85], [306, 0.84]] as const) {
      await seedPage({ id, title: `Related ${id}` });
      await seedRelationship(100, id, 'embedding_similarity', score);
    }

    await ensureDeterministicRelationships();
    await seedRelationship(100, 10, 'embedding_similarity', 0.99);
    await seedRelationship(100, 300, 'embedding_similarity', 0.72);
    await seedRelationship(300, 100, 'embedding_similarity', 0.91);
    await query(
      `UPDATE page_relationships SET score = 0.63
       WHERE page_id_1 = 100 AND page_id_2 = 300 AND relationship_type = 'label_overlap'`,
    );

    const response = await app.inject({ method: 'GET', url: '/api/pages/100/connections' });
    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body.linked).toEqual([
      { pageId: '10', title: 'Outgoing', reasons: [{ type: 'explicit_link', direction: 'outgoing' }] },
      { pageId: '200', title: 'Incoming', reasons: [{ type: 'explicit_link', direction: 'incoming' }] },
    ]);
    expect(body.section).toEqual([
      { pageId: '50', title: 'Local parent', reasons: [{ type: 'parent_child', direction: 'parent' }] },
      { pageId: '150', title: 'Local child', reasons: [{ type: 'parent_child', direction: 'child' }] },
    ]);
    expect(body.related.map((item: { pageId: string }) => item.pageId)).toEqual([
      '300', '301', '302', '303', '304',
    ]);
    expect(body.related[0].reasons[0]).toEqual({ type: 'embedding_similarity', score: expect.closeTo(0.91, 5) });
    expect(body.related[0].reasons[1]).toEqual({
      type: 'label_overlap',
      labels: ['shared'],
      score: expect.closeTo(0.63, 5),
    });
    expect(body.related.some((item: { pageId: string }) => item.pageId === '10')).toBe(false);
  });

  it('resolves both Confluence parent and child directions from current hierarchy', async () => {
    await seedPage({
      id: 400,
      title: 'Confluence source',
      source: 'confluence',
      confluenceId: 'conf-source',
      parentId: 'conf-parent',
    });
    await seedPage({
      id: 450,
      title: 'Confluence parent',
      source: 'confluence',
      confluenceId: 'conf-parent',
    });
    await seedPage({
      id: 350,
      title: 'Confluence child',
      source: 'confluence',
      confluenceId: 'conf-child',
      parentId: 'conf-source',
    });

    const response = await app.inject({ method: 'GET', url: '/api/pages/400/connections' });
    expect(response.statusCode).toBe(200);
    expect(response.json().section).toEqual([
      { pageId: '350', title: 'Confluence child', reasons: [{ type: 'parent_child', direction: 'child' }] },
      { pageId: '450', title: 'Confluence parent', reasons: [{ type: 'parent_child', direction: 'parent' }] },
    ]);
  });

  it('drops stale evidence and revokes inaccessible source and target titles', async () => {
    await seedPage({ id: 500, title: 'Source', labels: ['alpha'] });
    await seedPage({ id: 501, title: 'Stale target', labels: ['beta'] });
    await seedPage({ id: 502, title: 'Visible target' });
    await seedPage({
      id: 503,
      title: 'Private target',
      ownerId: otherUserId,
      visibility: 'private',
    });
    await seedPage({
      id: 504,
      title: 'Restricted target',
      source: 'confluence',
      confluenceId: 'restricted',
      inheritPerms: false,
    });
    await ensureDeterministicRelationships();
    await seedRelationship(500, 501, 'explicit_link');
    await seedRelationship(500, 501, 'label_overlap', 1);
    await seedRelationship(500, 502, 'embedding_similarity', 0.4);
    await seedRelationship(500, 503, 'embedding_similarity', 0.99);
    await seedRelationship(500, 504, 'embedding_similarity', 0.98);

    const visible = await app.inject({ method: 'GET', url: '/api/pages/500/connections' });
    expect(visible.statusCode).toBe(200);
    expect(visible.json()).toEqual({
      linked: [],
      section: [],
      related: [{
        pageId: '502',
        title: 'Visible target',
        reasons: [{ type: 'embedding_similarity', score: expect.closeTo(0.4, 5) }],
      }],
    });

    await query(
      `UPDATE pages SET visibility = 'private', created_by_user_id = $2 WHERE id = $1`,
      [500, otherUserId],
    );
    const revoked = await app.inject({ method: 'GET', url: '/api/pages/500/connections' });
    expect(revoked.statusCode).toBe(404);
    expect(revoked.body).not.toContain('Source');
  });

  it('collects strict durable events, deduping impressions by article visit', async () => {
    await seedPage({ id: 700, title: 'Source' });
    await seedPage({ id: 701, title: 'Target' });
    await seedPage({ id: 702, title: 'Hidden', ownerId: otherUserId, visibility: 'private' });
    const visitId = '11111111-1111-4111-8111-111111111111';

    for (let attempt = 0; attempt < 2; attempt++) {
      const impression = await app.inject({
        method: 'POST',
        url: '/api/pages/700/connections/events',
        payload: { event: 'impression', visitId },
      });
      expect(impression.statusCode).toBe(200);
      expect(impression.json()).toEqual({ recorded: true });
    }

    const click = await app.inject({
      method: 'POST',
      url: '/api/pages/700/connections/events',
      payload: {
        event: 'connection_click',
        visitId,
        targetPageId: '701',
        group: 'related',
      },
    });
    expect(click.statusCode).toBe(200);

    const launch = await app.inject({
      method: 'POST',
      url: '/api/pages/700/connections/events',
      payload: { event: 'graph_launch', visitId },
    });
    expect(launch.statusCode).toBe(200);

    const hiddenClick = await app.inject({
      method: 'POST',
      url: '/api/pages/700/connections/events',
      payload: {
        event: 'connection_click',
        visitId,
        targetPageId: '702',
        group: 'related',
      },
    });
    expect(hiddenClick.statusCode).toBe(404);

    const extraField = await app.inject({
      method: 'POST',
      url: '/api/pages/700/connections/events',
      payload: { event: 'impression', visitId, title: 'must not be accepted' },
    });
    expect(extraField.statusCode).toBe(400);

    const rows = await query<{
      action: string;
      resource_id: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT action, resource_id, metadata
         FROM audit_log
        WHERE resource_type = 'page_connections'
        ORDER BY action`,
    );
    expect(rows.rows).toEqual([
      {
        action: 'CONNECTION_CLICK',
        resource_id: '700',
        metadata: { event: 'connection_click', visitId, group: 'related' },
      },
      {
        action: 'CONNECTION_GRAPH_LAUNCH',
        resource_id: '700',
        metadata: { event: 'graph_launch', visitId },
      },
      {
        action: 'CONNECTION_IMPRESSION',
        resource_id: '700',
        metadata: { event: 'impression', visitId },
      },
    ]);
  });

  it('shows a standalone local graph and never traverses an inaccessible intermediary', async () => {
    await seedPage({ id: 800, title: 'Standalone source', bodyHtml: '<a href="/pages/801">first</a>' });
    await seedPage({ id: 801, title: 'First hop', bodyHtml: '<a href="/pages/804">second</a>' });
    await seedPage({ id: 802, title: 'Restricted intermediary', source: 'confluence', confluenceId: 'hidden', inheritPerms: false, bodyHtml: '<a href="/pages/803">hidden path</a>' });
    await seedPage({ id: 803, title: 'Visible only through hidden' });
    await seedPage({ id: 804, title: 'Second hop', bodyHtml: '<a href="/pages/805">third</a>' });
    await seedPage({ id: 805, title: 'Third hop' });
    await seedRelationship(800, 802, 'embedding_similarity', 0.99);

    const response = await app.inject({ method: 'GET', url: '/api/pages/800/graph/local' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.centerId).toBe('800');
    expect(body.nodes.map((node: { id: string }) => node.id).sort()).toEqual(['800', '801', '804']);
    expect(body.edges.map((edge: { source: string; target: string }) => [edge.source, edge.target])).toEqual(
      expect.arrayContaining([['800', '801'], ['801', '804']]),
    );
    expect(body.nodes.some((node: { id: string }) => node.id === '802')).toBe(false);
    expect(body.nodes.some((node: { id: string }) => node.id === '803')).toBe(false);
    expect(body.nodes.some((node: { id: string }) => node.id === '805')).toBe(false);
  });
});
