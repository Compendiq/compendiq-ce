/**
 * The shared `/llm/ask` answer cache must never widen the current caller's
 * authorized grounding.
 *
 * The route assembles the page tree behind `pageId` per caller, after that
 * caller's own page gate. Authorized A warms the cache; denied B then sends
 * the IDENTICAL body, retrieves the identical (empty) doc-id set and carries
 * a valid secondary grounding input (`referenceText`) so the refusal gate
 * does not mask the cache. B must get no cache hit, no secret and nothing
 * secret persisted to their conversation.
 *
 * Full app: real auth (JWT), RBAC, PostgreSQL, Redis, retrieval, cache and
 * conversation persistence. Only the external OpenAI-compatible provider is
 * replaced, by a local HTTP endpoint whose streamed answer echoes a secret
 * marker only when the messages it was sent contain one.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { query } from '../../core/db/postgres.js';
import { generateAccessToken } from '../../core/plugins/auth.js';
import { upsertRateLimits } from '../../core/services/rate-limit-service.js';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';

const available = await isDbAvailable() && await isRedisAvailable();

const MODEL = 'ask-cache-stub-model';
const SECRET = 'SECRET6D31';
const PUBLIC_ONLY = 'PUBLIC_ONLY';
// No lexical overlap with any page below, so every caller retrieves the same
// empty doc-id set: the cache key's retrieval component cannot tell A from B.
const QUESTION = 'What information can you provide about zxqv914?';
const REFERENCE = 'Public reference material supplied by both users.';

interface User { id: string; token: string }
type SseEvent = Record<string, unknown>;

interface AskResult {
  body: string;
  /** Every streamed `content` chunk, concatenated. */
  content: string;
  /** Whether any frame carried `cached: true`. */
  cached: boolean;
  refused: boolean;
  sources: unknown;
}

const stub = { streamCalls: 0 };
let server: Server;
let baseUrl: string;
let app: FastifyInstance;

function sseEvents(body: string): SseEvent[] {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)) as SseEvent);
}

async function createUser(name: string): Promise<User> {
  const result = await query<{ id: string }>(
    `INSERT INTO users (username, email, password_hash, role) VALUES ($1, $2, 'x', 'user') RETURNING id`,
    [name, `${name}@test`],
  );
  const id = result.rows[0]!.id;
  await query('INSERT INTO user_settings (user_id) VALUES ($1)', [id]);
  return { id, token: await generateAccessToken({ sub: id, username: name, role: 'user' }) };
}

/** A space role carrying `llm:query` — the route's global permission. */
async function grantAsker(userId: string, spaceKey: string): Promise<void> {
  const role = await query<{ id: number }>(
    `INSERT INTO roles (name, display_name, permissions)
     VALUES ($1, 'Asker', ARRAY['read', 'llm:query']) RETURNING id`,
    [`asker-${userId}-${spaceKey}`],
  );
  await query(
    `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
     VALUES ($1, 'user', $2, $3)`,
    [spaceKey, userId, role.rows[0]!.id],
  );
}

async function insertSpace(spaceKey: string, source: 'local' | 'confluence', createdBy?: string): Promise<void> {
  await query(
    `INSERT INTO spaces (space_key, space_name, source, created_by, last_synced)
     VALUES ($1, $1, $2, $3, NOW())`,
    [spaceKey, source, createdBy ?? null],
  );
}

async function insertConfluencePage(
  confluenceId: string,
  title: string,
  body: string,
  opts: { parentId?: string; inheritPerms?: boolean } = {},
): Promise<number> {
  const result = await query<{ id: number }>(
    `INSERT INTO pages (confluence_id, source, space_key, title, body_text, body_storage,
                        body_html, inherit_perms, embedding_dirty, parent_id)
     VALUES ($1, 'confluence', 'DOCS', $2, $3, '', $4, $5, FALSE, $6)
     RETURNING id`,
    [confluenceId, title, body, `<p>${body}</p>`, opts.inheritPerms ?? true, opts.parentId ?? null],
  );
  return result.rows[0]!.id;
}

async function insertUserAce(pageId: number, userId: string): Promise<void> {
  await query(
    `INSERT INTO access_control_entries (resource_type, resource_id, principal_type, principal_id, permission)
     VALUES ('page', $1, 'user', $2, 'read')`,
    [pageId, userId],
  );
}

async function ask(user: User, payload: Record<string, unknown>): Promise<AskResult> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/llm/ask',
    headers: { authorization: `Bearer ${user.token}` },
    payload,
  });
  expect(response.statusCode, response.body).toBe(200);
  const events = sseEvents(response.body);
  const final = events.find((event) => event.final === true);
  return {
    body: response.body,
    content: events.map((event) => (typeof event.content === 'string' ? event.content : '')).join(''),
    cached: events.some((event) => event.cached === true),
    refused: final?.refused === true,
    sources: final?.sources,
  };
}

async function persistedMessages(userId: string): Promise<string> {
  const rows = await query<{ messages: string }>(
    'SELECT messages::text AS messages FROM llm_conversations WHERE user_id = $1',
    [userId],
  );
  return rows.rows.map((row) => row.messages).join('\n');
}

async function flushAnswerCache(): Promise<void> {
  for (const pattern of ['kb:llm:*', 'llm:lock:*']) {
    let cursor = '0';
    do {
      const scanned = await app.redis.scan(cursor, { MATCH: pattern, COUNT: 200 });
      cursor = String(scanned.cursor);
      if (scanned.keys.length > 0) await app.redis.del(scanned.keys);
    } while (cursor !== '0');
  }
}

/**
 * A warms the cache on `body`; B sends the identical body. Returns both
 * answers so each case can add its own assertions.
 */
async function warmThenReplay(
  a: User,
  b: User,
  body: Record<string, unknown>,
): Promise<{ warmed: AskResult; replay: AskResult }> {
  const warmed = await ask(a, body);
  expect(warmed.refused).toBe(false);
  expect(warmed.cached).toBe(false);
  expect(warmed.content).toBe(SECRET);
  expect(stub.streamCalls).toBe(1);

  const replay = await ask(b, body);
  // Identical retrieval for both callers: the doc-id component matched.
  expect(replay.sources).toEqual(warmed.sources);
  expect(replay.refused).toBe(false);
  return { warmed, replay };
}

async function expectNoLeakTo(b: User, replay: AskResult): Promise<void> {
  expect(replay.cached).toBe(false);
  expect(replay.body).not.toContain(SECRET);
  expect(replay.content).toBe(PUBLIC_ONLY);
  // B's answer was generated from B's own prompt.
  expect(stub.streamCalls).toBe(2);
  const stored = await persistedMessages(b.id);
  expect(stored).toContain(PUBLIC_ONLY);
  expect(stored).not.toContain(SECRET);
}

describe.skipIf(!available)('POST /api/llm/ask — the answer cache never widens authorized grounding', () => {
  beforeAll(async () => {
    await setupTestDb();
    server = createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8'); });
      request.on('end', () => {
        const body = JSON.parse(raw || '{}') as { input?: string[]; stream?: boolean; messages?: unknown };
        if (request.method === 'POST' && request.url === '/v1/embeddings') {
          const vector = new Array(1024).fill(0.01);
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ data: (body.input ?? []).map(() => ({ embedding: vector })) }));
          return;
        }
        if (request.method === 'POST' && request.url === '/v1/chat/completions') {
          if (body.stream) {
            stub.streamCalls++;
            const content = JSON.stringify(body.messages).includes(SECRET) ? SECRET : PUBLIC_ONLY;
            response.writeHead(200, { 'content-type': 'text/event-stream' });
            response.end(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`);
            return;
          }
          // Conversation auto-title (fire-and-forget, non-streaming).
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ choices: [{ message: { content: 'Generic title' }, finish_reason: 'stop' }] }));
          return;
        }
        response.writeHead(404);
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    app = await buildApp();
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    await flushAnswerCache();
    await app.close();
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
    await truncateAllTables();
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    await flushAnswerCache();
    stub.streamCalls = 0;
    // Default provider → `chat` and `embedding` both inherit it.
    await query(
      `INSERT INTO llm_providers (name, base_url, auth_type, verify_ssl, is_default, default_model)
       VALUES ('ask-cache-stub', $1, 'none', TRUE, TRUE, $2)`,
      [baseUrl, MODEL],
    );
    // The file asks more often than the default per-minute LLM stream cap.
    await upsertRateLimits({ llmStream: 1000 });
  });

  it('does not replay an answer built from a private standalone page to a caller denied that page', async () => {
    const a = await createUser('ask-cache-owner');
    const b = await createUser('ask-cache-other');
    await insertSpace('PRIV', 'local', a.id);
    await insertSpace('OTHER', 'local', b.id);
    await grantAsker(a.id, 'PRIV');
    await grantAsker(b.id, 'OTHER');
    const privatePage = await query<{ id: number }>(
      `INSERT INTO pages (source, space_key, title, body_text, body_html, visibility,
                          created_by_user_id, embedding_dirty)
       VALUES ('standalone', 'PRIV', 'Owner plan', $1, $2, 'private', $3, FALSE)
       RETURNING id`,
      [`Owner plan ${SECRET}`, `<p>Owner plan ${SECRET}</p>`, a.id],
    );
    const body = {
      question: QUESTION,
      pageId: String(privatePage.rows[0]!.id),
      includeSubPages: true,
      referenceText: REFERENCE,
    };

    const { replay } = await warmThenReplay(a, b, body);
    await expectNoLeakTo(b, replay);
  });

  it('does not replay an answer built from a restricted Confluence page to a space reader without an ACE', async () => {
    const a = await createUser('ask-cache-ace-holder');
    const b = await createUser('ask-cache-space-reader');
    const c = await createUser('ask-cache-second-ace-holder');
    await insertSpace('DOCS', 'confluence');
    for (const user of [a, b, c]) await grantAsker(user.id, 'DOCS');
    const restricted = await insertConfluencePage('c-restricted', 'Restricted plan', `Restricted plan ${SECRET}`, {
      inheritPerms: false,
    });
    await insertUserAce(restricted, a.id);
    await insertUserAce(restricted, c.id);
    const body = { question: QUESTION, pageId: String(restricted), includeSubPages: true, referenceText: REFERENCE };

    const { replay } = await warmThenReplay(a, b, body);
    await expectNoLeakTo(b, replay);

    // A second caller holding the same ACE assembles the same prompt and
    // shares A's entry: equivalent authorized context still caches.
    const shared = await ask(c, body);
    expect(shared.cached).toBe(true);
    expect(shared.content).toBe(SECRET);
    expect(stub.streamCalls).toBe(2);
  });

  it('does not replay an answer whose tree held a restricted sub-page to a caller whose tree is narrower', async () => {
    const a = await createUser('ask-cache-tree-ace');
    const b = await createUser('ask-cache-tree-reader');
    await insertSpace('DOCS', 'confluence');
    await grantAsker(a.id, 'DOCS');
    await grantAsker(b.id, 'DOCS');
    // B reads the parent, so B's own tree assembles too — just without the
    // restricted child. Both requests pass the refusal gate on the tree.
    const parent = await insertConfluencePage('c-open-parent', 'Open parent', 'Open parent overview');
    const child = await insertConfluencePage('c-hushed-child', 'Hushed child', `Hushed child ${SECRET}`, {
      parentId: 'c-open-parent',
      inheritPerms: false,
    });
    await insertUserAce(child, a.id);
    const body = { question: QUESTION, pageId: String(parent), includeSubPages: true, referenceText: REFERENCE };

    const { replay } = await warmThenReplay(a, b, body);
    await expectNoLeakTo(b, replay);
  });

  it('does not cache a follow-up answer grounded in the asker\'s own conversation history', async () => {
    const a = await createUser('ask-cache-thread-owner');
    const b = await createUser('ask-cache-thread-other');
    await insertSpace('PRIV', 'local', a.id);
    await insertSpace('OTHER', 'local', b.id);
    await grantAsker(a.id, 'PRIV');
    await grantAsker(b.id, 'OTHER');
    const privatePage = await query<{ id: number }>(
      `INSERT INTO pages (source, space_key, title, body_text, body_html, visibility,
                          created_by_user_id, embedding_dirty)
       VALUES ('standalone', 'PRIV', 'Owner plan', $1, $2, 'private', $3, FALSE)
       RETURNING id`,
      [`Owner plan ${SECRET}`, `<p>Owner plan ${SECRET}</p>`, a.id],
    );
    const first = await ask(a, {
      question: QUESTION,
      pageId: String(privatePage.rows[0]!.id),
      includeSubPages: true,
      referenceText: REFERENCE,
    });
    expect(first.content).toBe(SECRET);
    const conversation = await query<{ id: string }>(
      'SELECT id FROM llm_conversations WHERE user_id = $1',
      [a.id],
    );

    // The follow-up carries no page: only A's own earlier turn holds the secret.
    const followUp = { question: 'Summarize zxqv914 again.', referenceText: REFERENCE };
    const answer = await ask(a, { ...followUp, conversationId: conversation.rows[0]!.id });
    expect(answer.content).toBe(SECRET);
    expect(stub.streamCalls).toBe(2);

    const replay = await ask(b, followUp);
    expect(replay.cached).toBe(false);
    expect(replay.body).not.toContain(SECRET);
    expect(replay.content).toBe(PUBLIC_ONLY);
    expect(await persistedMessages(b.id)).not.toContain(SECRET);
  });

  it('still serves an ordinary authorized repeat from the cache', async () => {
    const a = await createUser('ask-cache-repeat');
    await insertSpace('PRIV', 'local', a.id);
    await grantAsker(a.id, 'PRIV');
    const privatePage = await query<{ id: number }>(
      `INSERT INTO pages (source, space_key, title, body_text, body_html, visibility,
                          created_by_user_id, embedding_dirty)
       VALUES ('standalone', 'PRIV', 'Owner plan', $1, $2, 'private', $3, FALSE)
       RETURNING id`,
      [`Owner plan ${SECRET}`, `<p>Owner plan ${SECRET}</p>`, a.id],
    );
    const body = {
      question: QUESTION,
      pageId: String(privatePage.rows[0]!.id),
      includeSubPages: true,
      referenceText: REFERENCE,
    };

    const first = await ask(a, body);
    expect(first.cached).toBe(false);
    const repeat = await ask(a, body);
    expect(repeat.cached).toBe(true);
    expect(repeat.content).toBe(SECRET);
    expect(stub.streamCalls).toBe(1);

    // An edit to the page changes what the tree assembles, so the next ask
    // is answered from the current content rather than the cached answer.
    await query(
      `UPDATE pages SET body_html = '<p>Owner plan revised</p>', body_text = 'Owner plan revised' WHERE id = $1`,
      [privatePage.rows[0]!.id],
    );
    const afterEdit = await ask(a, body);
    expect(afterEdit.cached).toBe(false);
    expect(afterEdit.content).toBe(PUBLIC_ONLY);
    expect(stub.streamCalls).toBe(2);
  });
});
