import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { checkHealth, listModels, chat, streamChat, generateEmbedding, invalidateBreaker, __test_only__, type ProviderConfig } from './openai-compatible-client.js';

let srv: Server;
let baseUrl: string;

beforeAll(async () => {
  srv = createServer((req, res) => {
    if (req.url === '/v1/models' && req.headers.authorization === 'Bearer sekret') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'm1' }, { id: 'm2' }] }));
      return;
    }
    if (req.url === '/v1/models') { res.writeHead(401); res.end(); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => srv.listen(0, r));
  const { port } = srv.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/v1`;
});

afterAll(() => new Promise<void>((r) => srv.close(() => r())));

const cfg: ProviderConfig = {
  providerId: 'id1', baseUrl: '', apiKey: 'sekret', authType: 'bearer', verifySsl: true,
};

describe('openai-compatible-client', () => {
  it('listModels returns models from /v1/models', async () => {
    const r = await listModels({ ...cfg, baseUrl });
    expect(r.map(m => m.name)).toEqual(['m1', 'm2']);
  });
  it('checkHealth returns connected:true when endpoint is reachable', async () => {
    const r = await checkHealth({ ...cfg, baseUrl });
    expect(r.connected).toBe(true);
  });
  it('checkHealth returns connected:false on 401', async () => {
    const r = await checkHealth({ ...cfg, baseUrl, apiKey: null });
    expect(r.connected).toBe(false);
  });
});

describe('openai-compatible-client — chat', () => {
  let chatSrv: Server;
  let chatBase: string;
  beforeAll(async () => {
    chatSrv = createServer((req, res) => {
      if (req.url === '/v1/chat/completions') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const parsed = JSON.parse(body);
          if (parsed.stream) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'hel' } }] }) + '\n\n');
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'lo' } }] }) + '\n\n');
            res.write('data: [DONE]\n\n');
            res.end();
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { content: 'hello' } }] }));
          }
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    await new Promise<void>((r) => chatSrv.listen(0, r));
    const { port } = chatSrv.address() as AddressInfo;
    chatBase = `http://127.0.0.1:${port}/v1`;
  });
  afterAll(() => new Promise<void>((r) => chatSrv.close(() => r())));

  it('chat returns assistant content', async () => {
    const r = await chat({ ...cfg, baseUrl: chatBase }, 'm1', [{ role: 'user', content: 'hi' }]);
    expect(r).toBe('hello');
  });

  it('streamChat yields chunks then done', async () => {
    const out: string[] = [];
    let done = false;
    for await (const c of streamChat({ ...cfg, baseUrl: chatBase }, 'm1', [{ role: 'user', content: 'hi' }])) {
      out.push(c.content); if (c.done) done = true;
    }
    expect(out.filter(Boolean).join('')).toBe('hello');
    expect(done).toBe(true);
  });
});

// ─── #868: early termination must cancel the upstream body ──────────────────
// When a consumer stops iterating streamChat() early (e.g. streamSSE breaks its
// loop on client disconnect), the JS runtime calls generator.return(). Without
// a try/finally around the read loop, reader.cancel() is never called, so the
// undici response body / TCP socket stays open and the OpenAI-compatible /
// Ollama backend keeps generating the full response — holding a GPU slot and
// billing output tokens. This fake server writes ONE frame and then holds the
// connection open forever (never [DONE], never res.end()), so the only way it
// can observe a 'close' event is the client tearing down the socket.
describe('openai-compatible-client — streamChat cancels upstream on early termination (#868)', () => {
  let leakSrv: Server;
  let leakBase: string;
  let serverSawClose = false;
  let resolveClose!: () => void;

  beforeAll(async () => {
    leakSrv = createServer((req, res) => {
      if (req.url === '/v1/chat/completions') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          // One frame, then hold the connection open forever: no [DONE], no end().
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }) + '\n\n');
          // Never completes on its own, so 'close' can only mean the client aborted.
          res.on('close', () => { serverSawClose = true; resolveClose(); });
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    await new Promise<void>((r) => leakSrv.listen(0, r));
    const { port } = leakSrv.address() as AddressInfo;
    leakBase = `http://127.0.0.1:${port}/v1`;
  });
  afterAll(() => new Promise<void>((r) => leakSrv.close(() => r())));

  it('breaking out of the for-await loop tears down the upstream connection', async () => {
    serverSawClose = false;
    const closePromise = new Promise<void>((r) => { resolveClose = r; });

    let received = '';
    for await (const c of streamChat(
      { ...cfg, baseUrl: leakBase, providerId: 'leak-test' },
      'm',
      [{ role: 'user', content: 'hi' }],
    )) {
      received += c.content;
      break; // early termination → generator.return() → finally → reader.cancel()
    }
    // Confirm we actually consumed a chunk before bailing (the leak scenario).
    expect(received).toBe('hi');

    // Give the socket teardown up to 1s to reach the server. Pre-fix the reader
    // is never cancelled, the connection stays open, and this race times out
    // (serverSawClose stays false). Post-fix reader.cancel() closes the socket.
    await Promise.race([
      closePromise,
      new Promise<void>((r) => setTimeout(r, 1000)),
    ]);
    expect(serverSawClose).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Thinking-mode pure function — branches on (provider strictness, model)
//
// The shape we put on the wire depends on the SERVER, not the model name:
// - OpenAI rejects unknown fields → strict path, only emit reasoning_effort
//   when the model is recognized as reasoning-capable; nothing otherwise.
// - Self-hosted (Ollama/vLLM/SGLang/LM Studio/…) tolerates unknown fields →
//   always emit think + chat_template_kwargs, regardless of model name.
//   Any user-installed model is safe: thinking activates if the template
//   supports it, else silently no-ops.
//
// Table-driven so a future provider/model row is one line, not a new it().
// ---------------------------------------------------------------------------
describe('thinkingExtras — provider-strictness × model matrix', () => {
  const { thinkingExtras, isStrictOpenAiCompatibleHost, isOpenAiReasoningModel } = __test_only__;

  it('returns {} when thinking is off, regardless of provider', () => {
    expect(thinkingExtras('https://api.openai.com/v1', 'o3', false)).toEqual({});
    expect(thinkingExtras('http://localhost:11434/v1', 'qwen3:8b', false)).toEqual({});
    expect(thinkingExtras('http://localhost:11434/v1', 'qwen3:8b')).toEqual({});
  });

  describe('Strict providers (OpenAI, Azure OpenAI)', () => {
    it.each([
      // [baseUrl, model, expected extras]
      ['https://api.openai.com/v1',                                 'o3',        { reasoning_effort: 'medium' }],
      ['https://api.openai.com/v1',                                 'o3-mini',   { reasoning_effort: 'medium' }],
      ['https://api.openai.com/v1',                                 'o4-mini',   { reasoning_effort: 'medium' }],
      ['https://api.openai.com/v1',                                 'gpt-5',     { reasoning_effort: 'medium' }],
      ['https://api.openai.com/v1',                                 'gpt-5-pro', { reasoning_effort: 'medium' }],
      // Azure OpenAI is strict too — tenant-scoped subdomain.
      ['https://my-resource.openai.azure.com/openai/deployments/x', 'gpt-5',     { reasoning_effort: 'medium' }],
      ['https://contoso.openai.azure.com/v1',                       'o3',        { reasoning_effort: 'medium' }],
    ])('on %s with reasoning model %s → reasoning_effort', (baseUrl, model, expected) => {
      expect(thinkingExtras(baseUrl, model, true)).toEqual(expected);
    });

    it.each([
      // o1 family rejects reasoning_effort (parameter postdates the model) —
      // must NOT emit it, otherwise OpenAI returns 400.
      ['https://api.openai.com/v1',                                 'o1'],
      ['https://api.openai.com/v1',                                 'o1-mini'],
      ['https://api.openai.com/v1',                                 'o1-preview'],
      // Non-reasoning OpenAI models — were the 400 source pre-this-PR.
      ['https://api.openai.com/v1',                                 'gpt-4o'],
      ['https://api.openai.com/v1',                                 'gpt-4'],
      ['https://api.openai.com/v1',                                 'gpt-4-turbo'],
      ['https://api.openai.com/v1',                                 'gpt-3.5-turbo'],
      ['https://api.openai.com/v1',                                 'text-embedding-3-large'],
      // Azure tenant hosting a non-reasoning deployment.
      ['https://my-resource.openai.azure.com/openai/deployments/x', 'gpt-4o'],
    ])('on %s with non-reasoning model %s → no extras (silent no-op)', (baseUrl, model) => {
      expect(thinkingExtras(baseUrl, model, true)).toEqual({});
    });
  });

  describe('Self-hosted tolerant provider', () => {
    // Any user-installed model on Ollama/vLLM/etc. — the toggle is safe
    // because tolerant servers ignore unknown fields when the chat
    // template has no thinking branch.
    it.each([
      ['http://localhost:11434/v1',         'qwen3:8b'],
      ['http://localhost:11434/v1',         'deepseek-r1:14b'],
      ['http://localhost:11434/v1',         'llama3:8b'],          // non-thinking — no-op upstream
      ['http://localhost:11434/v1',         'my-team/r1-tune:v2'], // custom name with thinking template
      ['http://192.168.1.10:8000/v1',       'gpt-oss:20b'],        // vLLM-style host
      ['https://ollama.internal.example/v1','magistral:7b'],       // arbitrary tolerant host
      ['http://lmstudio.local/v1',          'phi-4'],
    ])('on %s with model %s emits think + chat_template_kwargs', (baseUrl, model) => {
      expect(thinkingExtras(baseUrl, model, true)).toEqual({
        think: true,
        chat_template_kwargs: { enable_thinking: true },
      });
    });
  });

  describe('isStrictOpenAiCompatibleHost', () => {
    it.each([
      // strict
      ['https://api.openai.com/v1',                                 true],
      ['https://api.openai.com:443/v1',                             true],
      ['https://my-resource.openai.azure.com/openai/deployments/x', true],
      ['https://contoso.openai.azure.com/v1',                       true],
      // tolerant
      ['http://localhost:11434/v1',                                 false],
      ['http://192.168.1.10:8000/v1',                               false],
      // adversarial: substring spoofing must not match
      ['https://my-openai-proxy.example/v1',                        false],
      ['https://api.openai.com.evil.tld/v1',                        false],
      ['https://openai.azure.com.evil.tld/v1',                      false],
      // garbage in → tolerant fallback (safer than a false strict)
      ['not a url',                                                 false],
    ])('%s → strict=%s', (baseUrl, expected) => {
      expect(isStrictOpenAiCompatibleHost(baseUrl)).toBe(expected);
    });
  });

  describe('isOpenAiReasoningModel', () => {
    it.each([
      ['o3',         true],
      ['o3-mini',    true],
      ['o4-mini',    true],
      ['o9-future',  true],
      ['gpt-5',      true],
      ['gpt-5-pro',  true],
      // o1 family predates `reasoning_effort` — must NOT be flagged.
      ['o1',         false],
      ['o1-mini',    false],
      ['o1-preview', false],
      ['o2',         false], // didn't ship; reserved to avoid false-positive on hypothetical naming
      ['gpt-4o',     false],
      ['gpt-4',      false],
      ['gpt-3.5',    false],
    ])('%s → reasoning=%s', (model, expected) => {
      expect(isOpenAiReasoningModel(model)).toBe(expected);
    });
  });
});

// ---------------------------------------------------------------------------
// Integration — the streamChat() and chat() wire format actually carries
// what `thinkingExtras` returns. Local capture server is NOT api.openai.com,
// so this exercises the tolerant branch end-to-end. The strict branch is
// proven by the pure-function tests above.
// ---------------------------------------------------------------------------
describe('openai-compatible-client — thinking-mode integration via streamChat/chat', () => {
  let capSrv: Server;
  let capBase: string;
  let lastBody: Record<string, unknown> | null = null;

  beforeAll(async () => {
    capSrv = createServer((req, res) => {
      if (req.url === '/v1/chat/completions') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          lastBody = JSON.parse(body);
          const parsed = lastBody as { stream?: boolean };
          if (parsed.stream) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }) + '\n\n');
            res.write('data: [DONE]\n\n');
            res.end();
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
          }
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    await new Promise<void>((r) => capSrv.listen(0, r));
    const { port } = capSrv.address() as AddressInfo;
    capBase = `http://127.0.0.1:${port}/v1`;
  });
  afterAll(() => new Promise<void>((r) => capSrv.close(() => r())));

  async function drainStream(model: string, thinking: boolean) {
    lastBody = null;
    for await (const _chunk of streamChat(
      { ...cfg, baseUrl: capBase, providerId: `thinking-${model}-${thinking}` },
      model,
      [{ role: 'user', content: 'hi' }],
      undefined,
      { thinking },
    )) { void _chunk; }
    return lastBody;
  }

  it('streamChat with thinking=false: no reasoning extras on the wire', async () => {
    const body = await drainStream('qwen3:8b', false);
    expect(body).not.toHaveProperty('think');
    expect(body).not.toHaveProperty('chat_template_kwargs');
    expect(body).not.toHaveProperty('reasoning_effort');
  });

  it('streamChat with thinking=true: tolerant-host extras land on the wire', async () => {
    const body = await drainStream('qwen3:8b', true);
    expect(body).toMatchObject({
      think: true,
      chat_template_kwargs: { enable_thinking: true },
    });
    expect(body).not.toHaveProperty('reasoning_effort');
  });

  it('chat (non-streaming) also forwards thinking extras', async () => {
    lastBody = null;
    await chat(
      { ...cfg, baseUrl: capBase, providerId: 'thinking-chat-nonstream' },
      'qwen3:8b',
      [{ role: 'user', content: 'hi' }],
      { thinking: true },
    );
    expect(lastBody).toMatchObject({
      stream: false,
      think: true,
      chat_template_kwargs: { enable_thinking: true },
    });
  });
});

describe('openai-compatible-client — embeddings', () => {
  let embSrv: Server;
  let embBase: string;
  beforeAll(async () => {
    embSrv = createServer((req, res) => {
      if (req.url === '/v1/embeddings') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }, { embedding: [0.4, 0.5, 0.6] }] }));
        return;
      }
      res.writeHead(404); res.end();
    });
    await new Promise<void>((r) => embSrv.listen(0, r));
    const { port } = embSrv.address() as AddressInfo;
    embBase = `http://127.0.0.1:${port}/v1`;
  });
  afterAll(() => new Promise<void>((r) => embSrv.close(() => r())));

  it('returns embedding arrays for an array input', async () => {
    const r = await generateEmbedding({ ...cfg, baseUrl: embBase }, 'bge-m3', ['a', 'b']);
    expect(r).toEqual([[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]]);
  });
  it('wraps string input as single-element array', async () => {
    const r = await generateEmbedding({ ...cfg, baseUrl: embBase }, 'bge-m3', 'a');
    expect(r).toHaveLength(2);  // fake server returns both rows regardless
  });
});

// ─── #821: HTTP error body must reach the thrown Error ──────────────────────
// generateEmbedding used to throw `generateEmbedding HTTP 400` with the body
// discarded, so `isContextLengthError` (embedding-service.ts) could never match
// the oversized-input signal ("input length exceeds context length") and the
// oversized-batch-skip / preserve-embeddings safeguards were dead code.
describe('openai-compatible-client — generateEmbedding surfaces HTTP error body (#821)', () => {
  let errSrv: Server;
  let errBase: string;
  beforeAll(async () => {
    errSrv = createServer((req, res) => {
      if (req.url === '/v1/embeddings') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'input length exceeds the context length' } }));
        return;
      }
      res.writeHead(404); res.end();
    });
    await new Promise<void>((r) => errSrv.listen(0, r));
    const { port } = errSrv.address() as AddressInfo;
    errBase = `http://127.0.0.1:${port}/v1`;
  });
  afterAll(() => new Promise<void>((r) => errSrv.close(() => r())));

  it('includes the HTTP status and the response body in the thrown error', async () => {
    // Distinct providerId so this deliberate 400 does not trip a breaker shared
    // with the happy-path embedding tests.
    await expect(
      generateEmbedding({ ...cfg, providerId: 'emb-err-821', baseUrl: errBase }, 'bge-m3', ['too long']),
    ).rejects.toThrow(/generateEmbedding HTTP 400.*input length exceeds the context length/s);
  });
});

// ─── Queue wrapping ─────────────────────────────────────────────────────────
// Intentionally observing the llm-queue's `totalProcessed` counter rather than
// the concurrency-serialization approach from the spec: `llm-queue.ts`
// constructs its `pLimit` limiter at module import time, and `setConcurrency`
// mutates a module-level variable shared across all tests. Sequencing two
// parallel chats behind a concurrency=1 guard would leak a lower concurrency
// onto other tests via module-graph caching. Counting that `totalProcessed`
// increments after a `chat()` call directly exercises the contract (chat
// went through `enqueue`) without the brittleness of resetModules.
describe('openai-compatible-client — queue wrapping', () => {
  let qSrv: Server;
  let qBase: string;
  beforeAll(async () => {
    qSrv = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
    });
    await new Promise<void>((r) => qSrv.listen(0, r));
    const { port } = qSrv.address() as AddressInfo;
    qBase = `http://127.0.0.1:${port}/v1`;
  });
  afterAll(() => new Promise<void>((r) => qSrv.close(() => r())));

  it('non-streaming chat passes through enqueue() (increments totalProcessed)', async () => {
    const { getMetrics } = await import('./llm-queue.js');
    const before = getMetrics().totalProcessed;
    await chat({ ...cfg, baseUrl: qBase, providerId: 'queue-test' }, 'm', [{ role: 'user', content: 'hi' }]);
    expect(getMetrics().totalProcessed).toBe(before + 1);
  });

  it('streaming chat does NOT pass through enqueue() (totalProcessed unchanged)', async () => {
    const { getMetrics } = await import('./llm-queue.js');
    const sseSrv = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'x' } }] }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
    await new Promise<void>((r) => sseSrv.listen(0, r));
    const { port } = sseSrv.address() as AddressInfo;
    const sseBase = `http://127.0.0.1:${port}/v1`;
    try {
      const before = getMetrics().totalProcessed;
      for await (const _ of streamChat({ ...cfg, baseUrl: sseBase, providerId: 'stream-test' }, 'm', [{ role: 'user', content: 'hi' }])) {
        void _;
      }
      expect(getMetrics().totalProcessed).toBe(before);
    } finally {
      await new Promise<void>((r) => sseSrv.close(() => r()));
    }
  });
});

// ─── Circuit-breaker wrapping ───────────────────────────────────────────────
describe('openai-compatible-client — per-provider circuit breaker', () => {
  let failSrv: Server;
  let failBase: string;
  let hits = 0;
  beforeAll(async () => {
    failSrv = createServer((_req, res) => {
      hits++;
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'boom' }));
    });
    await new Promise<void>((r) => failSrv.listen(0, r));
    const { port } = failSrv.address() as AddressInfo;
    failBase = `http://127.0.0.1:${port}/v1`;
  });
  afterAll(() => new Promise<void>((r) => failSrv.close(() => r())));

  it('opens after 3 failures and short-circuits the 4th call without fetching', async () => {
    const providerId = 'breaker-open-' + Math.random().toString(36).slice(2);
    invalidateBreaker(providerId); // ensure a clean breaker
    hits = 0;
    const bad: ProviderConfig = { ...cfg, baseUrl: failBase, providerId };

    // 3 failing calls should all reach the server (breaker closed -> open)
    for (let i = 0; i < 3; i++) {
      await expect(chat(bad, 'm', [{ role: 'user', content: 'hi' }])).rejects.toThrow();
    }
    expect(hits).toBe(3);

    // 4th call must be short-circuited by the open breaker (no new fetch)
    await expect(chat(bad, 'm', [{ role: 'user', content: 'hi' }])).rejects.toThrow(/temporarily unavailable|CircuitBreaker/i);
    expect(hits).toBe(3);
  });

  it('keeps separate state per providerId', async () => {
    const openId = 'breaker-iso-open-' + Math.random().toString(36).slice(2);
    const freshId = 'breaker-iso-fresh-' + Math.random().toString(36).slice(2);
    invalidateBreaker(openId);
    invalidateBreaker(freshId);
    const openCfg: ProviderConfig = { ...cfg, baseUrl: failBase, providerId: openId };

    // Trip the breaker for `openId`
    for (let i = 0; i < 3; i++) {
      await expect(chat(openCfg, 'm', [{ role: 'user', content: 'hi' }])).rejects.toThrow();
    }

    // The other provider's breaker must be untouched: its fetch still hits the
    // (failing) server rather than being short-circuited.
    const hitsBefore = hits;
    const freshCfg: ProviderConfig = { ...cfg, baseUrl: failBase, providerId: freshId };
    await expect(chat(freshCfg, 'm', [{ role: 'user', content: 'hi' }])).rejects.toThrow(/chat HTTP 500/);
    expect(hits).toBeGreaterThan(hitsBefore);
  });
});

// ─── generateEmbedding passes through enqueue (parity with chat) ────────────
describe('openai-compatible-client — generateEmbedding queue wrapping', () => {
  let embQSrv: Server;
  let embQBase: string;
  beforeAll(async () => {
    embQSrv = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }));
    });
    await new Promise<void>((r) => embQSrv.listen(0, r));
    const { port } = embQSrv.address() as AddressInfo;
    embQBase = `http://127.0.0.1:${port}/v1`;
  });
  afterAll(() => new Promise<void>((r) => embQSrv.close(() => r())));

  it('generateEmbedding passes through enqueue() (increments totalProcessed)', async () => {
    const { getMetrics } = await import('./llm-queue.js');
    const before = getMetrics().totalProcessed;
    await generateEmbedding(
      { ...cfg, baseUrl: embQBase, providerId: 'embed-queue-test' },
      'bge-m3',
      'hello',
    );
    expect(getMetrics().totalProcessed).toBe(before + 1);
  });
});

// ─── Queue-full vs. breaker-open error-type disambiguation (RED #4) ─────────
// With concurrency=1 + maxQueueDepth=1, 3 concurrent calls hit different
// rejection paths:
//   - slot 1: runs
//   - slot 2: queued (pending === 1)
//   - slot 3: pending >= maxQueueDepth → QueueFullError (NOT
//     CircuitBreakerOpenError — the breaker is still CLOSED).
// This proves the two error types do not get conflated at the client-layer.
describe('openai-compatible-client — queue-full vs breaker-open disambiguation', () => {
  let slowSrv: Server;
  let slowBase: string;
  beforeAll(async () => {
    slowSrv = createServer((_req, res) => {
      // 200ms delay so concurrent calls actually contend for the single slot.
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
      }, 200);
    });
    await new Promise<void>((r) => slowSrv.listen(0, r));
    const { port } = slowSrv.address() as AddressInfo;
    slowBase = `http://127.0.0.1:${port}/v1`;
  });
  afterAll(() => new Promise<void>((r) => slowSrv.close(() => r())));

  it('rejects the overflow call with QueueFullError (not CircuitBreakerOpenError)', async () => {
    const { setConcurrency, setMaxQueueDepth, getMetrics, QueueFullError } = await import('./llm-queue.js');
    const { CircuitBreakerOpenError } = await import('../../../core/services/circuit-breaker.js');

    // Snapshot current queue config so we can restore it and avoid leaking
    // tight limits onto subsequent tests in the same file.
    const originalConcurrency = getMetrics().concurrency;
    const originalMaxQueueDepth = getMetrics().maxQueueDepth;

    setConcurrency(1);
    setMaxQueueDepth(1);

    const providerId = 'queue-full-' + Math.random().toString(36).slice(2);
    invalidateBreaker(providerId); // ensure clean/closed breaker
    const cfgOverflow: ProviderConfig = { ...cfg, baseUrl: slowBase, providerId };

    try {
      const p1 = chat(cfgOverflow, 'm', [{ role: 'user', content: '1' }]);
      const p2 = chat(cfgOverflow, 'm', [{ role: 'user', content: '2' }]);
      // p3 should reject immediately with QueueFullError (breaker still CLOSED).
      await expect(chat(cfgOverflow, 'm', [{ role: 'user', content: '3' }]))
        .rejects.toBeInstanceOf(QueueFullError);
      // Anchor the overflow identity with BOTH a positive and a negative
      // assertion. The positive half pins the concrete error class so a
      // silent rename of QueueFullError can't regress the overflow path; the
      // negative half guarantees the two error paths don't get conflated
      // (i.e. overflow is NOT misreported as breaker-open).
      await expect(chat(cfgOverflow, 'm', [{ role: 'user', content: '4' }]))
        .rejects.toBeInstanceOf(QueueFullError);
      await expect(chat(cfgOverflow, 'm', [{ role: 'user', content: '5' }]))
        .rejects.not.toBeInstanceOf(CircuitBreakerOpenError);

      // Drain the in-flight calls so afterAll can cleanly close the server.
      await Promise.all([p1, p2]);
    } finally {
      setConcurrency(originalConcurrency);
      setMaxQueueDepth(originalMaxQueueDepth);
    }
  });
});
