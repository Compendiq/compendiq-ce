import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  chat,
  streamChat,
  generateEmbedding,
  listModels,
  invalidateBreaker,
  type ProviderConfig,
} from './openai-compatible-client.js';

// ---------------------------------------------------------------------------
// OTel span instrumentation for the LLM client.
//
// `withSpan` (src/telemetry.ts) reads the tracer from `globalThis.__otelTracer`
// and is a transparent pass-through when no tracer is installed. These tests
// install a minimal fake tracer at that seam and drive the REAL client against
// a REAL local HTTP server (mock at the boundary, per CLAUDE.md), asserting
// that each outbound LLM operation produces a named span with the expected
// attributes and status.
// ---------------------------------------------------------------------------

interface RecordedSpan {
  name: string;
  attributes: Record<string, unknown>;
  status: { code: number; message?: string } | null;
  exceptions: unknown[];
  ended: boolean;
}

let recordedSpans: RecordedSpan[];

function installFakeTracer(): void {
  recordedSpans = [];
  const tracer = {
    startActiveSpan<T>(name: string, fn: (span: unknown) => T): T {
      const rec: RecordedSpan = {
        name,
        attributes: {},
        status: null,
        exceptions: [],
        ended: false,
      };
      recordedSpans.push(rec);
      const span = {
        setAttribute(key: string, value: unknown) {
          rec.attributes[key] = value;
        },
        setStatus(s: { code: number; message?: string }) {
          rec.status = s;
        },
        recordException(err: unknown) {
          rec.exceptions.push(err);
        },
        end() {
          rec.ended = true;
        },
      };
      return fn(span);
    },
  };
  (globalThis as Record<string, unknown>).__otelTracer = tracer;
}

function spanByName(name: string): RecordedSpan | undefined {
  return recordedSpans.find((s) => s.name === name);
}

let srv: Server;
let baseUrl: string;

beforeAll(async () => {
  srv = createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
      return;
    }
    if (req.url === '/v1/embeddings') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }] }));
      return;
    }
    if (req.url === '/v1/chat/completions') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { stream?: boolean; model?: string };
        if (parsed.model === 'boom') {
          res.writeHead(500);
          res.end();
          return;
        }
        if (parsed.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }) + '\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }));
        }
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => srv.listen(0, r));
  const { port } = srv.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/v1`;
});

afterAll(() => new Promise<void>((r) => srv.close(() => r())));

// Unique provider id per test so circuit-breaker state never leaks between
// tests (3 failures trip a breaker for 30 s — far longer than this suite).
let providerSeq = 0;
let providerId: string;

function cfg(): ProviderConfig {
  return { providerId, baseUrl, apiKey: null, authType: 'none', verifySsl: true };
}

beforeEach(() => {
  providerId = `trace-test-${++providerSeq}`;
  installFakeTracer();
});

afterEach(() => {
  invalidateBreaker(providerId);
  delete (globalThis as Record<string, unknown>).__otelTracer;
});

describe('openai-compatible-client — OTel spans', () => {
  it('chat creates an llm.chat span with provider/model attributes and OK status', async () => {
    const out = await chat(cfg(), 'm1', [{ role: 'user', content: 'hi' }]);
    expect(out).toBe('hi');

    const span = spanByName('llm.chat');
    expect(span).toBeDefined();
    expect(span!.attributes['llm.provider_id']).toBe(providerId);
    expect(span!.attributes['llm.model']).toBe('m1');
    expect(span!.status).toEqual({ code: 1 });
    expect(span!.ended).toBe(true);
  });

  it('chat records error status and exception on upstream failure', async () => {
    await expect(chat(cfg(), 'boom', [{ role: 'user', content: 'hi' }])).rejects.toThrow(
      'chat HTTP 500',
    );

    const span = spanByName('llm.chat');
    expect(span).toBeDefined();
    expect(span!.status?.code).toBe(2);
    expect(span!.exceptions).toHaveLength(1);
    expect(span!.ended).toBe(true);
  });

  it('generateEmbedding creates an llm.embeddings span with input count', async () => {
    const vectors = await generateEmbedding(cfg(), 'bge-m3', ['a', 'b']);
    expect(vectors).toHaveLength(2);

    const span = spanByName('llm.embeddings');
    expect(span).toBeDefined();
    expect(span!.attributes['llm.provider_id']).toBe(providerId);
    expect(span!.attributes['llm.model']).toBe('bge-m3');
    expect(span!.attributes['llm.input_count']).toBe(2);
    expect(span!.status).toEqual({ code: 1 });
    expect(span!.ended).toBe(true);
  });

  it('listModels creates an llm.list_models span', async () => {
    const models = await listModels(cfg());
    expect(models.map((m) => m.name)).toEqual(['m1']);

    const span = spanByName('llm.list_models');
    expect(span).toBeDefined();
    expect(span!.attributes['llm.provider_id']).toBe(providerId);
    expect(span!.status).toEqual({ code: 1 });
    expect(span!.ended).toBe(true);
  });

  it('streamChat creates an llm.stream_chat.dispatch span around the initial request', async () => {
    const chunks: string[] = [];
    for await (const c of streamChat(cfg(), 'm1', [{ role: 'user', content: 'hi' }])) {
      chunks.push(c.content);
    }
    expect(chunks.filter(Boolean).join('')).toBe('hi');

    // The span covers only the dispatch (breaker-wrapped initial request),
    // not the full stream consumption — long-lived streams must not hold a
    // span open for minutes.
    const span = spanByName('llm.stream_chat.dispatch');
    expect(span).toBeDefined();
    expect(span!.attributes['llm.provider_id']).toBe(providerId);
    expect(span!.attributes['llm.model']).toBe('m1');
    expect(span!.status).toEqual({ code: 1 });
    expect(span!.ended).toBe(true);
  });

  it('streamChat records error status when the dispatch fails', async () => {
    const iterate = async () => {
      for await (const c of streamChat(cfg(), 'boom', [{ role: 'user', content: 'hi' }])) {
        void c;
      }
    };
    await expect(iterate()).rejects.toThrow('streamChat HTTP 500');

    const span = spanByName('llm.stream_chat.dispatch');
    expect(span).toBeDefined();
    expect(span!.status?.code).toBe(2);
    expect(span!.ended).toBe(true);
  });
});
