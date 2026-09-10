import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server, type ServerResponse, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  setupTestDb,
  truncateAllTables,
  teardownTestDb,
  isDbAvailable,
} from '../../../test-db-helper.js';
import { query, getPool, getVectorPool } from '../../../core/db/postgres.js';
import {
  invalidateRagImageLegCache,
  invalidateRagEfSearchCache,
} from '../../../core/services/admin-settings-service.js';
import {
  ensureImageEmbeddingColumn,
  IMAGE_EMBEDDING_HNSW_INDEX,
} from './image-embedding-index.js';
import pgvector from 'pgvector';

/**
 * #1115 P3 — the image retrieval leg, end to end against real Postgres.
 *
 * Only the PROVIDER is mocked, and it is mocked at the HTTP boundary
 * (CLAUDE.md): one local `node:http` server answers BOTH shapes on
 * `/v1/embeddings` — the plain `{model, input}` the text embedder posts and
 * the `messages` array the VL client posts — so the gate, the resolver, the
 * kNN, the visibility predicate, the fusion and the analytics write are all
 * production code over production SQL.
 *
 * Vectors are 4-dimensional on both sides. `ensureImageEmbeddingColumn(4, …)`
 * retypes the image column for this file and `afterAll` restores migration
 * 093's placeholder, so the migration's own test keeps asserting the migration
 * whichever file ran first.
 */

const dbAvailable = await isDbAvailable();

const DIMS = 4;
const TEXT_MODEL = 'text-embed';
const VL_MODEL = 'Qwen/Qwen3-VL-Embedding-2B';
const RERANK_MODEL = 'bge-reranker-v2-m3';

const USER = 'eeeeeeee-1115-4000-8000-000000000001';
const OTHER = 'eeeeeeee-1115-4000-8000-000000000002';
const SPACE = 'IMG';
const HIDDEN_SPACE = 'SECRET';

let srv: Server;
let baseUrl: string;
/** Every body the mock server received, in order. */
let calls: Array<{ kind: 'text' | 'vl'; body: Record<string, unknown> }> = [];
/**
 * Responses deliberately left unanswered (the latency-budget case), released
 * in `afterEach` so `srv.close()` in `afterAll` is not waiting on a socket.
 */
const heldResponses: ServerResponse[] = [];
/** Overridable per test — a VL failure is how the degraded path is exercised. */
let vlRespond: (res: ServerResponse) => void = (res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ data: [{ embedding: unit(0) }] }));
};

/** A unit vector pointing along axis `axis` — cosine 1 with itself, 0 with the others. */
function unit(axis: number): number[] {
  return Array.from({ length: DIMS }, (_, i) => (i === axis ? 1 : 0));
}

/** The same, at the TEXT column's width (`page_embeddings.embedding` is 1024). */
const TEXT_DIMS = 1024;
function textUnit(axis: number): number[] {
  return Array.from({ length: TEXT_DIMS }, (_, i) => (i === axis ? 1 : 0));
}

function vlCalls(): Array<Record<string, unknown>> {
  return calls.filter((c) => c.kind === 'vl').map((c) => c.body);
}

// ── DB fixtures ───────────────────────────────────────────────────────────

async function seedUser(id: string): Promise<void> {
  await query(
    `INSERT INTO users (id, username, email, role, password_hash)
     VALUES ($1::uuid, $1::text, $1::text || '@t', 'user', 'x')
     ON CONFLICT (id) DO NOTHING`,
    [id],
  );
}

async function grantSpace(userId: string, spaceKey: string): Promise<void> {
  await seedUser(userId);
  await query(
    `INSERT INTO spaces (space_key, space_name) VALUES ($1, $1) ON CONFLICT (space_key) DO NOTHING`,
    [spaceKey],
  );
  // `truncateAllTables` empties `roles` too, so the seeded viewer row has to be
  // re-created per test rather than assumed.
  await query(
    `INSERT INTO roles (name, display_name, description) VALUES ('viewer', 'Viewer', 'test viewer')
     ON CONFLICT (name) DO NOTHING`,
  );
  const role = await query<{ id: number }>(`SELECT id FROM roles WHERE name = 'viewer'`);
  await query(
    `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
     VALUES ($1, 'user', $2, $3) ON CONFLICT DO NOTHING`,
    [spaceKey, userId, role.rows[0]!.id],
  );
}

async function seedPage(opts: {
  title: string;
  spaceKey?: string;
  confluenceId?: string | null;
  pageSource?: 'confluence' | 'standalone';
  bodyText?: string;
  /** Insert a chunk-0 `page_embeddings` row pointing along this axis. */
  chunkAxis?: number | null;
  chunkText?: string;
}): Promise<number> {
  const {
    title,
    spaceKey = SPACE,
    confluenceId = `cid-${title.replace(/\W+/g, '-')}`,
    pageSource = 'confluence',
    bodyText = `${title} body text long enough to clear the embeddable minimum`,
    chunkAxis = null,
    chunkText,
  } = opts;
  const r = await query<{ id: number }>(
    `INSERT INTO pages (confluence_id, source, space_key, title, body_text, body_storage, body_html,
                        page_type, visibility)
     VALUES ($1, $2, $3, $4, $5, '', '<p>x</p>', 'page', 'shared') RETURNING id`,
    [confluenceId, pageSource, pageSource === 'confluence' ? spaceKey : null, title, bodyText],
  );
  const pageId = r.rows[0]!.id;
  if (chunkAxis !== null) {
    await query(
      `INSERT INTO page_embeddings (page_id, chunk_index, chunk_text, embedding, metadata)
       VALUES ($1, 0, $2, $3, $4::jsonb)`,
      [
        pageId,
        chunkText ?? `${title} chunk zero`,
        pgvector.toSql(textUnit(chunkAxis)),
        JSON.stringify({ page_title: title, section_title: title, space_key: pageSource === 'confluence' ? spaceKey : null }),
      ],
    );
  }
  return pageId;
}

async function seedImage(pageId: number, key: string, axis: number, source: 'confluence' | 'local' = 'confluence'): Promise<void> {
  await query(
    `INSERT INTO page_image_embeddings
       (page_id, source, attachment_key, sha256, format, width, height, model, embedding)
     VALUES ($1, $2, $3, 'sha', 'png', 10, 10, $4, $5)`,
    [pageId, source, key, VL_MODEL, pgvector.toSql(unit(axis))],
  );
}

/** The same, at an arbitrary vector — for fixtures that need a rank ORDER. */
async function seedImageVec(pageId: number, key: string, vec: number[]): Promise<void> {
  await query(
    `INSERT INTO page_image_embeddings
       (page_id, source, attachment_key, sha256, format, model, embedding)
     VALUES ($1, 'confluence', $2, 's', 'png', $4, $3)`,
    [pageId, key, pgvector.toSql(vec), VL_MODEL],
  );
}

async function assignProviders(opts: { vl?: boolean; rerank?: boolean } = {}): Promise<void> {
  const textProv = await query<{ id: string }>(
    `INSERT INTO llm_providers (name, base_url, auth_type, verify_ssl, default_model, is_default)
     VALUES ('text-box', $1, 'none', TRUE, $2, TRUE) RETURNING id`,
    [baseUrl, TEXT_MODEL],
  );
  await query(
    `INSERT INTO llm_usecase_assignments (usecase, provider_id, model) VALUES ('embedding', $1, $2)`,
    [textProv.rows[0]!.id, TEXT_MODEL],
  );
  if (opts.vl !== false) {
    const vlProv = await query<{ id: string }>(
      `INSERT INTO llm_providers (name, base_url, auth_type, verify_ssl, default_model)
       VALUES ('vl-box', $1, 'none', TRUE, $2) RETURNING id`,
      [baseUrl, VL_MODEL],
    );
    await query(
      `INSERT INTO llm_usecase_assignments (usecase, provider_id, model) VALUES ('image_embedding', $1, $2)`,
      [vlProv.rows[0]!.id, VL_MODEL],
    );
  }
  if (opts.rerank) {
    const rrProv = await query<{ id: string }>(
      `INSERT INTO llm_providers (name, base_url, auth_type, verify_ssl, default_model)
       VALUES ('rerank-box', $1, 'none', TRUE, $2) RETURNING id`,
      [baseUrl, RERANK_MODEL],
    );
    await query(
      `INSERT INTO llm_usecase_assignments (usecase, provider_id, model) VALUES ('rerank', $1, $2)`,
      [rrProv.rows[0]!.id, RERANK_MODEL],
    );
  }
}

async function setSetting(key: string, value: string): Promise<void> {
  await query(
    `INSERT INTO admin_settings (setting_key, setting_value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (setting_key) DO UPDATE SET setting_value = $2, updated_at = NOW()`,
    [key, value],
  );
  invalidateRagImageLegCache();
}

/**
 * Make ONE statement fail and leave every other statement on real Postgres.
 *
 * The two reads this exercises — the gate's `EXISTS` and the lede fetch for
 * image-only pages — fail on facts about the DATABASE (a `lock_timeout`
 * against a concurrent rebuild's ACCESS EXCLUSIVE on `page_image_embeddings`,
 * a pool-level error), and neither has a SQL-level trigger a test can pull
 * without collateral: renaming a table breaks the text legs in the same
 * request, and every column the lede fetch reads is read by the vector leg
 * too — which would flip `degraded_reason` to `embedding_failed` and prove
 * nothing about this leg. So the fault goes in at the DRIVER, for the one
 * statement that matches, spied through to the real pool for everything else.
 * That is the `vi.spyOn` passthrough the route tests use, one layer down;
 * `vi.restoreAllMocks()` in `afterEach` takes it out again.
 */
function failStatementsMatching(needle: string): void {
  const pool = getPool();
  const original = pool.query.bind(pool) as (...args: unknown[]) => unknown;
  vi.spyOn(pool, 'query').mockImplementation(((...args: unknown[]) => {
    const text = args[0];
    if (typeof text === 'string' && text.includes(needle)) {
      return Promise.reject(new Error('injected: statement could not be executed'));
    }
    return original(...args);
  }) as unknown as typeof pool.query);
}

/**
 * Record every SQL string this leg runs on its checked-out VECTOR-pool client,
 * and hand the borrowed client back exactly as it was found.
 *
 * `SET LOCAL` is invisible after the transaction ends and invisible to a
 * `pool.query` spy, because the leg owns a client. Without this, the fourth
 * kNN callsite was the one #1285 left unpinned: swapping its `efSearchFor` for
 * a hardcoded floor kept every suite in the repo green (review r1, mutation B).
 *
 * The restore in `release` is load-bearing rather than tidy: pg hands the SAME
 * client object to the next borrower, so a permanently wrapped `query` would
 * keep pushing into a dead array for the rest of the file.
 */
function recordVectorClientSql(): string[] {
  const seen: string[] = [];
  const pool = getVectorPool();
  const connect = pool.connect.bind(pool) as () => Promise<{
    query: (...args: unknown[]) => unknown;
    release: (...args: unknown[]) => unknown;
  }>;
  vi.spyOn(pool, 'connect').mockImplementation((async () => {
    const client = await connect();
    const realQuery = client.query.bind(client);
    const realRelease = client.release.bind(client);
    client.query = (...args: unknown[]) => {
      if (typeof args[0] === 'string') seen.push(args[0]);
      return realQuery(...args);
    };
    client.release = (...args: unknown[]) => {
      client.query = realQuery;
      client.release = realRelease;
      return realRelease(...args);
    };
    return client;
  }) as unknown as typeof pool.connect);
  return seen;
}

/** The gate's fourth condition, verbatim enough to match only itself. */
const INDEX_PROBE_SQL = 'EXISTS(SELECT 1 FROM page_image_embeddings)';
/** The lede fetch for image-only pages — the only `LEFT JOIN` on chunk 0. */
const LEDE_FETCH_SQL = 'LEFT JOIN page_embeddings pe ON pe.page_id = cp.id AND pe.chunk_index = 0';

const { hybridSearch, flushSearchAnalytics } = await import('./rag-service.js');
const { searchImageLeg, IMAGE_LEG_KNN_TIMEOUT_MS } = await import('./image-leg-search.js');

async function lastAnalytics(): Promise<{ search_type: string; degraded_reason: string | null }> {
  await flushSearchAnalytics();
  const r = await query<{ search_type: string; degraded_reason: string | null }>(
    `SELECT search_type, degraded_reason FROM search_analytics ORDER BY created_at DESC, id DESC LIMIT 1`,
  );
  return r.rows[0]!;
}

describe.skipIf(!dbAvailable)('image retrieval leg (#1115 P3)', () => {
  beforeAll(async () => {
    await setupTestDb();
    srv = createServer((req: IncomingMessage, res: ServerResponse) => {
      // The deep-search test needs a `chat` provider too — one server, three
      // shapes, all at the HTTP boundary.
      if (req.url === '/v1/chat/completions' && req.method === 'POST') {
        req.resume();
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            choices: [{ message: { content: 'servicing the turbine\nturbine maintenance steps' } }],
          }));
        });
        return;
      }
      // …and a FOURTH for the rerank stage, which the image leg has to survive
      // (it is the recommended production configuration, #1104). It rescores
      // in reverse so the reranked branch is provably the one that ran.
      if (req.url === '/v1/rerank' && req.method === 'POST') {
        let rerankRaw = '';
        req.on('data', (c) => (rerankRaw += c));
        req.on('end', () => {
          const body = JSON.parse(rerankRaw) as { documents?: string[] };
          const n = body.documents?.length ?? 0;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            results: Array.from({ length: n }, (_, i) => ({
              index: n - 1 - i,
              relevance_score: 1 - i * 0.1,
            })),
          }));
        });
        return;
      }
      if (req.url !== '/v1/embeddings' || req.method !== 'POST') {
        res.writeHead(404);
        res.end();
        return;
      }
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        // The two shapes on one path: `messages` is the VL chat-embeddings
        // extension (ADR-025 D4), `input` the ordinary text embedder.
        if (body.messages !== undefined) {
          calls.push({ kind: 'vl', body });
          vlRespond(res);
          return;
        }
        calls.push({ kind: 'text', body });
        res.writeHead(200, { 'content-type': 'application/json' });
        // The text query points at axis 3 — an axis no fixture chunk uses, so
        // the vector leg contributes nothing unless a test says otherwise.
        res.end(JSON.stringify({ data: [{ embedding: textUnit(3) }] }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, r));
    baseUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => srv.close(() => r()));
    await flushSearchAnalytics();
    await query(`DROP INDEX IF EXISTS ${IMAGE_EMBEDDING_HNSW_INDEX}`);
    // Empty first: a retype cannot cast 4-dim rows into a 2048-dim column.
    await query(`TRUNCATE page_image_embeddings`);
    await query(`ALTER TABLE page_image_embeddings ALTER COLUMN embedding TYPE vector(2048)`);
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    calls = [];
    vlRespond = (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ embedding: unit(0) }] }));
    };
    invalidateRagImageLegCache();
    invalidateRagEfSearchCache();
    await ensureImageEmbeddingColumn(DIMS, {
      providerId: '22222222-2222-4222-8222-222222222222',
      model: VL_MODEL,
      baseUrl: 'http://vl/v1',
      targetDimensions: null,
    });
    await grantSpace(USER, SPACE);
    await seedUser(OTHER);
  });

  afterEach(() => {
    invalidateRagImageLegCache();
    invalidateRagEfSearchCache();
    vi.restoreAllMocks();
    while (heldResponses.length > 0) {
      const res = heldResponses.pop()!;
      if (!res.writableEnded) res.destroy();
    }
  });

  // ── The gate ────────────────────────────────────────────────────────────

  describe('the gate', () => {
    it('does not run — and costs no VL call — when the use case is unassigned', async () => {
      await assignProviders({ vl: false });
      const page = await seedPage({ title: 'Turbine' });
      await seedImage(page, 'turbine.png', 0);

      const out = await searchImageLeg(USER, 'what does the turbine look like', { limit: 10 });

      expect(out).toEqual({ ran: false, failed: false, pages: [] });
      expect(vlCalls()).toHaveLength(0);
    });

    it('does not run when rag_image_leg_enabled is off', async () => {
      await assignProviders();
      const page = await seedPage({ title: 'Turbine' });
      await seedImage(page, 'turbine.png', 0);
      await setSetting('rag_image_leg_enabled', 'false');

      const out = await searchImageLeg(USER, 'turbine', { limit: 10 });

      expect(out.ran).toBe(false);
      expect(out.failed).toBe(false);
      expect(vlCalls()).toHaveLength(0);
    });

    it('does not run when the index is empty, even with everything assigned and on', async () => {
      // Uncached on purpose: this is the condition that flips the first time
      // the worker embeds a page and again the moment a rebuild truncates.
      await assignProviders();
      await seedPage({ title: 'Turbine' });

      const out = await searchImageLeg(USER, 'turbine', { limit: 10 });

      expect(out.ran).toBe(false);
      expect(vlCalls()).toHaveLength(0);
    });

    it('sees the index become non-empty within the same process — no cached emptiness', async () => {
      await assignProviders();
      const page = await seedPage({ title: 'Turbine' });
      expect((await searchImageLeg(USER, 'turbine', { limit: 10 })).ran).toBe(false);

      await seedImage(page, 'turbine.png', 0);

      expect((await searchImageLeg(USER, 'turbine', { limit: 10 })).ran).toBe(true);
    });

    it('imageLeg:false forces it off past an assigned, enabled, non-empty index', async () => {
      await assignProviders();
      const page = await seedPage({ title: 'Turbine' });
      await seedImage(page, 'turbine.png', 0);

      const out = await searchImageLeg(USER, 'turbine', { limit: 10, imageLeg: false });

      expect(out).toEqual({ ran: false, failed: false, pages: [] });
      expect(vlCalls()).toHaveLength(0);
    });

    it('imageLeg:true forces past the SETTING but not past an unassigned use case', async () => {
      await assignProviders({ vl: false });
      const page = await seedPage({ title: 'Turbine' });
      await seedImage(page, 'turbine.png', 0);
      await setSetting('rag_image_leg_enabled', 'false');

      expect((await searchImageLeg(USER, 'turbine', { limit: 10, imageLeg: true })).ran).toBe(false);
      expect(vlCalls()).toHaveLength(0);

      // …and with the model assigned, the same forced call DOES run.
      await truncateAllTables();
      await grantSpace(USER, SPACE);
      await assignProviders();
      const page2 = await seedPage({ title: 'Turbine' });
      await seedImage(page2, 'turbine.png', 0);
      await setSetting('rag_image_leg_enabled', 'false');

      expect((await searchImageLeg(USER, 'turbine', { limit: 10, imageLeg: true })).ran).toBe(true);
      expect(vlCalls()).toHaveLength(1);
    });
  });

  // ── The query embed ─────────────────────────────────────────────────────

  describe('the query embed', () => {
    it('sends the query instruction as a system message, once, in the chat-embeddings shape', async () => {
      await assignProviders();
      const page = await seedPage({ title: 'Turbine' });
      await seedImage(page, 'turbine.png', 0);

      await searchImageLeg(USER, 'what does the turbine look like', { limit: 10 });

      expect(vlCalls()).toHaveLength(1);
      const body = vlCalls()[0]!;
      expect(body.model).toBe(VL_MODEL);
      expect(body.continue_final_message).toBe(true);
      const messages = body.messages as Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
      expect(messages[0]!.role).toBe('system');
      expect(messages[0]!.content[0]!.text).toBe(
        "Retrieve images or text relevant to the user's query.",
      );
      expect(messages[1]!.content[0]!.text).toBe('what does the turbine look like');
      expect(messages[2]!.role).toBe('assistant');
    });

    it('requests the configured MRL truncation width', async () => {
      await assignProviders();
      const page = await seedPage({ title: 'Turbine' });
      await seedImage(page, 'turbine.png', 0);
      await setSetting('image_embedding_target_dimensions', String(DIMS));

      await searchImageLeg(USER, 'turbine', { limit: 10 });

      expect(vlCalls()[0]!.dimensions).toBe(DIMS);
    });
  });

  // ── Visibility ──────────────────────────────────────────────────────────

  it('never returns a page the user cannot see', async () => {
    // Mutation check: delete the visibility predicate from the image kNN and
    // this fails. An image row carries no ACL of its own — the JOIN and the
    // shared `visiblePagesPredicate` are the whole protection.
    await assignProviders();
    await query(`INSERT INTO spaces (space_key, space_name) VALUES ($1, $1)`, [HIDDEN_SPACE]);
    const visible = await seedPage({ title: 'Public turbine' });
    const hidden = await seedPage({ title: 'Secret turbine', spaceKey: HIDDEN_SPACE });
    const privateOther = await seedPage({
      title: 'Private turbine', pageSource: 'standalone', confluenceId: null,
    });
    await query(
      `UPDATE pages SET visibility = 'private', created_by_user_id = $2 WHERE id = $1`,
      [privateOther, OTHER],
    );
    await seedImage(visible, 'a.png', 0);
    await seedImage(hidden, 'b.png', 0);
    await seedImage(privateOther, 'c.png', 0);

    const out = await searchImageLeg(USER, 'turbine', { limit: 10 });

    expect(out.pages.map((p) => p.pageId)).toEqual([visible]);
  });

  it('honours a spaceKey narrow, exactly as the two text legs do', async () => {
    await assignProviders();
    await grantSpace(USER, 'OTHERSPACE');
    const inScope = await seedPage({ title: 'In scope' });
    const outOfScope = await seedPage({ title: 'Out of scope', spaceKey: 'OTHERSPACE' });
    await seedImage(inScope, 'a.png', 0);
    await seedImage(outOfScope, 'b.png', 0);

    const out = await searchImageLeg(USER, 'turbine', { limit: 10, spaceKey: SPACE });

    expect(out.pages.map((p) => p.pageId)).toEqual([inScope]);
  });

  it('runs its kNN at the configured rag_ef_search floor (#1285)', async () => {
    // The fourth callsite, pinned. #1285's acceptance criterion is that ALL
    // FOUR kNN probes read the same floor; the other three assert their
    // `SET LOCAL` value, and this one asserted only that the statement parsed
    // — a hardcoded 100 here passed the whole repo (review r1).
    //
    // 500 is chosen to be none of the alternatives a regression would produce:
    // not the 100 default, not `2 x rawLimit` (80 at limit 10), not pgvector's
    // 1000 ceiling.
    await assignProviders();
    const page = await seedPage({ title: 'Turbine' });
    await seedImage(page, 'turbine.png', 0);
    await setSetting('rag_ef_search', '500');
    invalidateRagEfSearchCache();
    const sql = recordVectorClientSql();

    const out = await searchImageLeg(USER, 'turbine', { limit: 10 });

    // The leg really ran — otherwise the assertion below passes vacuously on
    // an empty array.
    expect(out.pages.map((p) => p.pageId)).toEqual([page]);
    expect(sql).toContain('SET LOCAL hnsw.ef_search = 500');
  });

  it('excludes soft-deleted pages', async () => {
    await assignProviders();
    const alive = await seedPage({ title: 'Alive' });
    const dead = await seedPage({ title: 'Deleted' });
    await seedImage(alive, 'a.png', 0);
    await seedImage(dead, 'b.png', 0);
    await query(`UPDATE pages SET deleted_at = NOW() WHERE id = $1`, [dead]);

    const out = await searchImageLeg(USER, 'turbine', { limit: 10 });

    expect(out.pages.map((p) => p.pageId)).toEqual([alive]);
  });

  // ── Page denomination ───────────────────────────────────────────────────

  it('counts a page ONCE however many of its images match, and ranks by its best', async () => {
    // Mutation check: drop the per-page dedupe and `crowded` occupies three of
    // the leg's ranks, out-scoring `better` under RRF on image COUNT.
    await assignProviders();
    const crowded = await seedPage({ title: 'Crowded' });
    const better = await seedPage({ title: 'Better' });
    // Query vector is axis 0. Crowded's images sit slightly off it; Better's
    // sits exactly on it.
    await query(
      `INSERT INTO page_image_embeddings (page_id, source, attachment_key, sha256, format, model, embedding)
       VALUES ($1, 'confluence', 'c1.png', 's', 'png', $3, $2)`,
      [crowded, pgvector.toSql([0.9, 0.436, 0, 0]), VL_MODEL],
    );
    await query(
      `INSERT INTO page_image_embeddings (page_id, source, attachment_key, sha256, format, model, embedding)
       VALUES ($1, 'confluence', 'c2.png', 's', 'png', $3, $2)`,
      [crowded, pgvector.toSql([0.85, 0.527, 0, 0]), VL_MODEL],
    );
    await query(
      `INSERT INTO page_image_embeddings (page_id, source, attachment_key, sha256, format, model, embedding)
       VALUES ($1, 'confluence', 'c3.png', 's', 'png', $3, $2)`,
      [crowded, pgvector.toSql([0.8, 0.6, 0, 0]), VL_MODEL],
    );
    await seedImage(better, 'b1.png', 0);

    const out = await searchImageLeg(USER, 'turbine', { limit: 10 });

    expect(out.pages.map((p) => p.pageId)).toEqual([better, crowded]);
    expect(out.pages[0]!.hits).toHaveLength(1);
    // The crowded page keeps its extra hits for the source list, best-first,
    // but they buy it no rank.
    expect(out.pages[1]!.hits.map((h) => h.key)).toEqual(['c1.png', 'c2.png', 'c3.png']);
    // The RAW position of each page's best image survives the collapse —
    // `fuseWithStableHead` reconstructs a narrower request's image leg from it,
    // and a page whose best picture sits past the narrow raw window must not
    // enter the stable head. `better` is raw row 0 and `crowded` raw row 1.
    expect(out.pages.map((p) => p.bestRawIndex)).toEqual([0, 1]);
  });

  it('OVER-FETCHES raw rows so one gallery cannot eat the page window', async () => {
    // Review r3. `imageRawLimit` was deletable with the suite green: every
    // existing fixture ran at `limit: 10`, a window wide enough to hold all
    // its rows either way. The leg is denominated in PAGES over a kNN of
    // IMAGE rows, so at a small stage limit a page carrying several pictures
    // fills the raw window on its own and the leg answers with one page where
    // two were asked for. `imageRawLimit(2)` is 8, which reaches past the six
    // images below to the seventh row.
    //
    // Mutation check: `const rawLimit = opts.limit;` and this returns [gallery]
    // alone. It is also the window `fuseWithStableHead` assumes the kNN read,
    // so removing it makes the narrow reconstruction wrong by 4x as well.
    await assignProviders();
    const gallery = await seedPage({ title: 'Gallery' });
    const single = await seedPage({ title: 'Single' });
    for (let i = 0; i < 6; i++) {
      await seedImageVec(gallery, `g${i}.png`, [1, i * 0.01, 0, 0]);
    }
    // Comfortably behind all six, so the ORDER is not what this measures.
    await seedImageVec(single, 's.png', [1, 0.5, 0, 0]);

    const out = await searchImageLeg(USER, 'gallery', { limit: 2 });

    expect(out.pages.map((p) => p.pageId)).toEqual([gallery, single]);
    expect(out.pages[1]!.bestRawIndex).toBe(6);
  });

  it('caps the hits it carries per page at MAX_IMAGE_HITS_PER_PAGE', async () => {
    await assignProviders();
    const page = await seedPage({ title: 'Gallery' });
    for (let i = 0; i < 6; i++) {
      await query(
        `INSERT INTO page_image_embeddings (page_id, source, attachment_key, sha256, format, model, embedding)
         VALUES ($1, 'confluence', $2, 's', 'png', $4, $3)`,
        [page, `g${i}.png`, pgvector.toSql([1 - i * 0.05, i * 0.05, 0, 0]), VL_MODEL],
      );
    }

    const out = await searchImageLeg(USER, 'gallery', { limit: 10 });

    expect(out.pages).toHaveLength(1);
    expect(out.pages[0]!.hits).toHaveLength(3);
  });

  it('builds the attachment URL with the shared builder, per store and per page identity', async () => {
    await assignProviders();
    const confluencePage = await seedPage({ title: 'Conf', confluenceId: '99001' });
    const localPage = await seedPage({
      title: 'Local', pageSource: 'standalone', confluenceId: null,
    });
    await seedImage(confluencePage, 'Screen shot.png', 0);
    await seedImage(localPage, 'moved.png', 0, 'local');

    const out = await searchImageLeg(USER, 'x', { limit: 10 });
    const urls = new Map(out.pages.map((p) => [p.pageId, p.hits[0]!.attachmentUrl]));

    expect(urls.get(confluencePage)).toBe('/api/attachments/99001/Screen%20shot.png');
    expect(urls.get(localPage)).toBe(`/api/local-attachments/${localPage}/moved.png`);
  });

  it('follows the runtime column TIER — a halfvec column is searched, not cast to vector', async () => {
    // Mutation check: hardcode `$2::vector` in the kNN and this fails with
    // "operator does not exist: halfvec <=> vector". The parameter's type is
    // resolved FROM the column, which is how the leg follows
    // `ensureImageEmbeddingColumn`'s tiering with nothing to keep in step.
    await assignProviders();
    await query(`DROP INDEX IF EXISTS ${IMAGE_EMBEDDING_HNSW_INDEX}`);
    await query(`ALTER TABLE page_image_embeddings ALTER COLUMN embedding TYPE halfvec(${DIMS})`);
    await query(
      `CREATE INDEX ${IMAGE_EMBEDDING_HNSW_INDEX}
         ON page_image_embeddings USING hnsw (embedding halfvec_cosine_ops)`,
    );
    const page = await seedPage({ title: 'Halfvec' });
    await seedImage(page, 'h.png', 0);

    const out = await searchImageLeg(USER, 'x', { limit: 10 });

    expect(out.ran).toBe(true);
    expect(out.pages.map((p) => p.pageId)).toEqual([page]);
  });

  // ── Failure ─────────────────────────────────────────────────────────────

  describe('failure', () => {
    it('reports failed (not "off") when the VL endpoint answers 500', async () => {
      await assignProviders();
      const page = await seedPage({ title: 'Turbine' });
      await seedImage(page, 'turbine.png', 0);
      vlRespond = (res) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'model still loading' } }));
      };

      const out = await searchImageLeg(USER, 'turbine', { limit: 10 });

      expect(out).toEqual({ ran: false, failed: true, pages: [] });
    });

    it('reports failed when the endpoint answers 200 with no embedding', async () => {
      await assignProviders();
      const page = await seedPage({ title: 'Turbine' });
      await seedImage(page, 'turbine.png', 0);
      vlRespond = (res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [] }));
      };

      expect((await searchImageLeg(USER, 'turbine', { limit: 10 })).failed).toBe(true);
    });

    it('reports failed (not "off") when the non-empty PROBE itself cannot be answered', async () => {
      // Review r2. The gate's fourth condition is a DB read, and an
      // unanswerable read is not evidence of an empty index — the same
      // throw-vs-null distinction the resolver above it is built around. Left
      // outside the catch it also rejected, breaking the "never throws"
      // contract, and the caller's `.catch` then recorded a live outage as a
      // healthy search with the leg simply "off".
      await assignProviders();
      const page = await seedPage({ title: 'Turbine' });
      await seedImage(page, 'turbine.png', 0);
      failStatementsMatching(INDEX_PROBE_SQL);

      const out = await searchImageLeg(USER, 'turbine', { limit: 10 });

      expect(out).toEqual({ ran: false, failed: true, pages: [] });
      // The gate is still a gate: a probe that never answered buys no embed.
      expect(vlCalls()).toHaveLength(0);
    });

    it('records image_leg_unavailable when the probe fails, rather than nothing', async () => {
      await assignProviders();
      const page = await seedPage({ title: 'Written up', chunkAxis: 3 });
      await seedImage(page, 'p.png', 0);
      failStatementsMatching(INDEX_PROBE_SQL);

      const results = await hybridSearch(USER, 'zzzqqq', 5);

      // The text side is untouched, which is the whole point of a bypass.
      expect(results.map((r) => r.pageId)).toEqual([page]);
      expect((await lastAnalytics()).degraded_reason).toBe('image_leg_unavailable');
    });

    it('bounds the query embed at IMAGE_LEG_TIMEOUT_MS rather than the queue deadline', async () => {
      // Review r2. Deleting `timeoutMs` from the `embedTextsVl` call leaves
      // the whole suite green while removing the AbortSignal entirely — the
      // client builds a deadline only when the field is present — so the leg
      // falls back to the shared LLM queue's own 300s on a request that runs
      // in parallel with the text legs on EVERY question. This pins the
      // BOUND, not the number: the endpoint accepts the connection and never
      // answers, and the leg has to give up on its own.
      await assignProviders();
      const page = await seedPage({ title: 'Turbine' });
      await seedImage(page, 'turbine.png', 0);
      vlRespond = (res) => {
        heldResponses.push(res);
      };

      const started = Date.now();
      const out = await searchImageLeg(USER, 'turbine', { limit: 10 });
      const elapsed = Date.now() - started;

      expect(out).toEqual({ ran: false, failed: true, pages: [] });
      // Comfortably above the 3s budget and far below the queue's 300s, so
      // the assertion cannot pass on a lucky fast failure or on no bound.
      expect(elapsed).toBeLessThan(10_000);
    }, 20_000);

    it('bounds the kNN as well as the embed — a blocked scan bypasses instead of stalling', async () => {
      // Review r3. `IMAGE_LEG_TIMEOUT_MS` covers the query EMBED and nothing
      // else, so the kNN ran on the vector pool's session default of 0. That
      // is not a hypothetical tier: `ensureImageEmbeddingColumn` builds no
      // HNSW index above 4000 dimensions and this gate has no `indexed`
      // condition, so the leg really does run a sequential scan there — and
      // `hybridSearchInner` awaits it between the text legs and fusion, so an
      // optional leg with no budget stalls every answer on the instance.
      //
      // `LOCK TABLE pages` is the cheapest way to make the scan take forever
      // without touching the SQL: the kNN JOINs `pages`, and nothing earlier
      // in the leg reads it, so the gate still opens and the embed still
      // returns. Without `SET LOCAL statement_timeout` this never settles and
      // the race below reports `done: false`.
      await assignProviders();
      const page = await seedPage({ title: 'Turbine' });
      await seedImage(page, 'turbine.png', 0);

      const holder = await getPool().connect();
      try {
        await holder.query('BEGIN');
        await holder.query('LOCK TABLE pages IN ACCESS EXCLUSIVE MODE');

        const raced = await Promise.race([
          searchImageLeg(USER, 'turbine', { limit: 10 }).then((o) => ({ done: true as const, out: o })),
          new Promise<{ done: false }>((r) =>
            setTimeout(() => r({ done: false }), IMAGE_LEG_KNN_TIMEOUT_MS + 8_000),
          ),
        ]);

        expect(raced.done).toBe(true);
        // …and it is a BYPASS, the temperament every other failure here has:
        // recorded as a degradation, never thrown at the caller.
        expect(raced.done && raced.out).toEqual({ ran: false, failed: true, pages: [] });
      } finally {
        await holder.query('ROLLBACK').catch(() => {});
        holder.release();
      }
    }, 30_000);

    it('never logs the provider body', async () => {
      await assignProviders();
      const page = await seedPage({ title: 'Turbine' });
      await seedImage(page, 'turbine.png', 0);
      const secret = 'INTERNAL-HOST-vl-07.corp.example';
      vlRespond = (res) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: secret } }));
      };
      const { logger } = await import('../../../core/utils/logger.js');
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);

      await searchImageLeg(USER, 'turbine', { limit: 10 });

      expect(warn).toHaveBeenCalled();
      expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
    });
  });

  // ── Fusion, through hybridSearch ────────────────────────────────────────

  describe('fusion (through hybridSearch)', () => {
    it('makes an image-only page retrievable, with its chunk-0 text', async () => {
      // "Image-only" is a fact about this REQUEST, not about the page: the
      // vector leg returns its top `stageLimit` distinct pages whatever their
      // cosine, so a page falls out of it by being crowded out, which is what
      // eleven better-matching decoys reproduce here.
      await assignProviders();
      for (let i = 0; i < 11; i++) await seedPage({ title: `Decoy ${i}`, chunkAxis: 3 });
      const imageOnly = await seedPage({
        title: 'Diagram sheet', chunkAxis: 1, chunkText: 'a lede the text legs never matched',
        bodyText: 'zzz',
      });
      await seedImage(imageOnly, 'sheet.png', 0);

      const results = await hybridSearch(USER, 'zzzqqq', 5);

      const row = results.find((r) => r.pageId === imageOnly);
      expect(row).toBeDefined();
      expect(row!.chunkText).toBe('a lede the text legs never matched');
      expect(row!.imageOnly).toBe(true);
      expect(row!.imageTextSynthesized).toBeUndefined();
      // The chunk-0 fetch carries no anchor: `chunkIndex` is the VECTOR leg's
      // matched chunk and the sibling-assembly anchor, and nothing measured
      // this page's text.
      expect(row!.chunkIndex).toBeUndefined();
      expect(row!.imageHits).toEqual([
        expect.objectContaining({ source: 'confluence', key: 'sheet.png' }),
      ]);
      // …and it is not the ONLY thing that came back: the text leg's own head
      // still leads.
      expect(results.length).toBeGreaterThan(1);
      expect(results[0]!.imageOnly).toBeUndefined();
    });

    it('synthesises the TITLE when the page has no chunk 0 at all', async () => {
      await assignProviders();
      const imageOnly = await seedPage({ title: 'Untranscribed schematic', bodyText: 'zz' });
      await seedImage(imageOnly, 'sheet.png', 0);

      const results = await hybridSearch(USER, 'zzzqqq', 5);

      const row = results.find((r) => r.pageId === imageOnly)!;
      expect(row.chunkText).toBe('Untranscribed schematic');
      expect(row.imageOnly).toBe(true);
      expect(row.imageTextSynthesized).toBe(true);
    });

    it('carries each page\'s RAW image index from the leg onto the fused row', async () => {
      // Review r3. `fuseWithStableHead` reconstructs a narrower request's
      // image leg by filtering on `SearchResult.imageRawIndex`, and its
      // fallback is `r.imageRawIndex ?? i` — deliberately silent, so a row
      // that arrives WITHOUT the field reverts the whole mechanism to the
      // plain prefix it replaced and puts the #1103 head dilution (R@1 0.3889
      // → 0.2222) back with nothing red.
      //
      // The producer had a test (`bestRawIndex` on the leg's own output) and
      // the consumer had one (hand-built rows carrying `imageRawIndex`); the
      // HANDOFF between them had none, so deleting `imageRawIndex:
      // page.bestRawIndex` from `buildImageLegResults` left the suite green.
      // This asserts the leg's own number reaches the fused row.
      await assignProviders();
      const better = await seedPage({ title: 'Better', bodyText: 'zz' });
      const crowded = await seedPage({ title: 'Crowded', bodyText: 'zz' });
      await seedImage(better, 'b1.png', 0);
      await seedImageVec(crowded, 'c1.png', [0.9, 0.436, 0, 0]);
      await seedImageVec(crowded, 'c2.png', [0.85, 0.527, 0, 0]);

      // What the leg produced…
      const leg = await searchImageLeg(USER, 'zzzqqq', { limit: 5 });
      expect(leg.pages.map((p) => [p.pageId, p.bestRawIndex])).toEqual([
        [better, 0],
        [crowded, 1],
      ]);

      // …and what the consumer receives, for the same fixture.
      const results = await hybridSearch(USER, 'zzzqqq', 5);
      const byId = new Map(results.map((r) => [r.pageId, r]));
      expect(byId.get(better)!.imageRawIndex).toBe(0);
      expect(byId.get(crowded)!.imageRawIndex).toBe(1);
    });

    it('attaches hits to a page the text legs also found, keeping its measured row', async () => {
      await assignProviders();
      // The text query embeds to axis 3; give this page a chunk on axis 3 so
      // the vector leg finds it too.
      const both = await seedPage({ title: 'Both legs', chunkAxis: 3, chunkText: 'the vector chunk' });
      await seedImage(both, 'pic.png', 0);

      const results = await hybridSearch(USER, 'zzzqqq', 5);

      const row = results.find((r) => r.pageId === both)!;
      expect(row.vectorScore).not.toBeNull();
      expect(row.imageOnly).toBeUndefined();
      expect(row.chunkText).toBe('the vector chunk');
      expect(row.imageHits).toHaveLength(1);
    });

    it('carries the hits through the RERANK stage — the recommended production config', async () => {
      // The feature's whole wire output (`kind: 'image'` sources) hangs off
      // `SearchResult.imageHits`, and every post-fusion stage rebuilds rows:
      // rerank spreads into new objects, MMR and the ranking prior re-map,
      // sibling assembly and the pin stage re-spread. Rerank is the one that
      // runs on the RECOMMENDED configuration (#1104) and the one with a
      // hand-written object literal, so a `{ ...rest }` that forgot the field
      // would delete every image source from `/llm/ask` silently.
      //
      // Mutation check: destructure `imageHits` out of `scoredEntries` in
      // rag-service's rerank stage and this fails; nothing else in the suite
      // does, because no other case has BOTH an assigned reranker and a
      // non-empty image index.
      await assignProviders({ rerank: true });
      const textPage = await seedPage({
        title: 'Written up', chunkAxis: 3, chunkText: 'the vector chunk',
      });
      const imageOnly = await seedPage({ title: 'Untranscribed schematic', bodyText: 'zz' });
      await seedImage(imageOnly, 'sheet.png', 0);
      await seedImage(textPage, 'pic.png', 0);

      const results = await hybridSearch(USER, 'zzzqqq', 5, undefined, { rerank: true });

      // The reranked branch really ran (a bypass records plain `hybrid`).
      expect((await lastAnalytics()).search_type).toBe('hybrid_rerank');
      expect(results.every((r) => r.rerankScore != null)).toBe(true);
      const image = results.find((r) => r.pageId === imageOnly);
      expect(image).toBeDefined();
      expect(image!.imageHits).toEqual([
        expect.objectContaining({ source: 'confluence', key: 'sheet.png' }),
      ]);
      // The image-only markers survive too — P4 and the confidence exclusion
      // both read them after this stage.
      expect(image!.imageOnly).toBe(true);
      expect(image!.imageTextSynthesized).toBe(true);
      expect(results.find((r) => r.pageId === textPage)!.imageHits).toHaveLength(1);
    });

    it('records image_leg_unavailable when the leg fails and the text side is healthy', async () => {
      await assignProviders();
      const page = await seedPage({ title: 'Written up', chunkAxis: 3 });
      await seedImage(page, 'p.png', 0);
      vlRespond = (res) => {
        res.writeHead(500);
        res.end('{}');
      };

      const results = await hybridSearch(USER, 'zzzqqq', 5);

      expect(results.map((r) => r.pageId)).toEqual([page]);
      const row = await lastAnalytics();
      expect(row.degraded_reason).toBe('image_leg_unavailable');
      // The label says what HAPPENED on the text side, and nothing changed there.
      expect(row.search_type).toBe('hybrid');
    });

    it('records image_leg_unavailable when the LEDE fetch drops the image-only pages', async () => {
      // Review r2. The leg ran and the VL endpoint was fine; what failed is
      // the one batched query that turns its image-only pages into rows. Those
      // pages then vanish — the pages this leg exists to make retrievable —
      // while the pages the text legs also found keep their rank contribution
      // and their hits. It is a PARTIAL bypass, and by this leg's own
      // criterion (it changes which PAGES come back) it is recorded rather
      // than left to write a healthy row.
      await assignProviders();
      const textPage = await seedPage({ title: 'Written up', chunkAxis: 3 });
      const imageOnly = await seedPage({ title: 'Picture only', bodyText: 'zz' });
      await seedImage(imageOnly, 'p.png', 0);
      await seedImage(textPage, 'q.png', 0);
      failStatementsMatching(LEDE_FETCH_SQL);

      const results = await hybridSearch(USER, 'zzzqqq', 5);

      expect(results.map((r) => r.pageId)).toEqual([textPage]);
      // The half that survived really did survive — otherwise this would be
      // indistinguishable from the leg failing outright.
      expect(results[0]!.imageHits).toHaveLength(1);
      expect((await lastAnalytics()).degraded_reason).toBe('image_leg_unavailable');
    });

    it('lets a TEXT-side reason win: the column records the worse outage', async () => {
      // Nothing embedded at all → `no_embeddings`, even though the image leg
      // also fell over in the same request.
      await assignProviders();
      const page = await seedPage({ title: 'Unembedded' });
      await seedImage(page, 'p.png', 0);
      vlRespond = (res) => {
        res.writeHead(500);
        res.end('{}');
      };

      await hybridSearch(USER, 'unembedded', 5);

      expect((await lastAnalytics()).degraded_reason).toBe('no_embeddings');
    });

    it('costs exactly ONE VL call for a plain ask, and ONE for a DEEP-SEARCH ask', async () => {
      // Deep search retrieves three phrasings. The image leg must not follow
      // them: paraphrasing is a text technique, and this merge sums weighted
      // per-leg ranks, so the same image evidence in all three legs would
      // enter at 1 + 0.6 + 0.6 — as if three phrasings had independently
      // agreed on it.
      await assignProviders();
      const chatProv = await query<{ id: string }>(
        `INSERT INTO llm_providers (name, base_url, auth_type, verify_ssl, default_model)
         VALUES ('chat-box', $1, 'none', TRUE, 'chat-model') RETURNING id`,
        [baseUrl],
      );
      await query(
        `INSERT INTO llm_usecase_assignments (usecase, provider_id, model)
         VALUES ('chat', $1, 'chat-model')`,
        [chatProv.rows[0]!.id],
      );
      const page = await seedPage({ title: 'Turbine', chunkAxis: 3 });
      await seedImage(page, 'turbine.png', 0);

      await hybridSearch(USER, 'how do I service the turbine', 5);
      expect(vlCalls()).toHaveLength(1);

      calls = [];
      const { multiQuerySearch } = await import('./multi-query-search.js');
      const legs: string[] = [];
      await multiQuerySearch(USER, 'how do I service the turbine', 5, undefined, {
        onExpansion: (o) => { if (o.expanded) legs.push(...o.paraphrases); },
      });

      // The chat model really did expand (otherwise this would prove nothing
      // — a soft-failed expansion runs one leg and one VL call trivially).
      expect(legs).toHaveLength(2);
      expect(vlCalls()).toHaveLength(1);
    });

    it('a failed image leg returns exactly what leg-off returns', async () => {
      await assignProviders();
      const page = await seedPage({ title: 'Written up', chunkAxis: 3 });
      const imageOnly = await seedPage({ title: 'Picture only', bodyText: 'zz' });
      await seedImage(imageOnly, 'p.png', 0);

      const off = await hybridSearch(USER, 'zzzqqq', 5, undefined, { imageLeg: false });
      vlRespond = (res) => {
        res.writeHead(500);
        res.end('{}');
      };
      const failed = await hybridSearch(USER, 'zzzqqq', 5);

      expect(failed.map((r) => r.pageId)).toEqual(off.map((r) => r.pageId));
      expect(failed.map((r) => r.pageId)).toEqual([page]);
      expect(failed.every((r) => r.imageHits === undefined)).toBe(true);
    });
  });
});
