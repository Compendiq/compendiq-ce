/**
 * #1728: a provider `error` frame inside a 200 stream fails `POST /api/llm/ask`,
 * also when the provider follows it with `data: [DONE]`.
 *
 * Full app over a real socket: real auth (JWT), PostgreSQL, Redis, retrieval,
 * cache, conversation persistence and stream-slot accounting. Only the
 * OpenAI-compatible provider is synthetic, a loopback server. Its embeddings
 * endpoint answers 400 throughout, the semantic-index outage of the issue's
 * repro (a 400 does not count against the provider breaker), so an ask
 * without other grounding is refused with `semantic_index_unavailable`.
 *
 * Answering asks carry `referenceText` and `inputKind: 'independent'`, so the
 * identity contract is satisfied and the refusal gate stands down; the
 * ungrounded asks carry only `inputKind: 'independent'`.
 */
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { query } from '../../core/db/postgres.js';
import { generateAccessToken } from '../../core/plugins/auth.js';
import { isDbAvailable, setupTestDb, teardownTestDb, waitForDatabaseCondition } from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';

const available = await isDbAvailable() && await isRedisAvailable();

const MODEL = 'ask-provider-error-model';
const USECASES = ['chat', 'embedding'] as const;
const REFERENCE = 'Rotating a personal access token: revoke the old token, then issue a new one.';
const ANSWER = 'Revoke the old token first.';
const PROVIDER_TEXT = 'upstream worker crashed: CUDA out of memory on gpu-7';
/** `ProviderStreamError.message`: what Ask records as the audit `errorMessage`. */
const AUDIT_ERROR = 'streamChat: provider reported an error in the stream';
/**
 * Only for the negative assertions (no title completion, no late audit or
 * conversation write): how long a side effect that is not going to happen
 * is given to show up after the request has finished. Never a pass condition.
 */
const SETTLE_MS = 500;

const frame = (body: unknown) => `data: ${JSON.stringify(body)}\n\n`;
const content = (text: string) => frame({ choices: [{ delta: { content: text } }] });
const DONE = 'data: [DONE]\n\n';
const ERROR_FRAME = frame({ error: { message: PROVIDER_TEXT, type: 'server_error' } });

/** Both variants end with `[DONE]`: EOF without it is `StreamIncompleteError`'s case. */
const VARIANTS = [
  { label: 'as the first frame', body: ERROR_FRAME + DONE, prefix: '' },
  { label: 'after content', body: content('Hel') + ERROR_FRAME + DONE, prefix: 'Hel' },
] as const;

interface Snapshot {
  conversations: string;
  audit: Array<{ status: string; error_message: string | null }>;
  cacheKeys: string[];
  streamRequests: number;
  titleRequests: number;
}

interface AskResult {
  status: number;
  contentType: string | null;
  text: string;
  events: Array<Record<string, unknown>>;
}

describe.skipIf(!available)('POST /api/llm/ask — provider error frames (#1728)', () => {
  let app: FastifyInstance;
  let provider: Server;
  let appPort: number;
  let userId: string;
  let token: string;
  let providerId: string;
  const priorAssignments = new Map<string, { provider_id: string | null; model: string | null } | undefined>();
  /** The body of the next streaming completion; a completed answer by default. */
  let streamBody: string = content(ANSWER) + DONE;
  let streamRequests = 0;
  let titleRequests = 0;
  let initialCacheKeys: string[] = [];

  beforeAll(async () => {
    await setupTestDb();
    provider = createServer((request, response) => {
      let raw = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => { raw += chunk; });
      request.on('end', () => {
        const body = JSON.parse(raw || '{}') as { stream?: boolean };
        if (request.url === '/v1/embeddings') {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: { message: 'embedding model not loaded' } }));
          return;
        }
        if (request.url !== '/v1/chat/completions') {
          response.writeHead(404);
          response.end();
          return;
        }
        if (!body.stream) {
          // The conversation auto-title: the only non-streaming completion Ask causes.
          titleRequests += 1;
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ choices: [{ message: { content: 'Token rotation' }, finish_reason: 'stop' }] }));
          return;
        }
        streamRequests += 1;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(streamBody);
      });
    });
    provider.listen(0, '127.0.0.1');
    await once(provider, 'listening');
    const providerPort = (provider.address() as AddressInfo).port;

    const name = `ask-provider-error-${Date.now()}`;
    userId = (await query<{ id: string }>(
      `INSERT INTO users (username, password_hash, role) VALUES ($1, 'fakehash', 'admin') RETURNING id`, [name],
    )).rows[0]!.id;
    await query('INSERT INTO user_settings (user_id) VALUES ($1)', [userId]);
    token = await generateAccessToken({ sub: userId, username: name, role: 'admin' });
    providerId = (await query<{ id: string }>(
      `INSERT INTO llm_providers (name, base_url, auth_type, default_model) VALUES ($1, $2, 'none', $3) RETURNING id`,
      [name, `http://127.0.0.1:${providerPort}/v1`, MODEL],
    )).rows[0]!.id;
    // Embedding too: retrieval must hit this file's outage, not whatever
    // provider the worker database already holds.
    for (const usecase of USECASES) {
      priorAssignments.set(usecase, (await query<{ provider_id: string | null; model: string | null }>(
        'SELECT provider_id, model FROM llm_usecase_assignments WHERE usecase = $1', [usecase],
      )).rows[0]);
      await query(`INSERT INTO llm_usecase_assignments (usecase, provider_id, model) VALUES ($1, $2, $3)
        ON CONFLICT (usecase) DO UPDATE SET provider_id = EXCLUDED.provider_id, model = EXCLUDED.model`, [usecase, providerId, MODEL]);
    }

    app = await buildApp();
    await app.listen({ host: '127.0.0.1', port: 0 });
    appPort = (app.server.address() as AddressInfo).port;
    initialCacheKeys = await redisKeys('kb:llm:*');
  }, 60_000);

  afterEach(() => {
    streamBody = content(ANSWER) + DONE;
  });

  afterAll(async () => {
    if (app) {
      const created = (await redisKeys('kb:llm:*')).filter((key) => !initialCacheKeys.includes(key));
      for (const key of created) await app.redis.del([key, `llm:lock:${key}`]);
      // The stream slot and the RBAC caches this user's requests left.
      const own = await redisKeys(`*${userId}*`);
      if (own.length > 0) await app.redis.del(own);
      await app.close();
    }
    if (provider) {
      provider.closeAllConnections();
      const closed = once(provider, 'close');
      provider.close();
      await closed;
    }
    if (providerId) {
      for (const [usecase, prior] of priorAssignments) {
        if (prior) {
          await query(`UPDATE llm_usecase_assignments SET provider_id = $1, model = $2 WHERE usecase = $3 AND provider_id = $4`,
            [prior.provider_id, prior.model, usecase, providerId]);
        } else {
          await query('DELETE FROM llm_usecase_assignments WHERE usecase = $1 AND provider_id = $2', [usecase, providerId]);
        }
      }
      await query('DELETE FROM llm_providers WHERE id = $1', [providerId]);
    }
    if (userId) {
      // `llm_audit_log.user_id` is ON DELETE SET NULL: remove the rows first.
      // Conversations cascade with the user.
      await query('DELETE FROM llm_audit_log WHERE user_id = $1', [userId]);
      await query('DELETE FROM users WHERE id = $1', [userId]);
    }
    await teardownTestDb();
  });

  async function redisKeys(pattern: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const scanned = await app.redis.scan(cursor, { MATCH: pattern, COUNT: 200 });
      cursor = String(scanned.cursor);
      keys.push(...scanned.keys);
    } while (cursor !== '0');
    return keys.sort();
  }

  async function snapshot(): Promise<Snapshot> {
    const conversations = await query<{ id: string; messages: string }>(
      'SELECT id, messages::text AS messages FROM llm_conversations WHERE user_id = $1 ORDER BY id', [userId],
    );
    const audit = await query<{ status: string; error_message: string | null }>(
      `SELECT status, error_message FROM llm_audit_log WHERE user_id = $1 AND action = 'ask' ORDER BY id`, [userId],
    );
    return {
      conversations: conversations.rows.map((row) => `${row.id} ${row.messages}`).join('\n'),
      audit: audit.rows,
      cacheKeys: await redisKeys('kb:llm:*'),
      streamRequests,
      titleRequests,
    };
  }

  async function streamSlotReleased(ms: number): Promise<boolean> {
    const deadline = performance.now() + ms;
    do {
      if (Number(await app.redis.get(`llm:streams:${userId}`)) <= 0) return true;
      await delay(10);
    } while (performance.now() < deadline);
    return false;
  }

  /** One ask, read to the end; returns once the route has released its slot. */
  async function ask(payload: Record<string, unknown>): Promise<AskResult> {
    const response = await fetch(`http://127.0.0.1:${appPort}/api/llm/ask`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    expect(await streamSlotReleased(5_000)).toBe(true);
    return {
      status: response.status,
      contentType: response.headers.get('content-type'),
      text,
      events: text.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>),
    };
  }

  /** A completed first turn; returns its conversation id once it is audited and titled. */
  async function seedConversation(question: string): Promise<string> {
    const before = await snapshot();
    const result = await ask({ question, referenceText: REFERENCE, inputKind: 'independent' });
    expect(result.status, result.text).toBe(200);
    const final = result.events.find((event) => event.final === true);
    expect(final, result.text).toBeDefined();
    expect(final!.conversationId).toEqual(expect.any(String));
    expect(await waitForDatabaseCondition(async () => (await snapshot()).audit.length > before.audit.length)).toBe(true);
    expect(await waitForDatabaseCondition(async () => titleRequests > before.titleRequests)).toBe(true);
    return final!.conversationId as string;
  }

  /**
   * The failed ask surfaced `Provider error` after the prefix, without the
   * provider's text, and left one `error` audit entry and nothing else: no
   * conversation write, no cache key, no title completion.
   */
  async function expectProviderFailure(result: AskResult, prefix: string, before: Snapshot): Promise<void> {
    expect(result.status, result.text).toBe(200);
    expect(result.contentType).toBe('text/event-stream');
    expect(result.events.at(-1)).toEqual({ error: 'Provider error', done: true });
    expect(result.events.some((event) => event.final === true)).toBe(false);
    expect(result.events.map((event) => event.content ?? '').join('')).toBe(prefix);
    expect(result.text).not.toContain('CUDA');

    expect(await waitForDatabaseCondition(async () => (await snapshot()).audit.length > before.audit.length)).toBe(true);
    await delay(SETTLE_MS);
    const after = await snapshot();
    expect(after.audit.slice(before.audit.length)).toEqual([{ status: 'error', error_message: AUDIT_ERROR }]);
    expect(after.conversations).toBe(before.conversations);
    expect(after.cacheKeys).toEqual(before.cacheKeys);
    expect(after.streamRequests - before.streamRequests).toBe(1);
    expect(after.titleRequests).toBe(before.titleRequests);
  }

  it.each(VARIANTS)('fails a new thread on an error frame $label, followed by [DONE]', async ({ label, body, prefix }) => {
    streamBody = body;
    const before = await snapshot();
    const result = await ask({ question: `How do I rotate a token (${label})?`, referenceText: REFERENCE, inputKind: 'independent' });
    await expectProviderFailure(result, prefix, before);
  }, 20_000);

  it('leaves an existing thread unchanged on an error frame, and persists a completed answer (control)', async () => {
    // Control: the same ask that completes is persisted, cached, audited
    // `success` and titled, so the assertions above are not vacuous.
    const before = await snapshot();
    const conversationId = await seedConversation('Which token do I revoke first?');
    const seeded = await snapshot();
    expect(seeded.audit.slice(before.audit.length)).toEqual([{ status: 'success', error_message: null }]);
    expect(seeded.conversations).not.toBe(before.conversations);
    expect(seeded.cacheKeys.filter((key) => !before.cacheKeys.includes(key))).toHaveLength(1);

    for (const { label, body, prefix } of VARIANTS) {
      streamBody = body;
      const beforeFollowUp = await snapshot();
      const result = await ask({
        question: `And after revoking it (${label})?`, referenceText: REFERENCE, inputKind: 'independent', conversationId,
      });
      await expectProviderFailure(result, prefix, beforeFollowUp);
    }
    const messages = await query<{ messages: unknown[] }>('SELECT messages FROM llm_conversations WHERE id = $1', [conversationId]);
    expect(messages.rows[0]!.messages).toHaveLength(2);
  }, 30_000);

  it('still refuses an ungrounded ask in a fresh thread', async () => {
    const before = await snapshot();
    const result = await ask({ question: 'How do I rotate a token if the model fails?', inputKind: 'independent' });
    expect(result.status, result.text).toBe(200);
    const final = result.events.find((event) => event.final === true);
    expect(final).toMatchObject({ refused: true, refusalReason: 'semantic_index_unavailable' });
    expect(streamRequests).toBe(before.streamRequests);
  }, 30_000);

  it('refuses an ungrounded follow-up in a thread whose only answers are blank', async () => {
    const conversationId = await seedConversation('Where do I issue a new token?');

    // With a real answer in the thread, the history grounds the follow-up.
    const grounded = await ask({ question: 'Can you repeat that?', inputKind: 'independent', conversationId });
    expect(grounded.status, grounded.text).toBe(200);
    expect(grounded.events.find((event) => event.final === true)).toMatchObject({ conversationId });
    expect(grounded.events.some((event) => event.refused === true)).toBe(false);

    // The shape a provider error frame left before #1728: assistant turns
    // persisted with empty content.
    await query(
      `UPDATE llm_conversations SET messages = (
         SELECT jsonb_agg(CASE WHEN m->>'role' = 'assistant' THEN jsonb_set(m, '{content}', '""') ELSE m END ORDER BY i)
         FROM jsonb_array_elements(messages) WITH ORDINALITY AS t(m, i)
       ) WHERE id = $1`,
      [conversationId],
    );

    const before = await snapshot();
    const result = await ask({ question: 'Can you repeat that once more?', inputKind: 'independent', conversationId });
    expect(result.status, result.text).toBe(200);
    expect(result.events.find((event) => event.final === true)).toMatchObject({
      refused: true, refusalReason: 'semantic_index_unavailable',
    });
    expect(streamRequests).toBe(before.streamRequests);
  }, 30_000);
});
