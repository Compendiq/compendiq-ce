import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  setupTestDb,
  truncateAllTables,
  teardownTestDb,
  isDbAvailable,
  waitForDatabaseCondition,
} from '../../../test-db-helper.js';
import { getPool, query } from '../../../core/db/postgres.js';
import { embedPage, computePageRelationships, MIN_EMBEDDABLE_TEXT_CHARS } from './embedding-service.js';
import { hybridSearch, vectorSearch } from './rag-service.js';
import { captureEmbeddingArticle, claimEmbeddingArticle } from './embedding-article-stage.js';
import type * as ImageAnalysisCompose from './image-analysis-compose.js';
import type { DerivedComposition } from './image-analysis-compose.js';
import pgvector from 'pgvector';

// The derived-chunk composition stays REAL. Two #1714 cases use this seam:
// `plan` reaches embedPage's defensive empty-chunk return, which no real
// composition reaches (a substantive analysis always serializes to a chunk);
// `beforePlan` lands a concurrent edit after the worker captured its snapshot
// and recorded its operation, and before its settle takes the page row.
const compose = vi.hoisted(() => ({
  plan: null as DerivedComposition | null,
  beforePlan: null as (() => Promise<void>) | null,
}));
vi.mock('./image-analysis-compose.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ImageAnalysisCompose>();
  return {
    ...actual,
    planDerivedChunks: async (...args: Parameters<typeof actual.planDerivedChunks>) => {
      await compose.beforePlan?.();
      return compose.plan ?? actual.planDerivedChunks(...args);
    },
  };
});

// Deterministic 1024-dim vector for fixtures
function fakeVec(seed: number): number[] {
  return Array.from({ length: 1024 }, (_, i) => Math.sin((i + 1) * seed) * 0.01);
}

// Unit vector on the (x, y) plane at `angleDeg`, padded to 1024 dims.
// Cosine similarity between two such vectors is cos(angle difference), so
// the angular layout of a fixture fully controls the KNN graph.
function unitVec(angleDeg: number): number[] {
  const rad = (angleDeg * Math.PI) / 180;
  const v = new Array(1024).fill(0);
  v[0] = Math.cos(rad);
  v[1] = Math.sin(rad);
  return v;
}

const dbAvailable = await isDbAvailable();

// Regression for ce-migrations-1: migration 030 silently dropped the
// UNIQUE (confluence_id, chunk_index) constraint on page_embeddings when it
// removed the confluence_id column, and never recreated it on the new page_id
// column. Migration 079 restores the invariant as UNIQUE (page_id, chunk_index).
describe.skipIf(!dbAvailable)('page_embeddings (page_id, chunk_index) uniqueness — migration 079', () => {
  beforeAll(async () => {
    await setupTestDb();
  }, 30_000);
  afterAll(async () => {
    await teardownTestDb();
  });
  beforeEach(async () => {
    await truncateAllTables();
  });

  async function seedPage(): Promise<number> {
    const page = await query<{ id: number }>(
      `INSERT INTO pages (confluence_id, source, space_key, title, body_text, body_storage, body_html)
       VALUES (gen_random_uuid()::text, 'confluence', 'DEV', 'Page', 'body', '', '')
       RETURNING id`,
    );
    return page.rows[0]!.id;
  }

  async function insertEmbedding(pageId: number, chunkIndex: number): Promise<void> {
    await query(
      `INSERT INTO page_embeddings (page_id, chunk_index, chunk_text, embedding, metadata)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        pageId,
        chunkIndex,
        `chunk ${chunkIndex}`,
        pgvector.toSql(fakeVec(chunkIndex + 1)),
        JSON.stringify({ page_title: 'Page', section_title: 'Page', space_key: 'DEV' }),
      ],
    );
  }

  it('rejects a duplicate (page_id, chunk_index) row', async () => {
    const pageId = await seedPage();
    await insertEmbedding(pageId, 0);

    await expect(insertEmbedding(pageId, 0)).rejects.toThrow(
      /duplicate key value|unique constraint|page_embeddings_page_id_chunk_unique/i,
    );
  });

  it('allows distinct chunk_index values for the same page', async () => {
    const pageId = await seedPage();
    await insertEmbedding(pageId, 0);
    await insertEmbedding(pageId, 1);

    const { rows } = await query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM page_embeddings WHERE page_id = $1',
      [pageId],
    );
    expect(rows[0]!.count).toBe('2');
  });

  it('allows the same chunk_index across different pages', async () => {
    const pageA = await seedPage();
    const pageB = await seedPage();
    await insertEmbedding(pageA, 0);
    await insertEmbedding(pageB, 0);

    const { rows } = await query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM page_embeddings',
    );
    expect(rows[0]!.count).toBe('2');
  });
});

// Regression for #918: the empty/short-page short-circuit in embedPage cleared
// embedding_dirty but never moved embedding_status off the transient 'embedding'
// value set when the batch was marked. That left short pages stuck showing
// "embedding" forever. The branch must land on the terminal 'not_embedded'.
describe.skipIf(!dbAvailable)('embedPage short-page short-circuit — issue #918', () => {
  beforeAll(async () => {
    await setupTestDb();
  }, 30_000);
  afterAll(async () => {
    await teardownTestDb();
  });
  beforeEach(async () => {
    await truncateAllTables();
  });

  async function seedShortPage(): Promise<number> {
    const page = await query<{ id: number }>(
      `INSERT INTO pages (confluence_id, source, space_key, title, body_text, body_storage, body_html,
                          embedding_status, embedding_dirty)
       VALUES (gen_random_uuid()::text, 'confluence', 'DEV', 'Short', 'hi', '', '<p>hi</p>',
               'embedding', TRUE)
       RETURNING id`,
    );
    return page.rows[0]!.id;
  }

  it('clears embedding_dirty and lands on terminal not_embedded status', async () => {
    const pageId = await seedShortPage();

    // '<p>hi</p>' has <20 chars of text, so embedPage short-circuits before any
    // LLM call — no provider mock needed.
    const written = await embedPage('user-1', pageId, 'Short', 'DEV', '<p>hi</p>');
    expect(written).toBe(0);

    const { rows } = await query<{ embedding_status: string; embedding_dirty: boolean }>(
      'SELECT embedding_status, embedding_dirty FROM pages WHERE id = $1',
      [pageId],
    );
    expect(rows[0]!.embedding_dirty).toBe(false);
    expect(rows[0]!.embedding_status).toBe('not_embedded');
  });
});

// Regression for #916: embedding_similarity edges are DIRECTED (page_id_1 is
// the source, page_id_2 the KNN neighbour). The incremental recompute deleted
// every edge touching a changed page on EITHER side, but only re-inserted the
// changed page's own outbound edges. Any reverse edge Y→X owned by an unchanged
// page Y was therefore dropped and never rebuilt. The fix scopes the
// embedding_similarity delete to the source side (page_id_1) only.
describe.skipIf(!dbAvailable)('computePageRelationships — directed similarity edges (#916)', () => {
  beforeAll(async () => {
    await setupTestDb();
  }, 30_000);
  afterAll(async () => {
    await teardownTestDb();
  });
  beforeEach(async () => {
    await truncateAllTables();
  });

  async function seedPageWithEmbedding(title: string, angleDeg: number): Promise<number> {
    const page = await query<{ id: number }>(
      `INSERT INTO pages (confluence_id, source, space_key, title, body_text, body_storage, body_html)
       VALUES (gen_random_uuid()::text, 'confluence', 'DEV', $1, 'body', '', '')
       RETURNING id`,
      [title],
    );
    const pageId = page.rows[0]!.id;
    await query(
      `INSERT INTO page_embeddings (page_id, chunk_index, chunk_text, embedding, metadata)
       VALUES ($1, 0, $2, $3, $4::jsonb)`,
      [
        pageId,
        'chunk',
        pgvector.toSql(unitVec(angleDeg)),
        JSON.stringify({ page_title: title, section_title: title, space_key: 'DEV' }),
      ],
    );
    // computePageRelationships ranks KNN by the materialized pages.page_avg_embedding
    // column (#919), not page_embeddings directly. In production embedPage populates
    // it; mirror that here so the similarity graph is built for this fixture.
    await query(
      `UPDATE pages SET page_avg_embedding = (
         SELECT AVG(embedding) FROM page_embeddings WHERE page_id = $1
       ) WHERE id = $1`,
      [pageId],
    );
    return pageId;
  }

  async function similarityEdge(from: number, to: number): Promise<boolean> {
    const { rows } = await query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM page_relationships
       WHERE relationship_type = 'embedding_similarity'
         AND page_id_1 = $1 AND page_id_2 = $2`,
      [from, to],
    );
    return rows[0]!.count !== '0';
  }

  it('keeps an unchanged page\'s reverse edge (Y→X) after re-embedding X', async () => {
    // Cluster c1..c5 sits within 5° of X; Y sits 10° away from X. With TOP_K=5:
    //   X's 5 nearest are c1..c5 → X→Y is NOT created (asymmetric KNN).
    //   Y's 5 nearest are X + c5..c2 → Y→X IS created.
    const c1 = await seedPageWithEmbedding('C1', -5);
    const c2 = await seedPageWithEmbedding('C2', -4);
    const c3 = await seedPageWithEmbedding('C3', -3);
    const c4 = await seedPageWithEmbedding('C4', -2);
    const c5 = await seedPageWithEmbedding('C5', -1);
    const x = await seedPageWithEmbedding('X', 0);
    const y = await seedPageWithEmbedding('Y', 10);
    void c1;
    void c2;
    void c3;
    void c4;
    void c5;

    // Full recompute establishes the asymmetric graph.
    await computePageRelationships();
    expect(await similarityEdge(y, x)).toBe(true); // Y→X exists
    expect(await similarityEdge(x, y)).toBe(false); // X→Y does not

    // Simulate X being re-embedded: incremental recompute scoped to [X].
    await computePageRelationships([x]);

    // Y is unchanged, so its outbound Y→X edge must survive.
    expect(await similarityEdge(y, x)).toBe(true);
  });
});

// Regression for #1714: a page edited below the embeddable floor settles in
// embedPage's no-work branch, which used to flip flags only. The page kept
// its old chunks (search and RAG answered with the deleted text), its
// average (similarity edges kept being produced from it) and embedded_at.
// The settle now clears that derived state in the transaction that clears
// the dirty flag, fenced on the worker's snapshot under the page-row lock.
describe.skipIf(!dbAvailable)('embedPage settle path clears derived vector state — issue #1714', () => {
  const DELETED_TEXT = 'Deployment password rotation runbook: rotate the vault root token every ninety days.';
  const SHORT_BODY = '<p>hi</p>';
  const GROWN_TEXT = 'Rewritten runbook: the vault root token now rotates through the secrets pipeline.';

  beforeAll(async () => {
    await setupTestDb();
  }, 30_000);
  afterAll(async () => {
    await teardownTestDb();
  });
  beforeEach(async () => {
    compose.plan = null;
    compose.beforePlan = null;
    await truncateAllTables();
  });

  async function seedEmbeddedPage(title: string, text: string, angleDeg: number): Promise<number> {
    const page = await query<{ id: number }>(
      `INSERT INTO pages (title, source, space_key, visibility, body_html, body_text,
                          embedding_status, embedding_dirty, embedded_at)
       VALUES ($1, 'standalone', 'DEV', 'shared', $2, $3, 'embedded', FALSE, NOW())
       RETURNING id`,
      [title, `<p>${text}</p>`, text],
    );
    const pageId = page.rows[0]!.id;
    await query(
      `INSERT INTO page_embeddings (page_id, chunk_index, chunk_text, embedding, metadata)
       VALUES ($1, 0, $2, $3, $4::jsonb)`,
      [pageId, text, pgvector.toSql(unitVec(angleDeg)),
        JSON.stringify({ page_title: title, section_title: title, space_key: 'DEV' })],
    );
    await query(
      `UPDATE pages SET page_avg_embedding = (SELECT AVG(embedding) FROM page_embeddings WHERE page_id = $1)
        WHERE id = $1`,
      [pageId],
    );
    return pageId;
  }

  /** X (about to shrink) and Y, close enough that the graph links them both
   * ways, plus an authored label edge X→Y that the settle must leave alone. */
  async function seedEmbeddedPair(): Promise<{ x: number; y: number }> {
    const x = await seedEmbeddedPage('Ops notes', DELETED_TEXT, 0);
    const y = await seedEmbeddedPage('Vault guide', 'Vault token guide: how the root token is issued and revoked.', 10);
    await computePageRelationships();
    await query(
      `INSERT INTO page_relationships (page_id_1, page_id_2, relationship_type, score)
       VALUES ($1, $2, 'label_overlap', 1)`,
      [x, y],
    );
    return { x, y };
  }

  /** The user's edit: body below the floor and the dirty flag raised, as the
   * page write path does; migration 120's trigger advances content_revision. */
  async function shrink(pageId: number): Promise<void> {
    await query(
      `UPDATE pages SET body_html = $2, body_text = 'hi', embedding_dirty = TRUE WHERE id = $1`,
      [pageId, SHORT_BODY],
    );
  }

  async function derivedState(pageId: number) {
    const page = await query<{ avg: string | null; embedded_at: Date | null; embedding_dirty: boolean; embedding_status: string }>(
      `SELECT page_avg_embedding::text AS avg, embedded_at, embedding_dirty, embedding_status
         FROM pages WHERE id = $1`,
      [pageId],
    );
    const chunks = await query<{ id: number; chunk_text: string }>(
      'SELECT id, chunk_text FROM page_embeddings WHERE page_id = $1 ORDER BY chunk_index',
      [pageId],
    );
    const edges = await query<{ page_id_1: number; page_id_2: number; relationship_type: string }>(
      `SELECT page_id_1, page_id_2, relationship_type FROM page_relationships
        WHERE page_id_1 = $1 OR page_id_2 = $1
        ORDER BY relationship_type, page_id_1, page_id_2`,
      [pageId],
    );
    return { ...page.rows[0]!, chunks: chunks.rows, edges: edges.rows };
  }

  it('deletes the rows, NULLs the average and drops similarity edges in both directions', async () => {
    const { x, y } = await seedEmbeddedPair();
    const before = await derivedState(x);
    expect(before.edges).toEqual([
      { page_id_1: x, page_id_2: y, relationship_type: 'embedding_similarity' },
      { page_id_1: y, page_id_2: x, relationship_type: 'embedding_similarity' },
      { page_id_1: x, page_id_2: y, relationship_type: 'label_overlap' },
    ]);
    const neighbour = await derivedState(y);
    await shrink(x);

    expect(await embedPage('user-1', x, 'Ops notes', 'DEV', SHORT_BODY)).toBe(0);

    const after = await derivedState(x);
    expect({
      chunks: after.chunks, avg: after.avg, edges: after.edges,
      embedding_dirty: after.embedding_dirty, embedding_status: after.embedding_status,
    }).toEqual({
      chunks: [], avg: null, edges: [{ page_id_1: x, page_id_2: y, relationship_type: 'label_overlap' }],
      embedding_dirty: false, embedding_status: 'not_embedded',
    });
    // Only the settled page loses derived state: Y keeps its rows and average.
    const yAfter = await derivedState(y);
    expect({ chunks: yAfter.chunks, avg: yAfter.avg }).toEqual({ chunks: neighbour.chunks, avg: neighbour.avg });
  });

  it.each(['page_embeddings', 'page_relationships'] as const)(
    'rolls the whole settle back when its %s DELETE fails, so the clearing is one transaction with the settle update',
    async (table) => {
      const { x } = await seedEmbeddedPair();
      await shrink(x);
      const before = await derivedState(x);
      // Failure injection, once per DELETE: the settle UPDATE (and, for the
      // edge DELETE, the chunk DELETE) have already run when it raises, so
      // any statement that left the settle transaction shows up half-applied.
      try {
        await query(`CREATE OR REPLACE FUNCTION test_1714_refuse_delete() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'injected % delete failure (#1714)', TG_TABLE_NAME; END $$`);
        await query(`CREATE TRIGGER test_1714_refuse_delete BEFORE DELETE ON ${table}
          FOR EACH ROW EXECUTE FUNCTION test_1714_refuse_delete()`);
        await expect(embedPage('user-1', x, 'Ops notes', 'DEV', SHORT_BODY))
          .rejects.toThrow(`injected ${table} delete failure`);
      } finally {
        await query(`DROP TRIGGER IF EXISTS test_1714_refuse_delete ON ${table}`);
        await query('DROP FUNCTION IF EXISTS test_1714_refuse_delete()');
      }

      // Nothing half-applied: rows, average, edges, embedded_at, the dirty
      // flag and the status all roll back with the failing statement.
      expect(await derivedState(x)).toEqual(before);
    },
  );

  it('resets embedded_at', async () => {
    const x = await seedEmbeddedPage('Ops notes', DELETED_TEXT, 0);
    await shrink(x);

    expect(await embedPage('user-1', x, 'Ops notes', 'DEV', SHORT_BODY)).toBe(0);

    expect((await derivedState(x)).embedded_at).toBeNull();
  });

  it('stops semantic and hybrid search from answering with the deleted text', async () => {
    // Synthetic provider: every question embeds onto X's old chunk vector.
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (part) => { raw += String(part); });
      req.on('end', () => {
        const body: unknown = JSON.parse(raw);
        const input = body && typeof body === 'object' && 'input' in body ? body.input : [];
        const count = Array.isArray(input) ? input.length : 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          object: 'list', model: 'synthetic', usage: { prompt_tokens: 1, total_tokens: 1 },
          data: Array.from({ length: count }, (_, index) => ({ object: 'embedding', index, embedding: unitVec(0) })),
        }));
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No loopback address');
      const { port } = address;
      await query(
        `INSERT INTO llm_providers (name, base_url, auth_type, default_model, is_default)
         VALUES ('synthetic-1714', $1, 'none', 'synthetic', TRUE)`,
        [`http://127.0.0.1:${port}/v1`],
      );
      const reader = (await query<{ id: string }>(
        `INSERT INTO users (username, email, password_hash, role)
         VALUES ('reader-1714', 'reader-1714@test', 'x', 'user') RETURNING id`,
      )).rows[0]!.id;
      const { x } = await seedEmbeddedPair();
      // The two calls /api/search makes for mode=semantic and mode=hybrid.
      const textsFor = async () => ({
        semantic: (await vectorSearch(reader, unitVec(0), 10, { aiPolicy: { purpose: 'human' } }))
          .filter((r) => r.pageId === x).map((r) => r.chunkText),
        hybrid: (await hybridSearch(reader, 'rotate the vault root token', 10, undefined, {
          aiPolicy: { purpose: 'human' }, surface: 'search', recordAnalytics: false,
        })).filter((r) => r.pageId === x).map((r) => r.chunkText),
      });
      const before = await textsFor();
      expect(before.semantic.join(' ')).toContain('rotate the vault root token');
      expect(before.hybrid.join(' ')).toContain('rotate the vault root token');
      await shrink(x);

      expect(await embedPage('user-1', x, 'Ops notes', 'DEV', SHORT_BODY)).toBe(0);

      expect(await textsFor()).toEqual({ semantic: [], hybrid: [] });
    } finally {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    }
  }, 30_000);

  it('keeps rows, average, edges and the new dirty flag when an edit commits while the settle waits for the page-row lock', async () => {
    const { x } = await seedEmbeddedPair();
    await shrink(x);
    // The worker's snapshot is the short body at the shrink's revision.
    const snapshot = await derivedState(x);
    const snapshotRevision = (await query<{ content_revision: string }>(
      'SELECT content_revision::text FROM pages WHERE id = $1', [x],
    )).rows[0]!.content_revision;
    const holder = await getPool().connect();
    let settling: Promise<number> | undefined;
    let waited = false;
    try {
      const holderPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      // Between the worker's snapshot and its settle, a concurrent writer
      // grows the page again and raises its dirty flag, holding the row until
      // the settle queues behind it. (An edit that commits earlier is refused
      // before the settle, by embeddingOperation's xmin-bound FOR SHARE.)
      compose.beforePlan = async () => {
        compose.beforePlan = null;
        await holder.query('BEGIN');
        await holder.query(
          'UPDATE pages SET body_html = $2, body_text = $3, embedding_dirty = TRUE WHERE id = $1',
          [x, `<p>${GROWN_TEXT}</p>`, GROWN_TEXT],
        );
      };
      settling = embedPage('user-1', x, 'Ops notes', 'DEV', SHORT_BODY);
      waited = await waitForDatabaseCondition(async () => (await query<{ waiting: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
                         WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))) AS waiting`,
        [holderPid],
      )).rows[0]!.waiting);
      await holder.query('COMMIT');
    } catch (err) {
      await holder.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      holder.release();
    }
    expect(await settling).toBe(0);
    // The settle really queued behind the writer's row lock.
    expect(waited).toBe(true);

    const after = await derivedState(x);
    expect(after).toEqual(snapshot);
    expect(after.embedding_dirty).toBe(true);
    // The writer won: its body, and a content_revision past the snapshot's.
    const page = await query<{ body_text: string; content_revision: string }>(
      'SELECT body_text, content_revision::text FROM pages WHERE id = $1', [x],
    );
    expect(page.rows[0]!.body_text).toBe(GROWN_TEXT);
    expect(BigInt(page.rows[0]!.content_revision)).toBeGreaterThan(BigInt(snapshotRevision));
  }, 30_000);

  it('refuses on the content_revision fence alone when the snapshot is stale but the claimed article is current', async () => {
    // Isolates the revision fence: the article (claimed on the CURRENT row)
    // passes the source fence, while the worker's own snapshot (revision and
    // short text) predates the shrink. Production callers cannot hand
    // embedPage this mix; the source fence refuses them first (T4).
    const { x } = await seedEmbeddedPair();
    const staleRevision = (await query<{ content_revision: string }>(
      'SELECT content_revision::text FROM pages WHERE id = $1', [x],
    )).rows[0]!.content_revision;
    await shrink(x);
    const article = await claimEmbeddingArticle(await captureEmbeddingArticle(x, 'Ops notes', 'DEV', SHORT_BODY));
    expect(article).not.toBeNull();
    const before = await derivedState(x);

    expect(await embedPage('user-1', x, 'Ops notes', 'DEV', '<p>yo</p>', {
      article: article!, contentRevision: staleRevision,
    })).toBe(0);

    expect(await derivedState(x)).toEqual(before);
  });

  it.each([
    { write: 'draft autosave', sql: "UPDATE pages SET draft_body_html = '<p>Unpublished draft</p>', draft_updated_at = NOW() WHERE id = $1" },
    { write: 'label edit', sql: "UPDATE pages SET labels = ARRAY['ops'] WHERE id = $1" },
  ] as const)('still clears after a $write moved content_revision past the snapshot without touching title or body', async ({ sql }) => {
    // processDirtyPages hands each page the revision its batch SELECT read; a
    // non-text protected write can move it before the page's turn. The fence
    // rejects a moved revision only when the title or body_html differ.
    const { x, y } = await seedEmbeddedPair();
    await shrink(x);
    const revisionOf = async () => (await query<{ content_revision: string }>(
      'SELECT content_revision::text FROM pages WHERE id = $1', [x],
    )).rows[0]!.content_revision;
    const snapshotRevision = await revisionOf();
    await query(sql, [x]);
    expect(BigInt(await revisionOf())).toBeGreaterThan(BigInt(snapshotRevision));

    expect(await embedPage('user-1', x, 'Ops notes', 'DEV', SHORT_BODY, { contentRevision: snapshotRevision })).toBe(0);

    const after = await derivedState(x);
    expect({
      chunks: after.chunks, avg: after.avg, edges: after.edges, embedded_at: after.embedded_at,
      embedding_dirty: after.embedding_dirty, embedding_status: after.embedding_status,
    }).toEqual({
      chunks: [], avg: null, edges: [{ page_id_1: x, page_id_2: y, relationship_type: 'label_overlap' }],
      embedded_at: null, embedding_dirty: false, embedding_status: 'not_embedded',
    });
  });

  it.each([
    { status: 'active', pageColumn: 'page_avg_embedding_next', chunkColumn: 'embedding_next' },
    { status: 'swapped', pageColumn: 'page_avg_embedding_prev', chunkColumn: 'embedding_prev' },
  ] as const)('NULLs $pageColumn while the shadow migration is $status', async ({ status, pageColumn, chunkColumn }) => {
    // #1116 adds these columns at runtime (no numbered migration), so the
    // case adds them and drops them again: the worker DB must end canonical.
    await query(`ALTER TABLE page_embeddings ADD COLUMN IF NOT EXISTS ${chunkColumn} vector(1024)`);
    await query(`ALTER TABLE pages ADD COLUMN IF NOT EXISTS ${pageColumn} vector(1024)`);
    try {
      await query(
        `INSERT INTO admin_settings (setting_key, setting_value) VALUES ('embedding_shadow_migration', $1)`,
        [JSON.stringify({
          status, providerId: '00000000-0000-4000-8000-000000001714', model: 'candidate-model',
          dimensions: 1024, columnType: 'vector(1024)', indexed: false, startedAt: '2026-11-01T00:00:00.000Z',
          ...(status === 'swapped' ? { swappedAt: '2026-11-02T00:00:00.000Z' } : {}),
        })],
      );
      const x = await seedEmbeddedPage('Ops notes', DELETED_TEXT, 0);
      await query(`UPDATE page_embeddings SET ${chunkColumn} = embedding WHERE page_id = $1`, [x]);
      await query(`UPDATE pages SET ${pageColumn} = page_avg_embedding WHERE id = $1`, [x]);
      await shrink(x);

      expect(await embedPage('user-1', x, 'Ops notes', 'DEV', SHORT_BODY)).toBe(0);

      const { rows } = await query<{ chunks: number; live: string | null; shadow: string | null }>(
        `SELECT (SELECT COUNT(*)::int FROM page_embeddings WHERE page_id = $1) AS chunks,
                page_avg_embedding::text AS live, ${pageColumn}::text AS shadow
           FROM pages WHERE id = $1`,
        [x],
      );
      expect(rows[0]).toEqual({ chunks: 0, live: null, shadow: null });
    } finally {
      await query(`ALTER TABLE page_embeddings DROP COLUMN IF EXISTS ${chunkColumn}`);
      await query(`ALTER TABLE pages DROP COLUMN IF EXISTS ${pageColumn}`);
    }
  });

  it('settles the defensive empty-chunk return through the same clearing path', async () => {
    const x = await seedEmbeddedPage('Ops notes', DELETED_TEXT, 0);
    await shrink(x);
    // Substantive derived text that composes no chunk: the floor passes and
    // nothing is left to embed.
    compose.plan = { revision: 0, chunks: [], substantiveChars: MIN_EMBEDDABLE_TEXT_CHARS };

    expect(await embedPage('user-1', x, 'Ops notes', 'DEV', SHORT_BODY)).toBe(0);

    const after = await derivedState(x);
    expect({
      chunks: after.chunks, avg: after.avg, embedded_at: after.embedded_at,
      embedding_dirty: after.embedding_dirty, embedding_status: after.embedding_status,
    }).toEqual({ chunks: [], avg: null, embedded_at: null, embedding_dirty: false, embedding_status: 'not_embedded' });
  });

  it('locks page_embeddings before pages, the #1116 DDL order, so a swap waiting on both cannot deadlock it', async () => {
    const x = await seedEmbeddedPage('Ops notes', DELETED_TEXT, 0);
    await shrink(x);
    // A swap/abort/cleanup locks page_embeddings, then pages, in ACCESS
    // EXCLUSIVE mode. A settle that held a pages lock while queueing for
    // page_embeddings would close a cycle the deadlock detector breaks by
    // aborting one side.
    const ddl = await getPool().connect();
    let settling: Promise<number> | undefined;
    let waited = false;
    try {
      await ddl.query('BEGIN');
      await ddl.query('LOCK TABLE page_embeddings IN ACCESS EXCLUSIVE MODE');
      const ddlPid = (await ddl.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      settling = embedPage('user-1', x, 'Ops notes', 'DEV', SHORT_BODY);
      waited = await waitForDatabaseCondition(async () => (await query<{ waiting: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
                         WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))) AS waiting`,
        [ddlPid],
      )).rows[0]!.waiting);
      await ddl.query('LOCK TABLE pages IN ACCESS EXCLUSIVE MODE');
      await ddl.query('COMMIT');
    } catch (err) {
      await ddl.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      ddl.release();
    }
    expect(await settling).toBe(0);
    const after = await derivedState(x);
    expect({ chunks: after.chunks, avg: after.avg }).toEqual({ chunks: [], avg: null });
    // The settle really queued behind the DDL's first lock.
    expect(waited).toBe(true);
  }, 30_000);
});
