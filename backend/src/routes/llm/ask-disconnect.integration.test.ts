/**
 * #1719: `POST /api/llm/ask` stops provider work when its client disconnects.
 *
 * Full app over a real socket: real auth (JWT), PostgreSQL, Redis, retrieval,
 * cache, conversation persistence and stream-slot accounting. Only the
 * OpenAI-compatible provider is synthetic, a loopback server that can stream
 * slowly or stall and that observes when its own request socket closes. The
 * client is a raw `node:http` request whose socket the test destroys, which
 * is what a closed tab or a cancelled fetch does to the server.
 *
 * Every ask carries `referenceText` and `inputKind: 'independent'`, so the
 * identity contract is satisfied and the refusal gate stands down whatever
 * retrieval returns.
 */
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo, Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../app.js';
import { query } from '../../core/db/postgres.js';
import { generateAccessToken } from '../../core/plugins/auth.js';
import { logger } from '../../core/utils/logger.js';
import { LlmCache } from '../../domains/llm/services/llm-cache.js';
import { isDbAvailable, setupTestDb, teardownTestDb, waitForDatabaseCondition } from '../../test-db-helper.js';
import { isRedisAvailable } from '../../test-redis-helper.js';

const available = await isDbAvailable() && await isRedisAvailable();

const MODEL = 'ask-disconnect-model';
const USECASES = ['chat', 'embedding'] as const;
const REFERENCE = 'Rotating a personal access token: revoke the old token, then issue a new one.';
const SLOW_FRAMES = 20;
const SLOW_FRAME_INTERVAL_MS = 100;
/** The issue's bound for both the provider socket and the stream slot. */
const BOUND_MS = 1_000;
/**
 * Only for the negative assertions (no title completion, no late audit or
 * conversation write): how long a side effect that is not going to happen
 * is given to show up after the request has finished. Never a pass condition.
 */
const SETTLE_MS = 500;

type ProviderMode = 'complete' | 'slow' | 'stall';

interface ProviderStream {
  framesWritten: number;
  /** `performance.now()` when the provider saw its request socket close before the answer ended. */
  closedEarly: Promise<number>;
}

interface Snapshot {
  conversations: string;
  audit: Array<{ status: string; error_message: string | null }>;
  cacheKeys: string[];
  streamRequests: number;
  titleRequests: number;
}

describe.skipIf(!available)('POST /api/llm/ask — client disconnect (#1719)', () => {
  let app: FastifyInstance;
  let provider: Server;
  let appPort: number;
  let userId: string;
  let token: string;
  let providerId: string;
  const priorAssignments = new Map<string, { provider_id: string | null; model: string | null } | undefined>();
  let mode: ProviderMode = 'complete';
  let streamRequests = 0;
  let titleRequests = 0;
  const streamWaiters: Array<(stream: ProviderStream) => void> = [];
  let initialCacheKeys: string[] = [];

  const frame = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

  beforeAll(async () => {
    await setupTestDb();
    provider = createServer((request, response) => {
      let raw = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => { raw += chunk; });
      request.on('end', () => {
        const body = JSON.parse(raw || '{}') as { input?: string[]; stream?: boolean };
        if (request.url === '/v1/embeddings') {
          const vector = new Array(1024).fill(0.01);
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ data: (body.input ?? []).map(() => ({ embedding: vector })) }));
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
        const stream: ProviderStream = {
          framesWritten: 0,
          closedEarly: new Promise<number>((resolve) => {
            response.once('close', () => {
              if (!response.writableFinished) resolve(performance.now());
            });
          }),
        };
        streamWaiters.shift()?.(stream);
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        if (mode === 'complete') {
          response.end(`${frame('Revoke the old token first.')}data: [DONE]\n\n`);
        } else if (mode === 'slow') {
          const timer = setInterval(() => {
            if (stream.framesWritten === SLOW_FRAMES) {
              clearInterval(timer);
              response.end('data: [DONE]\n\n');
              return;
            }
            stream.framesWritten += 1;
            response.write(frame(`part ${stream.framesWritten}. `));
          }, SLOW_FRAME_INTERVAL_MS);
          response.once('close', () => clearInterval(timer));
        } else {
          // Headers, then silence.
          response.flushHeaders();
        }
      });
    });
    provider.listen(0, '127.0.0.1');
    await once(provider, 'listening');
    const providerPort = (provider.address() as AddressInfo).port;

    const name = `ask-disconnect-${Date.now()}`;
    userId = (await query<{ id: string }>(
      `INSERT INTO users (username, password_hash, role) VALUES ($1, 'fakehash', 'admin') RETURNING id`, [name],
    )).rows[0]!.id;
    await query('INSERT INTO user_settings (user_id) VALUES ($1)', [userId]);
    token = await generateAccessToken({ sub: userId, username: name, role: 'admin' });
    providerId = (await query<{ id: string }>(
      `INSERT INTO llm_providers (name, base_url, auth_type, default_model) VALUES ($1, $2, 'none', $3) RETURNING id`,
      [name, `http://127.0.0.1:${providerPort}/v1`, MODEL],
    )).rows[0]!.id;
    // Embedding too: whatever provider the worker database already holds
    // (another file's leftover default) must not decide retrieval here, or
    // its failures open the breaker and the asks answer 503.
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

  afterEach(async () => {
    mode = 'complete';
    streamWaiters.length = 0;
    vi.restoreAllMocks();
    // A provider stream the route failed to stop (the defect this file pins)
    // must not hold the stream slot into the next test.
    provider.closeAllConnections();
    await streamSlotReleased(5_000);
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
      await query('DELETE FROM llm_audit_log WHERE user_id = $1', [userId]);
      await query('DELETE FROM users WHERE id = $1', [userId]);
    }
    await teardownTestDb();
  });

  function nextProviderStream(): Promise<ProviderStream> {
    return new Promise((resolve) => streamWaiters.push(resolve));
  }

  /** Resolves with `value`, or with `null` once `ms` have passed. */
  function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
    return Promise.race([promise, delay(ms, null)]);
  }

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

  /** A raw HTTP ask whose socket the test can destroy. */
  function openAsk(payload: Record<string, unknown>) {
    const body = JSON.stringify(payload);
    const request = httpRequest({
      host: '127.0.0.1', port: appPort, path: '/api/llm/ask', method: 'POST', agent: false,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    });
    // The socket is destroyed on purpose; nothing reads the resulting error.
    request.on('error', () => {});
    const response = new Promise<IncomingMessage>((resolve) => request.once('response', resolve));
    request.end(body);
    return {
      response,
      /** Destroys the client socket and returns when that happened. */
      disconnect(): number {
        request.destroy();
        return performance.now();
      },
    };
  }

  /** Resolves once the response carried a non-empty `content` frame. */
  function firstContentFrame(response: IncomingMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        text += chunk;
        if (/"content":"[^"]+"/.test(text)) resolve();
      });
      response.on('error', () => {});
      response.on('end', () => reject(new Error(`stream ended before a content frame: ${text}`)));
    });
  }

  async function readAll(response: IncomingMessage): Promise<string> {
    response.setEncoding('utf8');
    let text = '';
    for await (const chunk of response) text += chunk as string;
    return text;
  }

  /** A completed ask; returns its final frame. */
  async function completeAsk(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    mode = 'complete';
    const titles = titleRequests;
    const response = await openAsk(payload).response;
    const text = await readAll(response);
    expect(response.statusCode, text).toBe(200);
    expect(response.headers['content-type']).toBe('text/event-stream');
    const events = text.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
    const final = events.find((event) => event.final === true);
    expect(final, text).toBeDefined();
    expect(await streamSlotReleased(5_000)).toBe(true);
    if (!payload.conversationId) {
      // A first turn is titled by a side completion; let it land so a later
      // window does not count it.
      expect(await waitForDatabaseCondition(async () => titleRequests > titles)).toBe(true);
    }
    return final!;
  }

  /**
   * After a disconnect: the provider socket closed within the bound, the slot
   * was released within the bound, and the request left exactly one
   * `error`/`Client disconnected` audit entry and nothing else.
   */
  async function expectStoppedAfterDisconnect(
    label: string,
    stream: ProviderStream,
    disconnectedAt: number,
    before: Snapshot,
  ): Promise<void> {
    const closedAt = await within(stream.closedEarly, 5_000);
    expect(closedAt, 'the provider request socket stayed open').not.toBeNull();
    const closeDelay = closedAt! - disconnectedAt;
    logger.info({ case: label, closeDelayMs: Number(closeDelay.toFixed(1)) }, '#1719 provider socket closed after the client disconnect');
    expect(closeDelay).toBeLessThan(BOUND_MS);
    expect(await streamSlotReleased(BOUND_MS)).toBe(true);

    expect(await waitForDatabaseCondition(async () => (await snapshot()).audit.length > before.audit.length)).toBe(true);
    await delay(SETTLE_MS);
    const after = await snapshot();
    expect(after.audit.slice(before.audit.length)).toEqual([{ status: 'error', error_message: 'Client disconnected' }]);
    expect(after.conversations).toBe(before.conversations);
    expect(after.cacheKeys).toEqual(before.cacheKeys);
    // Exactly one streaming completion (this ask) and no title completion.
    expect(after.streamRequests - before.streamRequests).toBe(1);
    expect(after.titleRequests).toBe(before.titleRequests);
  }

  it('aborts a slow provider stream when the client disconnects after the first content frame', async () => {
    mode = 'slow';
    const before = await snapshot();
    const providerStream = nextProviderStream();
    const ask = openAsk({ question: 'How do I rotate a token while it streams?', referenceText: REFERENCE, inputKind: 'independent' });
    const response = await ask.response;
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/event-stream');
    await firstContentFrame(response);
    const disconnectedAt = ask.disconnect();
    const stream = await providerStream;

    await expectStoppedAfterDisconnect('slow provider', stream, disconnectedAt, before);
    expect(stream.framesWritten).toBeLessThan(SLOW_FRAMES);
  }, 20_000);

  it('aborts a stalled provider (headers, then silence) when the client disconnects', async () => {
    mode = 'stall';
    const before = await snapshot();
    const providerStream = nextProviderStream();
    const ask = openAsk({ question: 'How do I rotate a token when the model stalls?', referenceText: REFERENCE, inputKind: 'independent' });
    // Ask writes nothing before the first provider chunk, so the client sees
    // no response; the provider's streaming request proves the ask got past
    // the identity contract and the refusal gate.
    const stream = await providerStream;
    expect(streamRequests - before.streamRequests).toBe(1);
    const disconnectedAt = ask.disconnect();

    await expectStoppedAfterDisconnect('stalled provider', stream, disconnectedAt, before);
  }, 20_000);

  it('persists, caches, audits and titles the same ask when the client stays (control)', async () => {
    const before = await snapshot();
    await completeAsk({ question: 'How do I rotate a token without leaving?', referenceText: REFERENCE, inputKind: 'independent' });

    expect(await waitForDatabaseCondition(async () => (await snapshot()).audit.length > before.audit.length)).toBe(true);
    const after = await snapshot();
    expect(after.audit.slice(before.audit.length)).toEqual([{ status: 'success', error_message: null }]);
    expect(after.conversations).not.toBe(before.conversations);
    expect(after.cacheKeys.filter((key) => !before.cacheKeys.includes(key))).toHaveLength(1);
    expect(after.streamRequests - before.streamRequests).toBe(1);
    expect(after.titleRequests - before.titleRequests).toBe(1);
  }, 20_000);

  it('leaves an existing conversation unchanged when a follow-up is disconnected mid-stream', async () => {
    const seeded = await completeAsk({ question: 'Which token do I revoke first?', referenceText: REFERENCE, inputKind: 'independent' });
    const conversationId = seeded.conversationId as string;
    expect(conversationId).toEqual(expect.any(String));
    await waitForDatabaseCondition(async () => (await snapshot()).audit.at(-1)?.status === 'success');

    mode = 'slow';
    const before = await snapshot();
    const providerStream = nextProviderStream();
    const ask = openAsk({
      question: 'And after revoking it?', referenceText: REFERENCE, inputKind: 'independent', conversationId,
    });
    const response = await ask.response;
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/event-stream');
    await firstContentFrame(response);
    const disconnectedAt = ask.disconnect();
    const stream = await providerStream;

    await expectStoppedAfterDisconnect('follow-up', stream, disconnectedAt, before);
    const messages = await query<{ messages: unknown[] }>('SELECT messages FROM llm_conversations WHERE id = $1', [conversationId]);
    expect(messages.rows[0]!.messages).toHaveLength(2);
  }, 30_000);

  it('makes no provider request and writes no audit row for a client that left before dispatch', async () => {
    const payload = { question: 'How do I rotate a token if I leave early?', referenceText: REFERENCE, inputKind: 'independent' };
    // The same body without a disconnect is answered: the negative
    // assertions below cannot hold merely because the request was refused.
    const keysBefore = await redisKeys('kb:llm:*');
    await completeAsk(payload);
    const key = (await redisKeys('kb:llm:*')).find((candidate) => !keysBefore.includes(candidate));
    expect(key).toBeDefined();

    // Hold the request at the lock wait, the last await before dispatch: no
    // cached answer, and a live lock owned by someone else.
    await app.redis.del(key!);
    await app.redis.set(`llm:lock:${key!}`, 'ask-disconnect-holder', { EX: 60 });
    let markWaiting!: () => void;
    const waiting = new Promise<void>((resolve) => { markWaiting = resolve; });
    const wait = LlmCache.prototype.waitForCachedResponse;
    vi.spyOn(LlmCache.prototype, 'waitForCachedResponse').mockImplementation(function (
      this: LlmCache,
      cacheKey,
      _pollIntervalMs,
      timeoutMs,
      signal,
    ) {
      if (cacheKey === key) markWaiting();
      return wait.call(this, cacheKey, 20, timeoutMs, signal);
    });

    const before = await snapshot();
    const serverSocket = once(app.server, 'connection').then(([socket]) => socket as Socket);
    const ask = openAsk(payload);
    const socket = await serverSocket;
    expect(await within(waiting, 5_000)).not.toBeNull();
    const serverSawClose = once(socket, 'close');
    ask.disconnect();
    expect(await within(serverSawClose, 5_000)).not.toBeNull();
    // The holder goes away without an answer: the waiter proceeds to dispatch.
    await app.redis.del(`llm:lock:${key!}`);

    expect(await streamSlotReleased(5_000)).toBe(true);
    await delay(SETTLE_MS);
    const after = await snapshot();
    expect(after.streamRequests).toBe(before.streamRequests);
    expect(after.titleRequests).toBe(before.titleRequests);
    expect(after.audit).toEqual(before.audit);
    expect(after.conversations).toBe(before.conversations);
    expect(after.cacheKeys).toEqual(before.cacheKeys);
  }, 30_000);
});
