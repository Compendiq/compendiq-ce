import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  probeImageEmbedding,
  persistImageEmbeddingProbe,
  readImageEmbeddingProbe,
  IMAGE_EMBEDDING_PROBE_KEY,
} from './image-embedding-probe.js';
import { PROBE_ERROR_MAX_CHARS } from './model-capabilities.js';
import type { ProviderConfig } from './openai-compatible-client.js';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';

/**
 * A fake `/v1/embeddings` that speaks the chat-embeddings shape, at the HTTP
 * boundary (CLAUDE.md). The probe's whole job is to decide whether a provider
 * really serves that shape, so a service-layer mock would test nothing.
 */
interface Recorded {
  hasImage: boolean;
  hasText: boolean;
  /** What the request asked for as MRL truncation, or undefined when it sent none. */
  dimensions: number | undefined;
}

let srv: Server;
let baseUrl: string;
let recorded: Recorded[] = [];
let responder: (res: import('node:http').ServerResponse, rec: Recorded) => void = () => {};

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
      const body = JSON.parse(raw) as {
        messages: Array<{ role: string; content: Array<{ type: string }> }>;
        dimensions?: number;
      };
      const user = body.messages.find((m) => m.role === 'user')!;
      const rec = {
        hasImage: user.content.some((p) => p.type === 'image_url'),
        hasText: user.content.some((p) => p.type === 'text'),
        dimensions: body.dimensions,
      };
      recorded.push(rec);
      responder(res, rec);
    });
  });
  await new Promise<void>((r) => srv.listen(0, r));
  const { port } = srv.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/v1`;
});

afterAll(() => new Promise<void>((r) => srv.close(() => r())));

beforeEach(() => {
  recorded = [];
});

const cfg = (): ProviderConfig => ({
  providerId: `ip-${Math.random().toString(36).slice(2)}`, // fresh breaker per test
  baseUrl,
  apiKey: null,
  authType: 'none',
  verifySsl: true,
});

function unitVector(n: number): number[] {
  const v = new Array<number>(n).fill(0);
  v[0] = 1;
  return v;
}

function answerWith(width: number | ((rec: Recorded) => number)) {
  responder = (res, rec) => {
    const n = typeof width === 'function' ? width(rec) : width;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ embedding: unitVector(n) }] }));
  };
}

describe('probeImageEmbedding', () => {
  it('asks the endpoint for BOTH an image and a text, and reports the width', async () => {
    answerWith(2048);
    const result = await probeImageEmbedding(cfg(), 'Qwen/Qwen3-VL-Embedding-2B');
    expect(result).toEqual({ dimensions: 2048, tier: 'halfvec', error: null, reason: null });
    // Two prompts, one of them carrying an image part — capability is
    // established by asking, never by declaration.
    expect(recorded).toHaveLength(2);
    expect(recorded.filter((r) => r.hasImage)).toHaveLength(1);
  });

  it.each([
    [1024, 'vector'],
    [2000, 'vector'],
    [2048, 'halfvec'],
    [4000, 'halfvec'],
    [4096, 'unindexed'],
  ])('classifies %i dims as the %s tier', async (width, tier) => {
    answerWith(width);
    const result = await probeImageEmbedding(cfg(), 'm');
    expect(result.dimensions).toBe(width);
    expect(result.tier).toBe(tier);
  });

  /**
   * The failure this exists to catch: an endpoint that answers the image and
   * the text from two different formattings (mlx-vlm's server templates images
   * but not text) produces two spaces in one column. A width disagreement is
   * the only symptom visible from here, and it is worth refusing on.
   */
  it('refuses when the image and text widths disagree', async () => {
    answerWith((rec) => (rec.hasImage ? 2048 : 1024));
    const result = await probeImageEmbedding(cfg(), 'm');
    expect(result.dimensions).toBeNull();
    expect(result.tier).toBeNull();
    expect(result.reason).toBe('width_mismatch');
    expect(result.error).toMatch(/2048/);
    expect(result.error).toMatch(/1024/);
  });

  /**
   * The MRL truncation width (#1115, review round 2).
   *
   * `dimensions` is a per-REQUEST parameter — `--hf-overrides
   * '{"is_matryoshka": true}'` only makes vLLM accept it — so an 8B stays at
   * its native 4096 until a caller asks for less. The probe therefore has to
   * send the configured width, on BOTH calls, or it measures a request the leg
   * will never make: the column would be typed to the native width while P2's
   * embedder and P3's query embed ask for the truncated one.
   */
  describe('MRL truncation width', () => {
    it('sends the configured `dimensions` on the image call AND the text call', async () => {
      answerWith(2048);
      const result = await probeImageEmbedding(cfg(), 'm', 2048);
      expect(result).toEqual({ dimensions: 2048, tier: 'halfvec', error: null, reason: null });
      expect(recorded).toHaveLength(2);
      expect(recorded.map((r) => r.dimensions)).toEqual([2048, 2048]);
      // …and one of the two really carried the image, so this is not two text
      // calls that happen to agree.
      expect(recorded.filter((r) => r.hasImage)).toHaveLength(1);
    });

    it('sends no `dimensions` at all when no width is configured', async () => {
      answerWith(4096);
      const result = await probeImageEmbedding(cfg(), 'm');
      expect(result.dimensions).toBe(4096);
      expect(recorded.every((r) => r.dimensions === undefined)).toBe(true);
    });

    /**
     * The failure this closes: a server without the override answers 200 at its
     * native width, quietly ignoring the parameter. Recording that width would
     * type the column for a space nothing else will write into.
     */
    it('refuses when the endpoint answers at a width other than the one requested', async () => {
      answerWith(4096);
      const result = await probeImageEmbedding(cfg(), 'm', 2048);
      expect(result.dimensions).toBeNull();
      expect(result.tier).toBeNull();
      expect(result.reason).toBe('dimensions_ignored');
      expect(result.error).toMatch(/2048/);
      expect(result.error).toMatch(/4096/);
    });

    it('accepts a truncation width that lands in the unindexed tier', async () => {
      // 4001..16000 is storable and unindexable — a tier the product states on
      // the settings row rather than refusing.
      answerWith(4096);
      const result = await probeImageEmbedding(cfg(), 'm', 4096);
      expect(result).toMatchObject({ dimensions: 4096, tier: 'unindexed', reason: null });
    });
  });

  it('refuses a width outside pgvector’s range', async () => {
    answerWith(16_001);
    const result = await probeImageEmbedding(cfg(), 'm');
    expect(result.dimensions).toBeNull();
    expect(result.reason).toBe('unusable_width');
  });

  // A plain text-embedding server 400s or 422s on the `messages` array. That
  // is the misassignment the whole probe exists to refuse. 500 is deliberately
  // NOT in this list — see the `provider_error` cases below.
  it.each([400, 404, 405, 422])('classifies an HTTP %i answer as a rejected shape', async (status) => {
    responder = (res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Extra inputs are not permitted: messages' }));
    };
    const result = await probeImageEmbedding(cfg(), 'm');
    expect(result.dimensions).toBeNull();
    expect(result.reason).toBe('shape_rejected');
    expect(result.error).toContain('Extra inputs are not permitted');
  });

  /**
   * Review round 2 — the statuses that are NOT a verdict about the request's
   * shape. A correctly-served vLLM answers 503 while a model is loading, 401
   * on a bad key, 429 under load, and `vllm#33865` is an open report of
   * intermittent 5xx from exactly this endpoint. Because the probe GATES the
   * assignment, folding these into `shape_rejected` told an admin running the
   * right server that it was the wrong kind of server.
   *
   * The split is the client's own `VL_SHAPE_REFUSAL_STATUSES` boundary, so the
   * copy and the circuit-breaker behaviour cannot describe different sets.
   */
  it.each([401, 403, 429, 500, 502, 503])(
    'classifies an HTTP %i answer as a provider error, not a wrong-shape verdict',
    async (status) => {
      responder = (res) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'model is still loading' }));
      };
      const result = await probeImageEmbedding(cfg(), 'm');
      expect(result.dimensions).toBeNull();
      expect(result.reason).toBe('provider_error');
      expect(result.error).toContain('still loading');
    },
  );

  it('classifies a provider that never answered as unreachable', async () => {
    const result = await probeImageEmbedding(
      { ...cfg(), baseUrl: 'http://127.0.0.1:1/v1' },
      'm',
    );
    expect(result.dimensions).toBeNull();
    expect(result.reason).toBe('unreachable');
  });

  /**
   * #1184's rule, applied here: the provider's raw body is the evidence an
   * admin needs, and it is third-party text — bounded on the way out, and
   * reachable from admin surfaces only.
   */
  it('truncates the provider body to PROBE_ERROR_MAX_CHARS', async () => {
    responder = (res) => {
      res.writeHead(500);
      res.end('x'.repeat(PROBE_ERROR_MAX_CHARS * 4));
    };
    const result = await probeImageEmbedding(cfg(), 'm');
    expect(result.error!.length).toBeLessThanOrEqual(PROBE_ERROR_MAX_CHARS);
  });
});

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('the last probe is persisted in admin_settings', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => { await truncateAllTables(); });

  const providerId = '11111111-1111-4111-8111-111111111111';

  it('round-trips a successful probe', async () => {
    await persistImageEmbeddingProbe(providerId, 'vl-2b', {
      dimensions: 2048, tier: 'halfvec', error: null, reason: null,
    });
    const stored = await readImageEmbeddingProbe();
    expect(stored).toMatchObject({
      providerId, model: 'vl-2b', dimensions: 2048, tier: 'halfvec', error: null,
    });
    expect(stored!.probedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('round-trips a failed probe, keeping the reason out of the stored error', async () => {
    await persistImageEmbeddingProbe(providerId, 'vl-2b', {
      dimensions: null, tier: null, error: 'HTTP 422: nope', reason: 'shape_rejected',
    });
    const stored = await readImageEmbeddingProbe();
    expect(stored).toMatchObject({ dimensions: null, tier: null, error: 'HTTP 422: nope' });
  });

  it('answers null when nothing has been probed', async () => {
    expect(await readImageEmbeddingProbe()).toBeNull();
  });

  // Corrupt JSON in a settings row must not take down the panel that reads it.
  it('treats an unparseable stored value as absent', async () => {
    await query(
      `INSERT INTO admin_settings (setting_key, setting_value) VALUES ($1, $2)`,
      [IMAGE_EMBEDDING_PROBE_KEY, '{not json'],
    );
    expect(await readImageEmbeddingProbe()).toBeNull();
  });

  it('overwrites rather than accumulating', async () => {
    await persistImageEmbeddingProbe(providerId, 'a', {
      dimensions: 1024, tier: 'vector', error: null, reason: null,
    });
    await persistImageEmbeddingProbe(providerId, 'b', {
      dimensions: 2048, tier: 'halfvec', error: null, reason: null,
    });
    const rows = await query(`SELECT setting_value FROM admin_settings WHERE setting_key = $1`, [
      IMAGE_EMBEDDING_PROBE_KEY,
    ]);
    expect(rows.rows).toHaveLength(1);
    expect((await readImageEmbeddingProbe())!.model).toBe('b');
  });
});
