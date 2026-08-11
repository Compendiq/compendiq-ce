import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  rerank,
  normalizeRerankScores,
  RERANK_DOC_MAX_CHARS,
} from './rerank-client.js';
import { LlmHttpError, type ProviderConfig } from './openai-compatible-client.js';

// Boundary-mocked like its sibling client tests: a real local HTTP server
// (CLAUDE.md — mock at the HTTP boundary, never at the service layer).
let srv: Server;
let baseUrl: string;
let lastBody: {
  model?: string;
  query?: string;
  documents?: string[];
  top_n?: number;
} = {};
let responder: (res: import('node:http').ServerResponse) => void = () => {};

beforeAll(async () => {
  srv = createServer((req, res) => {
    if (req.url !== '/v1/rerank' || req.method !== 'POST') {
      res.writeHead(404);
      res.end();
      return;
    }
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      lastBody = JSON.parse(raw);
      responder(res);
    });
  });
  await new Promise<void>((r) => srv.listen(0, r));
  const { port } = srv.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/v1`;
});

afterAll(() => new Promise<void>((r) => srv.close(() => r())));

const cfg = (): ProviderConfig => ({
  providerId: `rr-${Math.random().toString(36).slice(2)}`, // fresh breaker per test
  baseUrl,
  apiKey: 'sekret',
  authType: 'bearer',
  verifySsl: true,
});

function respondWith(results: Array<{ index: number; relevance_score: number }>) {
  responder = (res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ results }));
  };
}

describe('rerank-client (#1104)', () => {
  it('POSTs the Cohere/Jina/TEI shape and maps results ordered by relevance', async () => {
    respondWith([
      { index: 0, relevance_score: 0.2 },
      { index: 2, relevance_score: 0.9 },
      { index: 1, relevance_score: 0.5 },
    ]);
    const out = await rerank(cfg(), 'bge-reranker-v2-m3', 'which doc?', ['a', 'b', 'c']);
    expect(lastBody.model).toBe('bge-reranker-v2-m3');
    expect(lastBody.query).toBe('which doc?');
    expect(lastBody.documents).toEqual(['a', 'b', 'c']);
    expect(lastBody.top_n).toBe(3);
    expect(out.map((r) => r.index)).toEqual([2, 1, 0]);
    expect(out.map((r) => r.relevanceScore)).toEqual([0.9, 0.5, 0.2]);
  });

  it('truncates documents to RERANK_DOC_MAX_CHARS before sending', async () => {
    respondWith([{ index: 0, relevance_score: 0.5 }]);
    await rerank(cfg(), 'm', 'q', ['x'.repeat(RERANK_DOC_MAX_CHARS + 500)]);
    expect(lastBody.documents![0]!.length).toBe(RERANK_DOC_MAX_CHARS);
  });

  it('drops malformed result entries (bad index, non-finite score)', async () => {
    respondWith([
      { index: 0, relevance_score: 0.4 },
      { index: 9, relevance_score: 0.9 }, // out of range
      { index: 1, relevance_score: Number.NaN },
    ]);
    const out = await rerank(cfg(), 'm', 'q', ['a', 'b']);
    expect(out).toEqual([{ index: 0, relevanceScore: 0.4 }]);
  });

  it('throws a typed LlmHttpError on a missing results array', async () => {
    responder = (res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ nope: true }));
    };
    await expect(rerank(cfg(), 'm', 'q', ['a'])).rejects.toBeInstanceOf(LlmHttpError);
  });

  it('throws a typed LlmHttpError carrying the provider status on a 5xx', async () => {
    responder = (res) => {
      res.writeHead(503);
      res.end('overloaded');
    };
    await expect(rerank(cfg(), 'm', 'q', ['a'])).rejects.toMatchObject({ status: 503 });
  });

  describe('normalizeRerankScores', () => {
    it('passes an in-range set through untouched', () => {
      const set = [
        { index: 0, relevanceScore: 0.1 },
        { index: 1, relevanceScore: 1 },
        { index: 2, relevanceScore: 0 },
      ];
      expect(normalizeRerankScores(set)).toEqual(set);
    });

    it('sigmoids the WHOLE set when any score is out of range — never per item', () => {
      // A raw cross-encoder emits logits. Mixing sigmoided and raw values in
      // one ranking would compare two scales; the rule is per-set.
      const out = normalizeRerankScores([
        { index: 0, relevanceScore: 4.2 },
        { index: 1, relevanceScore: 0.5 }, // in range, but the set is logits
      ]);
      expect(out[0]!.relevanceScore).toBeCloseTo(1 / (1 + Math.exp(-4.2)), 10);
      expect(out[1]!.relevanceScore).toBeCloseTo(1 / (1 + Math.exp(-0.5)), 10);
      for (const r of out) {
        expect(r.relevanceScore).toBeGreaterThanOrEqual(0);
        expect(r.relevanceScore).toBeLessThanOrEqual(1);
      }
    });
  });
});
