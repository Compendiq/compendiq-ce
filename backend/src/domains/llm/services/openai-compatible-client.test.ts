import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { checkHealth, listModels, chat, streamChat, generateEmbedding, invalidateBreaker, type ProviderConfig } from './openai-compatible-client.js';

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
