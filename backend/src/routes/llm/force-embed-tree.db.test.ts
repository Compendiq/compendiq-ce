import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../test-db-helper.js';
import { query } from '../../core/db/postgres.js';
import { encryptPat } from '../../core/utils/crypto.js';
import { embedPage } from '../../domains/llm/services/embedding-service.js';
import type * as EmbeddingService from '../../domains/llm/services/embedding-service.js';
import { insertUser } from '../knowledge/pages.test-helpers.js';
import { llmEmbeddingRoutes } from './llm-embeddings.js';

// The real embedPage runs (rows, statuses and provider input are real); the
// pass-through spy only records which local rows reached it.
vi.mock('../../domains/llm/services/embedding-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof EmbeddingService>();
  return { ...actual, embedPage: vi.fn(actual.embedPage) };
});

const dbAvailable = await isDbAvailable();

/** The upstream tree: the root, then its children in listing order. */
const UPSTREAM = [
  { id: 'conf-root', title: 'Root', storage: '<p>REMOTE root storage, which local wins over.</p>' },
  { id: 'conf-empty', title: 'Empty upstream', storage: '' },
  { id: 'conf-trashed', title: 'Trashed', storage: '<p>REMOTE trashed storage.</p>' },
  { id: 'conf-moved', title: 'Moved to local', storage: '<p>REMOTE moved storage.</p>' },
  { id: 'conf-missing', title: 'Never synced', storage: '<p>REMOTE missing storage.</p>' },
];

/** `METHOD /path` of every Confluence request, in order. */
const confluenceCalls: string[] = [];
/** Every text the synthetic embedding provider received. */
const embeddingInputs: string[] = [];

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

function remotePage(page: (typeof UPSTREAM)[number]) {
  return {
    id: page.id,
    type: 'page',
    status: 'current',
    title: page.title,
    version: { number: 1, when: '2026-09-01T00:00:00.000Z' },
    ancestors: [],
    body: { storage: { value: page.storage, representation: 'storage' } },
  };
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://fixture.test');
  if (request.method === 'POST' && url.pathname === '/v1/embeddings') {
    let raw = '';
    for await (const chunk of request) raw += String(chunk);
    const { input } = JSON.parse(raw) as { input: string[] };
    embeddingInputs.push(...input);
    json(response, 200, {
      object: 'list',
      model: 'synthetic',
      usage: { prompt_tokens: 1, total_tokens: 1 },
      data: input.map((_, index) => ({
        object: 'embedding',
        index,
        embedding: Array.from({ length: 1024 }, (_, dimension) => (dimension === 0 ? 1 : 0)),
      })),
    });
    return;
  }
  confluenceCalls.push(`${request.method} ${url.pathname}`);
  const listing = url.pathname.match(/^\/rest\/api\/content\/([^/]+)\/child\/page$/);
  if (listing) {
    const children = decodeURIComponent(listing[1]!) === 'conf-root' ? UPSTREAM.slice(1).map(remotePage) : [];
    json(response, 200, { results: children, start: 0, limit: 50, size: children.length, _links: {} });
    return;
  }
  const single = url.pathname.match(/^\/rest\/api\/content\/([^/]+)$/);
  const page = single && UPSTREAM.find((candidate) => candidate.id === decodeURIComponent(single[1]!));
  if (page) {
    json(response, 200, remotePage(page));
    return;
  }
  json(response, 404, { message: `Unhandled fixture path ${url.pathname}` });
}

const upstream = createServer((request, response) => {
  void handle(request, response).catch((err: unknown) => {
    if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ message: err instanceof Error ? err.message : String(err) }));
  });
});

/** A Confluence-sourced row whose local copy differs from the remote storage. */
async function confluenceRow(confluenceId: string, title: string, deletedAt: Date | null = null): Promise<number> {
  const text = `LOCAL ${title} copy, long enough to embed.`;
  const result = await query<{ id: number }>(
    `INSERT INTO pages (source, confluence_id, space_key, title, body_storage, body_html, body_text, version,
                        embedding_dirty, embedding_status, deleted_at)
     VALUES ('confluence', $1, 'DEV', $2, '', $3, $4, 1, TRUE, 'not_embedded', $5)
     RETURNING id`,
    [confluenceId, title, `<p>${text}</p>`, text, deletedAt],
  );
  return result.rows[0]!.id;
}

describe.skipIf(!dbAvailable)('POST /api/embeddings/force-embed-tree on real pages rows (#1717)', () => {
  let app: FastifyInstance;
  let ids: { root: number; empty: number; trashed: number; moved: number };
  let events: Array<Record<string, unknown>>;
  // The one route run's embedPage calls, captured right after it: the tests only
  // read them, whatever the runner does to mock history between tests.
  let embeddedIds: unknown[];

  beforeAll(async () => {
    // One route run feeds every test below, so the recorders start empty here
    // (not in beforeEach, which would wipe them before the assertions).
    confluenceCalls.length = 0;
    embeddingInputs.length = 0;
    await setupTestDb();
    await truncateAllTables();
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const baseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

    const userId = await insertUser('force-embed-tree');
    await query(
      `INSERT INTO user_settings (user_id, confluence_url, confluence_pat, confluence_enabled)
       VALUES ($1, $2, $3, TRUE)`,
      [userId, baseUrl, encryptPat('fixture-pat')],
    );
    const provider = await query<{ id: string }>(
      `INSERT INTO llm_providers (name, base_url, auth_type, verify_ssl, is_default, default_model)
       VALUES ('force-embed-tree', $1, 'none', TRUE, TRUE, 'synthetic') RETURNING id`,
      [`${baseUrl}/v1`],
    );
    await query(
      `INSERT INTO llm_usecase_assignments (usecase, provider_id, model) VALUES ('embedding', $1, 'synthetic')
       ON CONFLICT (usecase) DO UPDATE SET provider_id = EXCLUDED.provider_id, model = EXCLUDED.model`,
      [provider.rows[0]!.id],
    );

    ids = {
      root: await confluenceRow('conf-root', 'Local root'),
      empty: await confluenceRow('conf-empty', 'Local child'),
      trashed: await confluenceRow('conf-trashed', 'Local trashed child', new Date()),
      // A standalone article that keeps the Confluence id it was created from.
      moved: (await query<{ id: number }>(
        `INSERT INTO pages (source, confluence_id, title, body_html, body_text, version, visibility,
                            created_by_user_id, owner_id, embedding_dirty, embedding_status)
         VALUES ('standalone', 'conf-moved', 'Local moved article', $1, $2, 1, 'private', $3, $3, TRUE, 'not_embedded')
         RETURNING id`,
        ['<p>LOCAL moved article, long enough to embed.</p>', 'LOCAL moved article, long enough to embed.', userId],
      )).rows[0]!.id,
    };

    app = Fastify({ logger: false });
    await app.register(sensible);
    app.decorate('authenticate', async () => {});
    app.decorate('requireAdmin', async () => {});
    app.decorateRequest('userId', '');
    app.addHook('onRequest', async (request) => {
      request.userId = userId;
    });
    await app.register(llmEmbeddingRoutes, { prefix: '/api' });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/api/embeddings/force-embed-tree',
      payload: { pageId: 'conf-root' },
    });
    expect(response.statusCode).toBe(200);
    embeddedIds = vi.mocked(embedPage).mock.calls.map((call) => call[1]);
    events = response.body.split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)));
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    if (upstream.listening) {
      upstream.close();
      await once(upstream, 'close');
    }
    await teardownTestDb();
  });

  it('passes only live Confluence rows to embedPage: not the trashed row, not the standalone row with that historical confluence_id', () => {
    expect(embeddedIds).toEqual([ids.root, ids.empty]);
  });

  it('emits one event per discovered page: the trash warning for the trashed row, "not yet synced" for the standalone and missing ids', () => {
    const perPage = events
      .filter((event) => event.phase === 'embedding' && 'currentPage' in event)
      .map(({ currentPage, completed, warning }) => ({ currentPage, completed, warning }));
    expect(perPage).toEqual([
      { currentPage: 'Root', completed: 1, warning: undefined },
      { currentPage: 'Empty upstream', completed: 2, warning: undefined },
      { currentPage: 'Trashed', completed: 3, warning: 'Page is in the trash, skipping' },
      { currentPage: 'Moved to local', completed: 4, warning: 'Page not yet synced to local DB, skipping' },
      { currentPage: 'Never synced', completed: 5, warning: 'Page not yet synced to local DB, skipping' },
    ]);
    expect(events.at(-1)).toEqual({ phase: 'complete', total: 5, completed: 5, errors: 0, done: true });
  });

  it('embeds the live rows from their local copy and leaves the trashed and standalone rows untouched', async () => {
    const state = await query<{ id: number; embedding_status: string; embedded_at: Date | null; chunks: number }>(
      `SELECT p.id, p.embedding_status, p.embedded_at, count(e.id)::int AS chunks
         FROM pages p LEFT JOIN page_embeddings e ON e.page_id = p.id
        GROUP BY p.id
        ORDER BY p.id`,
    );
    expect(state.rows.map((row) => ({
      id: row.id,
      status: row.embedding_status,
      embeddedAt: row.embedded_at !== null,
      chunks: row.chunks > 0,
    }))).toEqual([
      { id: ids.root, status: 'embedded', embeddedAt: true, chunks: true },
      { id: ids.empty, status: 'embedded', embeddedAt: true, chunks: true },
      { id: ids.trashed, status: 'not_embedded', embeddedAt: false, chunks: false },
      { id: ids.moved, status: 'not_embedded', embeddedAt: false, chunks: false },
    ]);
    const sent = embeddingInputs.join('\n');
    expect(sent).toContain('LOCAL Local root copy');
    expect(sent).toContain('LOCAL Local child copy');
    expect(sent).not.toContain('REMOTE');
  });

  it('calls Confluence for discovery only: the root page and the child listings', () => {
    expect(confluenceCalls.filter((call) => !call.endsWith('/child/page'))).toEqual(['GET /rest/api/content/conf-root']);
  });
});
