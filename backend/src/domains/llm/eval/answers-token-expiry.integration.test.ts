import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import { decodeJwt } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../../app.js';
import { query } from '../../../core/db/postgres.js';
import { generateAccessToken, getAccessTokenLifetimeSeconds } from '../../../core/plugins/auth.js';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../../test-db-helper.js';
import { askRequestBody, askThroughRoute, generateArmAnswers, sha256File, writeAnswerArtifacts, type AskFn } from './answers.js';
import { assertDisposableDatabase } from './disposable-db.js';
import type { ImageFixture } from './fixture.js';
import { configureEmbeddingProvider, EVAL_USER_ID } from './seed.js';

/**
 * #1824 — an arm answer run that outlives one access token, on the real app
 * (`buildApp`: the auth plugin verifies every request), real PostgreSQL and
 * real Redis.
 *
 * `run-arm-answers.ts` used to sign ONE token before the loop; a run longer
 * than `ACCESS_TOKEN_EXPIRY` (default 1h, ~11.7 s per question) answered 401
 * mid-run and never wrote its artifacts. The harness now mints its bearer at
 * the request boundary. This file proves both halves on a 2 s lifetime: the
 * route still refuses an expired token (authentication is not bypassed), and
 * a run whose questions straddle expiry completes and writes its artifacts —
 * without the app-wide lifetime being raised.
 *
 * The corpus is EMPTY, so the route answers every question with the
 * protocol's `no_context` refusal and never streams an answer: `streamChat`
 * throws and must stay uncalled. The non-streaming entry points are stubbed
 * to fail only so the fire-and-forget conversation auto-title (which keeps
 * its question-derived title on failure) never dials the fake provider.
 */

// auth.ts reads ACCESS_TOKEN_EXPIRY once at module load. `vi.hoisted` runs
// before every import of this file (vitest hoists it above them), and
// test-setup.ts never loads auth.ts. 2 s, not 1 s: jose's
// `exp = floor(now) + 1` can expire within a millisecond of minting, which
// would make the "fresh token" leg flaky.
const { priorExpiry } = vi.hoisted(() => {
  const prior = process.env.ACCESS_TOKEN_EXPIRY;
  process.env.ACCESS_TOKEN_EXPIRY = '2s';
  return { priorExpiry: prior };
});

const { streamChatMock, noProviderMock } = vi.hoisted(() => ({
  streamChatMock: vi.fn(() => {
    throw new Error('#1824 fixture: no answer may be streamed on an empty corpus');
  }),
  noProviderMock: vi.fn(async () => {
    throw new Error('#1824 fixture: no provider is reachable');
  }),
}));
vi.mock('../services/openai-compatible-client.js', async () => {
  const actual = await vi.importActual<typeof import('../services/openai-compatible-client.js')>(
    '../services/openai-compatible-client.js',
  );
  return {
    ...actual,
    // Deterministic 1024-d vectors: the embedding leg must SUCCEED, or the
    // route refuses with `semantic_index_unavailable` (an outage) instead.
    generateEmbedding: vi.fn(async (_cfg: unknown, _model: string, input: string | string[]) =>
      (Array.isArray(input) ? input : [input]).map(() => Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0))),
    ),
    streamChat: streamChatMock,
    chatCompletion: noProviderMock,
    chat: noProviderMock,
  };
});

const dbAvailable = await isDbAvailable();
const CLAIMS = { sub: EVAL_USER_ID, username: 'eval-runner', role: 'admin' } as const;
// One second past the 2 s lifetime: a token minted before the pause is
// expired after it, whatever the sub-second phase of `exp`. Real wall-clock
// time on purpose: jose checks `exp` against the platform clock inside the
// real auth plugin, and faking `Date` app-wide would also freeze every
// Date-based deadline on the request path.
const PAST_EXPIRY_MS = 3_000;

function fixtureOf(queries: string[]): ImageFixture {
  return {
    corpusManifestSha: 'test',
    labeledBy: 'test',
    notUsable: [],
    labels: queries.map((query, i) => ({
      id: `expiry-${i + 1}`,
      query,
      lang: 'de' as const,
      expectedFiles: ['seite.html'],
      expectedImages: [],
      style: 'image' as const,
      rationale: 'test',
    })),
  };
}

describe.skipIf(!dbAvailable)('arm answers across access-token expiry (#1824)', () => {
  let app: FastifyInstance;
  const outDir = mkdtempSync(join(tmpdir(), 'answers-expiry-'));

  beforeAll(async () => {
    await setupTestDb();
    assertDisposableDatabase(process.env.POSTGRES_URL!);
    await truncateAllTables();
    await query(
      `INSERT INTO users (id, username, email, role, password_hash)
       VALUES ($1::uuid, 'eval-runner', 'eval@local', 'admin', 'x')`,
      [EVAL_USER_ID],
    );
    await query('INSERT INTO user_settings (user_id, confluence_enabled) VALUES ($1, FALSE)', [EVAL_USER_ID]);
    const providerId = await configureEmbeddingProvider({ baseUrl: 'http://stub/v1', model: 'stub-embed' });
    // The ask route resolves `chat` before retrieval; it is never called.
    await query(
      `INSERT INTO llm_usecase_assignments (usecase, provider_id, model, updated_at) VALUES ('chat', $1, 'stub-chat', NOW())`,
      [providerId],
    );
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    rmSync(outDir, { recursive: true, force: true });
    await teardownTestDb();
    // Never leak the 2 s lifetime into a later file sharing this worker.
    if (priorExpiry === undefined) delete process.env.ACCESS_TOKEN_EXPIRY;
    else process.env.ACCESS_TOKEN_EXPIRY = priorExpiry;
  });

  it('runs on a 2 s access-token lifetime (the premise)', () => {
    expect(getAccessTokenLifetimeSeconds()).toBe(2);
  });

  // #282 made the route refuse a question that does not state its identity
  // (400 `ask_identity_required`); the harness asks with no article open,
  // so its body must say `inputKind: 'independent'` or no arm run answers
  // a single question.
  it('the harness request body states its identity — the route answers it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/llm/ask',
      headers: { authorization: `Bearer ${await generateAccessToken(CLAIMS)}`, 'content-type': 'application/json' },
      payload: askRequestBody('Wie richte ich den Drucker ein?'),
    });
    expect(res.body).not.toContain('ask_identity_required');
    expect(res.statusCode).toBe(200);
  });

  it('a captured token still 401s after expiry — auth is not bypassed', async () => {
    const fixed = await generateAccessToken(CLAIMS);
    const ask = askThroughRoute(app, async () => fixed);
    await expect(ask('Wie richte ich den Drucker ein?')).resolves.toMatchObject({ refused: true, refusalReason: 'no_context' });
    await delay(PAST_EXPIRY_MS);
    await expect(ask('Wie richte ich den Scanner ein?')).rejects.toThrow(/answered 401/);
  });

  it('a run spanning expiry completes and writes its artifacts', async () => {
    const minted: Array<{ token: string; at: number }> = [];
    const routed = askThroughRoute(app, async () => {
      const token = await generateAccessToken(CLAIMS);
      minted.push({ token, at: Date.now() / 1000 });
      return token;
    });
    // Each answer is followed by a pause past the lifetime, so every question
    // after the first is asked after the previous question's token expired.
    const ask: AskFn = async (question) => {
      const outcome = await routed(question);
      await delay(PAST_EXPIRY_MS);
      return outcome;
    };

    const generated = await generateArmAnswers(ask, fixtureOf(['Wie richte ich den Drucker ein?', 'Wie richte ich den Scanner ein?']), { arm: 'C' });

    expect(minted).toHaveLength(2);
    expect(minted[1]!.at).toBeGreaterThanOrEqual(decodeJwt(minted[0]!.token).exp!);
    expect(generated.answers).toHaveLength(2);
    expect(generated.answers.every((row) => row.refused === true)).toBe(true);
    expect(generated.refused).toBe(2);
    expect(generated.refusalReasons).toEqual({ no_context: 2 });

    const written = writeAnswerArtifacts(outDir, 'expiry', generated);
    expect(existsSync(written.answersPath)).toBe(true);
    expect(existsSync(written.mappingPath)).toBe(true);
    expect(sha256File(written.answersPath)).toBe(written.answersSha256);
    expect(sha256File(written.mappingPath)).toBe(written.mappingSha256);

    expect(streamChatMock).not.toHaveBeenCalled();
    // The repair is in the harness: the app-wide lifetime is unchanged.
    expect(getAccessTokenLifetimeSeconds()).toBe(2);
  });
});
