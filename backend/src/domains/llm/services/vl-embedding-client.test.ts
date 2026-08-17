import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  embedImagesVl,
  embedTextsVl,
  VL_DEFAULT_INSTRUCTION,
  VL_QUERY_INSTRUCTION,
} from './vl-embedding-client.js';
import { LlmHttpError, type ProviderConfig } from './openai-compatible-client.js';
import { MAX_IMAGE_BYTES } from '../../../core/services/image-validator.js';
import { getProviderBreaker } from '../../../core/services/circuit-breaker.js';
import { logger } from '../../../core/utils/logger.js';

/**
 * Boundary-mocked with a real local HTTP server, like `rerank-client.test.ts`
 * (CLAUDE.md — mock at the HTTP boundary, never at the service layer). The
 * body is asserted byte-for-byte because the two things most easily got wrong
 * here are invisible at runtime: a missing trailing empty `assistant` turn and
 * a missing `continue_final_message` both return a perfectly well-formed
 * vector, pooled at the wrong position.
 */

interface VlBody {
  model?: string;
  messages?: Array<{ role: string; content: Array<Record<string, unknown>> }>;
  encoding_format?: string;
  continue_final_message?: boolean;
  add_special_tokens?: boolean;
  dimensions?: number;
}

let srv: Server;
let baseUrl: string;
let bodies: VlBody[] = [];
let responder: (res: import('node:http').ServerResponse, n: number) => void = (res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ data: [{ embedding: [1, 0, 0, 0] }] }));
};

beforeAll(async () => {
  srv = createServer((req, res) => {
    if (req.url !== '/v1/embeddings' || req.method !== 'POST') {
      res.writeHead(404);
      res.end();
      return;
    }
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      bodies.push(JSON.parse(raw));
      responder(res, bodies.length);
    });
  });
  await new Promise<void>((r) => srv.listen(0, r));
  const { port } = srv.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/v1`;
});

afterAll(() => new Promise<void>((r) => srv.close(() => r())));

beforeEach(() => {
  bodies = [];
  responder = (res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ embedding: [1, 0, 0, 0] }] }));
  };
});

const cfg = (): ProviderConfig => ({
  providerId: `vl-${Math.random().toString(36).slice(2)}`, // fresh breaker per test
  baseUrl,
  apiKey: 'sekret',
  authType: 'bearer',
  verifySsl: true,
});

/** A 4-byte stand-in — the client never decodes pixels. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

describe('embedImagesVl — request shape (vLLM chat-embeddings extension)', () => {
  it('builds the exact body vLLM 0.14+ expects', async () => {
    await embedImagesVl(cfg(), 'Qwen/Qwen3-VL-Embedding-2B', [{ bytes: PNG, format: 'png' }]);

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toEqual({
      model: 'Qwen/Qwen3-VL-Embedding-2B',
      messages: [
        { role: 'system', content: [{ type: 'text', text: VL_DEFAULT_INSTRUCTION }] },
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: `data:image/png;base64,${PNG.toString('base64')}` },
            },
            { type: 'text', text: '' },
          ],
        },
        { role: 'assistant', content: [{ type: 'text', text: '' }] },
      ],
      encoding_format: 'float',
      continue_final_message: true,
      add_special_tokens: true,
    });
  });

  // The single easiest thing to get wrong, and it fails silently: without the
  // empty final turn plus `continue_final_message`, the prompt does not end at
  // `<|im_start|>assistant\n` and a different token is pooled.
  it('always ends the messages array with an empty assistant turn', async () => {
    await embedImagesVl(cfg(), 'm', [{ bytes: PNG, format: 'webp' }]);
    const last = bodies[0]!.messages!.at(-1)!;
    expect(last.role).toBe('assistant');
    expect(last.content).toEqual([{ type: 'text', text: '' }]);
    expect(bodies[0]!.continue_final_message).toBe(true);
    expect(bodies[0]!.add_special_tokens).toBe(true);
  });

  it.each(['png', 'jpeg', 'webp', 'gif'] as const)('data-URI-encodes a %s', async (format) => {
    await embedImagesVl(cfg(), 'm', [{ bytes: PNG, format }]);
    const part = bodies[0]!.messages![1]!.content[0] as { image_url: { url: string } };
    expect(part.image_url.url).toBe(`data:image/${format};base64,${PNG.toString('base64')}`);
  });

  // The `messages` path yields ONE embedding per request — there is no batch
  // form of it. N inputs is N requests, each through the queue and breaker.
  it('sends one request per image and preserves input order', async () => {
    let n = 0;
    responder = (res) => {
      n += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ embedding: [n, 0, 0, 0] }] }));
    };
    const out = await embedImagesVl(cfg(), 'm', [
      { bytes: Buffer.from('a'), format: 'png' },
      { bytes: Buffer.from('b'), format: 'jpeg' },
      { bytes: Buffer.from('c'), format: 'gif' },
    ]);
    expect(bodies).toHaveLength(3);
    expect(out.map((v) => v[0])).toEqual([1, 2, 3]);
  });

  it('returns an empty array without contacting the provider for no inputs', async () => {
    expect(await embedImagesVl(cfg(), 'm', [])).toEqual([]);
    expect(bodies).toHaveLength(0);
  });

  // The bytes are base64-inflated ~1.37x into a JSON body. Refusing before
  // encoding is what keeps an oversized attachment from being materialised as
  // a string at all.
  it('refuses an image over MAX_IMAGE_BYTES before encoding it', async () => {
    const huge = Buffer.alloc(MAX_IMAGE_BYTES + 1);
    await expect(
      embedImagesVl(cfg(), 'm', [{ bytes: huge, format: 'png' }]),
    ).rejects.toThrow(/MAX_IMAGE_BYTES|too large|maximum/i);
    expect(bodies).toHaveLength(0);
  });
});

describe('embedTextsVl — request shape', () => {
  it('carries the instruction as the system message and the text as the user part', async () => {
    await embedTextsVl(cfg(), 'm', ['wie viele Kammern?'], VL_QUERY_INSTRUCTION);
    expect(bodies[0]!.messages).toEqual([
      { role: 'system', content: [{ type: 'text', text: VL_QUERY_INSTRUCTION }] },
      { role: 'user', content: [{ type: 'text', text: 'wie viele Kammern?' }] },
      { role: 'assistant', content: [{ type: 'text', text: '' }] },
    ]);
  });

  // The reference embedder appends a period when the instruction does not end
  // in punctuation. Encoding it here means a custom instruction tokenises the
  // way the training data did.
  it('appends a period to an instruction that lacks terminal punctuation', async () => {
    await embedTextsVl(cfg(), 'm', ['q'], 'Retrieve relevant passages');
    const sys = bodies[0]!.messages![0]!.content[0] as { text: string };
    expect(sys.text).toBe('Retrieve relevant passages.');
  });

  it('leaves an instruction that already ends in punctuation alone', async () => {
    await embedTextsVl(cfg(), 'm', ['q'], VL_QUERY_INSTRUCTION);
    const sys = bodies[0]!.messages![0]!.content[0] as { text: string };
    expect(sys.text).toBe(VL_QUERY_INSTRUCTION);
  });

  // The reference builder substitutes the literal string "NULL" for an empty
  // instance rather than sending an empty user turn.
  it('substitutes NULL for an empty text', async () => {
    await embedTextsVl(cfg(), 'm', ['   '], VL_QUERY_INSTRUCTION);
    expect(bodies[0]!.messages![1]!.content).toEqual([{ type: 'text', text: 'NULL' }]);
  });

  it('sends one request per text', async () => {
    await embedTextsVl(cfg(), 'm', ['a', 'b'], VL_QUERY_INSTRUCTION);
    expect(bodies).toHaveLength(2);
  });
});

describe('the two instruction constants', () => {
  it('are the model-card wordings, corpus-side and query-side', () => {
    expect(VL_DEFAULT_INSTRUCTION).toBe("Represent the user's input.");
    expect(VL_QUERY_INSTRUCTION).toBe("Retrieve images or text relevant to the user's query.");
  });
});

describe('MRL truncation and unit norm', () => {
  it('passes `dimensions` through when asked', async () => {
    await embedTextsVl(cfg(), 'm', ['q'], VL_QUERY_INSTRUCTION, { dimensions: 1024 });
    expect(bodies[0]!.dimensions).toBe(1024);
  });

  it('omits `dimensions` entirely when not asked', async () => {
    await embedTextsVl(cfg(), 'm', ['q'], VL_QUERY_INSTRUCTION);
    expect(bodies[0]).not.toHaveProperty('dimensions');
  });

  // MRL truncation slices a unit vector, which is no longer unit — and vLLM
  // does not reliably re-normalise (research §2.5, UNVERIFIED upstream). Cosine
  // over un-normalised vectors is not cosine.
  it('re-normalises the returned vector when dimensions was used', async () => {
    responder = (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ embedding: [3, 4, 0, 0] }] }));
    };
    const [v] = await embedTextsVl(cfg(), 'm', ['q'], VL_QUERY_INSTRUCTION, { dimensions: 4 });
    expect(v!).toEqual([0.6, 0.8, 0, 0]);
  });

  // Without `dimensions` the checkpoint's own `2_Normalize` module has already
  // done it. A non-unit vector there means the server is not running the
  // pooling+normalise path we think it is — worth a log line, not worth
  // silently "fixing", which would hide the misconfiguration.
  //
  // The warn is asserted, not just the pass-through: it is the ONLY signal that
  // a whole index is being built from a different formatting, and without this
  // spy the `logger.warn` could be deleted with the suite still green (review
  // round 1).
  it('leaves a full-width vector untouched and warns when it is not unit norm', async () => {
    responder = (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ embedding: [3, 4, 0, 0] }] }));
    };
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    try {
      const [v] = await embedTextsVl(cfg(), 'm', ['q'], VL_QUERY_INSTRUCTION);
      expect(v!).toEqual([3, 4, 0, 0]);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ norm: 5 }),
        expect.stringMatching(/unit norm|pooling/i),
      );
    } finally {
      warn.mockRestore();
    }
  });

  // The other half of the same assertion: the tolerance has to stay meaningful,
  // or "warns on a non-unit vector" is satisfied by warning on every vector.
  it('does not warn for a unit-norm full-width vector', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    try {
      await embedTextsVl(cfg(), 'm', ['q'], VL_QUERY_INSTRUCTION);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('refuses a zero vector rather than dividing by zero', async () => {
    responder = (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ embedding: [0, 0, 0, 0] }] }));
    };
    const err = await embedTextsVl(cfg(), 'm', ['q'], VL_QUERY_INSTRUCTION, { dimensions: 4 })
      .catch((e) => e);
    // The reason lives on `.detail`, not `.message` — `llm-http-error.ts`'s
    // contract, shared with every other client here.
    expect(err).toBeInstanceOf(LlmHttpError);
    expect((err as LlmHttpError).detail).toMatch(/zero-norm/i);
  });
});

/**
 * The deadline `rerank-client.ts` already carries, for the reason its own
 * `RerankOptions.timeoutMs` doc gives — sharper here, because
 * `probeImageEmbedding` BLOCKS an admin's assignment PUT and makes two of these
 * calls in sequence. Without it, an endpoint that accepts the connection and
 * never answers holds a global `LLM_CONCURRENCY` slot for the queue's own 300s
 * timeout, twice, while the admin watches a spinner and no Fastify
 * `requestTimeout` is configured to cut it short.
 */
describe('the per-call deadline', () => {
  it('aborts a call against an endpoint that never answers', async () => {
    // Its own server: this one is deliberately left hanging, and the shared
    // one is reused by every case above.
    const stalled = createServer(() => {
      /* accepts the request and never writes a response */
    });
    await new Promise<void>((r) => stalled.listen(0, '127.0.0.1', r));
    const { port } = stalled.address() as AddressInfo;
    const startedAt = Date.now();
    try {
      await expect(
        embedTextsVl(
          { ...cfg(), baseUrl: `http://127.0.0.1:${port}/v1` },
          'm',
          ['q'],
          VL_QUERY_INSTRUCTION,
          { timeoutMs: 150 },
        ),
      ).rejects.toThrow();
      // Without the option plumbed through, this call runs to the queue's own
      // 300s timeout and the assertion above is never reached.
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    } finally {
      stalled.closeAllConnections();
      await new Promise<void>((r) => stalled.close(() => r()));
    }
  }, 10_000);

  it('sends no deadline when none is asked for', async () => {
    // The budget is the caller's decision — a batch writer and an admin's
    // blocking probe do not want the same one, and a default here would make
    // the wrong one invisible.
    await embedTextsVl(cfg(), 'm', ['q'], VL_QUERY_INSTRUCTION);
    expect(bodies).toHaveLength(1);
  });
});

describe('error mapping', () => {
  it('throws a typed LlmHttpError carrying the provider body', async () => {
    responder = (res) => {
      res.writeHead(422, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'messages: extra fields not permitted' }));
    };
    const err = await embedTextsVl(cfg(), 'm', ['q'], VL_QUERY_INSTRUCTION).catch((e) => e);
    expect(err).toBeInstanceOf(LlmHttpError);
    expect((err as LlmHttpError).status).toBe(422);
    expect((err as LlmHttpError).detail).toContain('extra fields not permitted');
  });

  // Same rule the text embeddings client applies (#867) and the one
  // `rerank-client.ts` settled for the same reason (#1267 verification, 2): a
  // deterministic client-side status proves the provider is reachable, so it
  // must not count against the per-provider breaker shared with chat and
  // embeddings. 422 is in the set because it is what a plain text-embedding
  // server answers the `messages` body with — i.e. the misassignment case.
  it.each([
    [400, true],
    [404, true],
    [405, true],
    [422, true],
    [500, false],
    [503, false],
  ])('status %i bypasses the breaker: %s', async (status, bypass) => {
    responder = (res) => {
      res.writeHead(status);
      res.end('nope');
    };
    const err = await embedTextsVl(cfg(), 'm', ['q'], VL_QUERY_INSTRUCTION).catch((e) => e);
    expect((err as LlmHttpError).bypassCircuitBreaker).toBe(bypass);
  });

  /**
   * The consequence, stated as behaviour rather than as a flag.
   *
   * The first caller to meet a misassignment is `probeImageEmbedding`, and it
   * runs through this same per-provider breaker. If a shape refusal counted as
   * a failure, an admin fumbling three probes against the DEFAULT provider —
   * the exact mistake the non-inheriting rule exists to catch — would open that
   * provider's breaker and 503 every user's chat for 30 seconds.
   */
  it('leaves the shared breaker CLOSED after three consecutive shape refusals', async () => {
    responder = (res) => {
      res.writeHead(422, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ detail: 'Extra inputs are not permitted: messages' }));
    };
    const provider = cfg();
    for (let i = 0; i < 3; i += 1) {
      await embedTextsVl(provider, 'm', ['q'], VL_QUERY_INSTRUCTION).catch(() => {});
    }
    expect(getProviderBreaker(provider.providerId).getStatus().state).toBe('CLOSED');
  });

  it('rejects a response that carries no embedding', async () => {
    responder = (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
    };
    await expect(embedTextsVl(cfg(), 'm', ['q'], VL_QUERY_INSTRUCTION)).rejects.toThrow(
      /embedding/i,
    );
  });

  it('sends the bearer header the provider config asks for', async () => {
    const headers: string[] = [];
    const probe = createServer((req, res) => {
      headers.push(String(req.headers.authorization));
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ embedding: [1, 0] }] }));
      });
    });
    await new Promise<void>((r) => probe.listen(0, r));
    const { port } = probe.address() as AddressInfo;
    try {
      await embedTextsVl(
        { ...cfg(), baseUrl: `http://127.0.0.1:${port}/v1` },
        'm',
        ['q'],
        VL_QUERY_INSTRUCTION,
      );
      expect(headers[0]).toBe('Bearer sekret');
    } finally {
      await new Promise<void>((r) => probe.close(() => r()));
    }
  });
});

describe('the non-support list is recorded in the module, not in tribal memory', () => {
  it('names every server that cannot serve this shape', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./vl-embedding-client.ts', import.meta.url), 'utf8');
    for (const needle of ['TEI', 'LM Studio', 'llama-server', 'vLLM']) {
      expect(src).toContain(needle);
    }
  });
});
