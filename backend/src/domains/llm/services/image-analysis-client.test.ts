import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const logCalls = vi.hoisted(() => [] as unknown[][]);
vi.mock('../../../core/utils/logger.js', () => {
  const record = (...args: unknown[]) => { logCalls.push(args); };
  return { logger: { info: record, warn: record, error: record, debug: record } };
});

import {
  analyzeImage,
  classifyHttpStatus,
  encodeImageAnalysisError,
  extractFirstJsonObject,
  IMAGE_ANALYSIS_PROMPT,
  REFUSAL_PATTERNS,
  type ImageAnalysisFailure,
} from './image-analysis-client.js';
import type { ProviderConfig } from './openai-compatible-client.js';

/**
 * ADR-027 D8 — the client's classing, against a real local HTTP server so the
 * boundary under test (what the provider sends back) is the real one. The
 * provider's answer is scripted per case; the DB is never touched.
 */

/** 1×1 PNG. What the bytes are does not matter here; that they never leak does. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

let srv: Server;
let baseUrl: string;
/** The next response the fake provider gives; set per test. */
let respond: (body: Record<string, unknown>) => { status: number; body: unknown };
/** Every request body the fake provider received. */
let received: Array<Record<string, unknown>>;

const OK_PAYLOAD = {
  schemaVersion: 1,
  kind: 'screenshot',
  language: 'de',
  description: 'Ein Anmeldedialog mit der Fehlermeldung E-4711 in roter Schrift.',
  visibleText: 'Anmeldung fehlgeschlagen\nFehlercode: E-4711',
  limitations: [],
};

function chatReply(content: string, finishReason = 'stop', usage: Record<string, number> | null = { prompt_tokens: 1300, completion_tokens: 87 }) {
  return {
    choices: [{ message: { role: 'assistant', content }, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
}

beforeAll(async () => {
  srv = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      received.push(body);
      const { status, body: out } = respond(body);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(typeof out === 'string' ? out : JSON.stringify(out));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`;
});

afterAll(() => new Promise<void>((r) => srv.close(() => r())));

let seq = 0;
let provider: ProviderConfig;
let identity: { providerId: string; model: string; baseUrl: string };

beforeEach(() => {
  received = [];
  logCalls.length = 0;
  // A fresh provider id per case keeps one case's 5xx from opening the
  // breaker on the next.
  const providerId = `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
  provider = { providerId, baseUrl, apiKey: null, authType: 'none', verifySsl: true };
  identity = { providerId, model: 'qwen3-vl', baseUrl };
});

const run = (over: Partial<Parameters<typeof analyzeImage>[0]> = {}) =>
  analyzeImage({ bytes: PNG, mimeType: 'image/png', identity, maxOutputTokens: 8192, provider, ...over });

describe('analyzeImage — the request (ADR-027 D8 wire)', () => {
  it('sends temperature 0, max_tokens = the ceiling, no tools, a data-URL part and no page text', async () => {
    respond = () => ({ status: 200, body: chatReply(JSON.stringify(OK_PAYLOAD)) });
    const r = await run({ maxOutputTokens: 6000 });
    expect(r.ok).toBe(true);

    const body = received[0]!;
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(6000);
    expect(body.stream).toBe(false);
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('response_format');
    const messages = body.messages as Array<{ role: string; content: Array<{ type: string; text?: string; image_url?: { url: string } }> }>;
    expect(messages).toHaveLength(1);
    const parts = messages[0]!.content;
    expect(parts.map((p) => p.type)).toEqual(['text', 'image_url']);
    expect(parts[0]!.text).toBe(IMAGE_ANALYSIS_PROMPT);
    expect(parts[1]!.image_url!.url).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
  });

  it('answers the payload, finish reason and token usage on success', async () => {
    respond = () => ({ status: 200, body: chatReply(JSON.stringify(OK_PAYLOAD)) });
    const r = await run();
    expect(r).toMatchObject({
      ok: true,
      finishReason: 'stop',
      usage: { promptTokens: 1300, completionTokens: 87 },
      payload: { kind: 'screenshot', visibleText: 'Anmeldung fehlgeschlagen\nFehlercode: E-4711' },
    });
  });

  it('parses JSON out of a Markdown fence, a <think> preamble and trailing prose', async () => {
    respond = () => ({
      status: 200,
      body: chatReply('<think>looking at the image</think>Here you go:\n```json\n' + JSON.stringify(OK_PAYLOAD) + '\n```\nHope this helps.'),
    });
    const r = await run();
    expect(r.ok).toBe(true);
  });

  it('refuses to post the bytes when the provider endpoint differs from the retained identity', async () => {
    respond = () => ({ status: 200, body: chatReply(JSON.stringify(OK_PAYLOAD)) });
    const r = await run({ identity: { ...identity, baseUrl: 'http://moved.example/v1' } });
    expect(r).toMatchObject({ ok: false, class: 'unavailable', providerLevel: true });
    expect(received).toHaveLength(0);
  });
});

describe('analyzeImage — the five deterministic classes', () => {
  it('malformed: no JSON object in the reply', async () => {
    respond = () => ({ status: 200, body: chatReply('The image shows a login dialog with an error.') });
    expect(await run()).toMatchObject({ ok: false, class: 'malformed', providerLevel: false });
  });

  it('malformed: JSON that the schema rejects (a block that contradicts the kind)', async () => {
    respond = () => ({
      status: 200,
      body: chatReply(JSON.stringify({ ...OK_PAYLOAD, kind: 'photo', structured: { tableRows: ['a | b'] } })),
    });
    expect(await run()).toMatchObject({ ok: false, class: 'malformed' });
  });

  it('malformed: a bound the ceiling in force does not admit', async () => {
    // 2,500 characters of transcription are legal at 8,192 and illegal at 4,096 (bound 941).
    const payload = { ...OK_PAYLOAD, visibleText: 'x'.repeat(2_500) };
    respond = () => ({ status: 200, body: chatReply(JSON.stringify(payload)) });
    expect((await run({ maxOutputTokens: 8192 })).ok).toBe(true);
    expect(await run({ maxOutputTokens: 4096 })).toMatchObject({ ok: false, class: 'malformed' });
  });

  it('empty: a parsed payload that is not substantive (URLs alone never count)', async () => {
    respond = () => ({
      status: 200,
      body: chatReply(JSON.stringify({ ...OK_PAYLOAD, description: 'https://example.com/a/very/long/url/that/is/not/content', visibleText: 'ok' })),
    });
    expect(await run()).toMatchObject({ ok: false, class: 'empty' });
  });

  it('refused: a bare refusal, and a refusal wrapped in the requested JSON', async () => {
    respond = () => ({ status: 200, body: chatReply("I'm sorry, but I can't help with analyzing this image.") });
    expect(await run()).toMatchObject({ ok: false, class: 'refused' });

    respond = () => ({
      status: 200,
      body: chatReply(JSON.stringify({ ...OK_PAYLOAD, description: 'I cannot assist.', visibleText: '' })),
    });
    expect(await run()).toMatchObject({ ok: false, class: 'refused' });
  });

  it('truncated: finish_reason length, carrying the ceiling it overran', async () => {
    respond = () => ({ status: 200, body: chatReply('{"schemaVersion":1,"kind":"table","descr', 'length') });
    const r = (await run({ maxOutputTokens: 4096 })) as ImageAnalysisFailure;
    expect(r).toMatchObject({ ok: false, class: 'truncated', ceiling: 4096, providerLevel: false });
    expect(encodeImageAnalysisError(r)).toBe('truncated:4096');
  });

  it.each([400, 413, 415, 422])('rejected:%i — a 4xx the provider attributes to this request body', async (status) => {
    respond = () => ({ status, body: { error: { message: 'tenant-7 @ 10.0.0.4 refused the content part' } } });
    const r = (await run()) as ImageAnalysisFailure;
    expect(r).toMatchObject({ ok: false, class: 'rejected', httpStatus: status, providerLevel: false });
    expect(encodeImageAnalysisError(r)).toBe(`rejected:${status}`);
  });
});

describe('analyzeImage — the transient class and the provider-level default arm', () => {
  it.each([408, 429, 500, 502, 503])('unavailable:%i keeps the batch running (not provider-level)', async (status) => {
    respond = () => ({ status, body: { error: 'later' } });
    const r = (await run()) as ImageAnalysisFailure;
    expect(r).toMatchObject({ ok: false, class: 'unavailable', httpStatus: status, providerLevel: false });
    expect(encodeImageAnalysisError(r)).toBe(`unavailable:${status}`);
  });

  it.each([401, 402, 403, 404, 405, 409, 418, 451])('unavailable:%i is provider-level — the default arm', async (status) => {
    respond = () => ({ status, body: { error: 'no' } });
    const r = (await run()) as ImageAnalysisFailure;
    expect(r).toMatchObject({ ok: false, class: 'unavailable', httpStatus: status, providerLevel: true });
  });

  it('a request that never completes is unavailable with no status', async () => {
    const r = (await run({ provider: { ...provider, baseUrl: 'http://127.0.0.1:1/v1' }, identity: { ...identity, baseUrl: 'http://127.0.0.1:1/v1' } })) as ImageAnalysisFailure;
    expect(r).toMatchObject({ ok: false, class: 'unavailable', providerLevel: false });
    expect(r.httpStatus).toBeUndefined();
    expect(encodeImageAnalysisError(r)).toBe('unavailable');
  });

  it('the classing is total: every status lands in exactly one of the three arms', () => {
    for (let s = 400; s < 600; s++) {
      const c = classifyHttpStatus(s);
      if ([400, 413, 415, 422].includes(s)) expect(c).toEqual({ class: 'rejected', providerLevel: false });
      else if (s === 408 || s === 429 || s >= 500) expect(c).toEqual({ class: 'unavailable', providerLevel: false });
      else expect(c).toEqual({ class: 'unavailable', providerLevel: true });
    }
  });
});

describe('analyzeImage — log hygiene (ADR-027 D14)', () => {
  it('logs neither the base64 image nor any part of the reply, on success or on any failure', async () => {
    const secretReply = 'SECRET-REPLY-TEXT do not log me';
    respond = () => ({ status: 200, body: chatReply(secretReply) });
    await run();
    respond = () => ({ status: 200, body: chatReply(JSON.stringify(OK_PAYLOAD)) });
    await run();
    respond = () => ({ status: 401, body: { error: 'SECRET-PROVIDER-BODY' } });
    await run();

    const logged = JSON.stringify(logCalls);
    expect(logged).not.toContain(PNG.toString('base64').slice(0, 24));
    expect(logged).not.toContain('SECRET-REPLY-TEXT');
    expect(logged).not.toContain('SECRET-PROVIDER-BODY');
    expect(logged).not.toContain('Anmeldung fehlgeschlagen');
  });
});

describe('helpers', () => {
  it('extractFirstJsonObject is string-aware', () => {
    expect(extractFirstJsonObject('x {"a":"}"} y {"b":1}')).toBe('{"a":"}"}');
    expect(extractFirstJsonObject('no object here')).toBeNull();
    expect(extractFirstJsonObject('{"unterminated": ')).toBeNull();
  });

  it('REFUSAL_PATTERNS match refusals and not descriptions that mention limits', () => {
    const matches = (s: string) => REFUSAL_PATTERNS.some((p) => p.test(s));
    expect(matches("I'm unable to view images.")).toBe(true);
    expect(matches('As an AI language model I cannot see pictures.')).toBe(true);
    expect(matches('Es tut mir leid, ich kann das Bild nicht analysieren.')).toBe(true);
    expect(matches('A dialog stating "Unable to connect to server E-4711".')).toBe(false);
    expect(matches('Chart of monthly revenue; the y axis is unlabeled.')).toBe(false);
  });
});
