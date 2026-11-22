/**
 * #1965 D1 — the body_text backfill is an ordinary protected write for the
 * embedding pipeline. An embedding in flight when its page is repaired is
 * refused by the existing fences (row version and the deleted operation row)
 * and redone by the normal dirty cycle; a force-embed of a clean page has to
 * be run again by the operator; a concurrent body_html edit is rejected as
 * before. No embedding code changes: real PostgreSQL, a real loopback
 * provider paused mid-request, the real job.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import { armBodyTextBackfill, runBodyTextBackfill } from '../../../core/services/body-text-backfill.js';
import { captureEmbeddingArticle, claimEmbeddingArticle } from './embedding-article-stage.js';
import { embedPage } from './embedding-service.js';

const dbAvailable = await isDbAvailable();

const TITLE = 'Release notes';
const HTML = '<p>Use &amp;lt;br&amp;gt; for a line break in the release notes of every service.</p>';
const OLD_TEXT = 'Use <br> for a line break in the release notes of every service.';
const FIXED_TEXT = 'Use &lt;br&gt; for a line break in the release notes of every service.';

function vector(): number[] {
  return Array.from({ length: 1024 }, (_, index) => Math.sin(index + 1) * 0.01);
}

/** A loopback embeddings provider whose next request can be held open. */
class Provider {
  server!: Server;
  private hold: { reached: () => void; release: Promise<void> } | null = null;

  async start(): Promise<string> {
    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = '';
      req.on('data', (part) => { raw += String(part); });
      req.on('end', () => {
        void (async () => {
          const hold = this.hold;
          this.hold = null;
          if (hold) {
            hold.reached();
            await hold.release;
          }
          const body: unknown = JSON.parse(raw);
          const input = body && typeof body === 'object' && 'input' in body ? body.input : [];
          const count = Array.isArray(input) ? input.length : 1;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            object: 'list', model: 'synthetic', usage: { prompt_tokens: 1, total_tokens: 1 },
            data: Array.from({ length: count }, (_, index) => ({ object: 'embedding', index, embedding: vector() })),
          }));
        })();
      });
    });
    this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('No loopback address');
    return `http://127.0.0.1:${address.port}/v1`;
  }

  /** The next request waits at the provider until `release()`. */
  holdNext(): { reached: Promise<void>; release: () => void } {
    let reached!: () => void;
    let release!: () => void;
    const reachedPromise = new Promise<void>((resolve) => { reached = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    this.hold = { reached, release: releasePromise };
    return { reached: reachedPromise, release };
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    this.server.close();
    await once(this.server, 'close');
  }
}

async function seedPage(dirty: boolean): Promise<number> {
  const result = await query<{ id: number }>(
    `INSERT INTO pages (title, source, space_key, visibility, body_html, body_text, embedding_dirty, embedding_status)
     VALUES ($1, 'standalone', 'DEV', 'shared', $2, $3, $4, $5) RETURNING id`,
    [TITLE, HTML, OLD_TEXT, dirty, dirty ? 'not_embedded' : 'embedded'],
  );
  return result.rows[0]!.id;
}

async function pageState(pageId: number) {
  const page = (await query<{ body_text: string; embedding_dirty: boolean; content_revision: string }>(
    'SELECT body_text, embedding_dirty, content_revision::text FROM pages WHERE id = $1', [pageId],
  )).rows[0]!;
  const chunks = Number((await query<{ n: string }>(
    'SELECT count(*)::text AS n FROM page_embeddings WHERE page_id = $1', [pageId],
  )).rows[0]!.n);
  const operation = (await query('SELECT 1 FROM embedding_ai_operations WHERE page_id = $1', [pageId])).rows.length;
  return { ...page, chunks, operation };
}

/** One dirty-worker step: capture the selected row, claim it, embed it. */
async function dirtyCycle(pageId: number): Promise<number> {
  const article = await claimEmbeddingArticle(await captureEmbeddingArticle(pageId, TITLE, 'DEV', HTML));
  if (!article) return -1;
  return embedPage('worker', pageId, TITLE, 'DEV', HTML, { article });
}

describe.skipIf(!dbAvailable)('D1: embeddings in flight across a body_text backfill write (#1965)', () => {
  const provider = new Provider();

  beforeAll(async () => {
    await setupTestDb();
  }, 30_000);

  beforeEach(async () => {
    armBodyTextBackfill();
    await truncateAllTables();
    const baseUrl = await provider.start();
    await query(
      `INSERT INTO llm_providers (name, base_url, auth_type, default_model, is_default)
       VALUES ('synthetic-1965', $1, 'none', 'synthetic', TRUE)`,
      [baseUrl],
    );
  });

  afterEach(async () => {
    await provider.stop();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  it('D1/AC5: a claimed dirty page paused at the provider is repaired; its operation row is deleted, its publication refused, and the next dirty cycle embeds it', async () => {
    const pageId = await seedPage(true);
    const held = provider.holdNext();
    const inFlight = dirtyCycle(pageId);
    await held.reached;
    expect((await pageState(pageId)).operation).toBe(1);

    const summary = await runBodyTextBackfill();
    expect(summary.counts.repaired).toBe(1);
    const repaired = await pageState(pageId);
    expect(repaired).toMatchObject({ body_text: FIXED_TEXT, operation: 0, embedding_dirty: true });

    held.release();
    expect(await inFlight).toBe(0);
    expect(await pageState(pageId)).toMatchObject({ chunks: 0, embedding_dirty: true });

    expect(await dirtyCycle(pageId)).toBeGreaterThan(0);
    expect(await pageState(pageId)).toMatchObject({ embedding_dirty: false, body_text: FIXED_TEXT });
    expect((await pageState(pageId)).chunks).toBeGreaterThan(0);
  }, 60_000);

  it('D1: an explicit embed of a clean page in flight is refused and the page is left clean (the operator re-runs it)', async () => {
    const pageId = await seedPage(false);
    const held = provider.holdNext();
    const inFlight = embedPage('operator', pageId, TITLE, 'DEV', HTML);
    await held.reached;
    await runBodyTextBackfill();
    held.release();
    expect(await inFlight).toBe(0);
    expect(await pageState(pageId)).toMatchObject({ chunks: 0, embedding_dirty: false, body_text: FIXED_TEXT });
    // The job never marks a page dirty: the normal cycle would not select it.
    const claimed = await claimEmbeddingArticle(await captureEmbeddingArticle(pageId, TITLE, 'DEV', HTML));
    expect(claimed).toBeNull();
  }, 60_000);

  it('a concurrent body_html edit is still rejected', async () => {
    const pageId = await seedPage(true);
    const held = provider.holdNext();
    const inFlight = dirtyCycle(pageId);
    await held.reached;
    await query(`UPDATE pages SET body_html = '<p>edited</p>', body_text = 'edited' WHERE id = $1`, [pageId]);
    held.release();
    expect(await inFlight).toBe(0);
    expect(await pageState(pageId)).toMatchObject({ chunks: 0, embedding_dirty: true, body_text: 'edited' });
  }, 60_000);
});
