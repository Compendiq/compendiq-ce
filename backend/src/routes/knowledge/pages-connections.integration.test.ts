import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { ZodError } from 'zod';
import {
  isDbAvailable,
  setupTestDb,
  teardownTestDb,
  truncateAllTables,
} from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';
import { computePageRelationships } from '../../domains/llm/services/embedding-service.js';
import { pagesConnectionRoutes } from './pages-connections.js';
import { pagesEmbeddingRoutes } from './pages-embeddings.js';

const dbAvailable = await isDbAvailable();
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

  beforeAll(async () => {
    await setupTestDb();
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
    app.decorate('redis', {} as never);
    await app.register(pagesConnectionRoutes, { prefix: '/api' });
    await app.register(pagesEmbeddingRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
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

    await seedRelationship(10, 100, 'explicit_link');
    await seedRelationship(100, 200, 'explicit_link');
    await seedRelationship(50, 100, 'parent_child');
    await seedRelationship(100, 150, 'parent_child');
    await seedRelationship(100, 10, 'embedding_similarity', 0.99);
    await seedRelationship(100, 300, 'embedding_similarity', 0.72);
    await seedRelationship(300, 100, 'embedding_similarity', 0.91);
    await seedRelationship(100, 300, 'label_overlap', 0.63);

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
    await seedRelationship(400, 450, 'parent_child');
    await seedRelationship(350, 400, 'parent_child');

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
    await seedPage({ id: 800, title: 'Standalone source' });
    await seedPage({ id: 801, title: 'First hop' });
    await seedPage({ id: 802, title: 'Restricted intermediary', source: 'confluence', confluenceId: 'hidden', inheritPerms: false });
    await seedPage({ id: 803, title: 'Visible only through hidden' });
    await seedPage({ id: 804, title: 'Second hop' });
    await seedPage({ id: 805, title: 'Third hop' });
    await seedRelationship(800, 801, 'explicit_link');
    await seedRelationship(800, 802, 'embedding_similarity', 0.99);
    await seedRelationship(802, 803, 'explicit_link');
    await seedRelationship(801, 804, 'explicit_link');
    await seedRelationship(804, 805, 'explicit_link');

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
