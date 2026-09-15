import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';
import {
  AnswerItemSchema,
  BLINDING_FORBIDDEN_KEYS,
  askRequestBody,
  askThroughRoute,
  assertBlinded,
  generateArmAnswers,
  parseAskSse,
  readAnswers,
  readMapping,
  sha256File,
  writeAnswerArtifacts,
  type AskFn,
} from './answers.js';
import type { ImageFixture, ImageFixtureLabel } from './fixture.js';

/**
 * #1614 PR2 — the answer harness against a STUBBED ask boundary. The stub
 * speaks the route's own SSE shape (`data: {content, done}` frames, then a
 * `final: true` frame with `sources` and, on a refusal, `refused: true`), so
 * what is verified is the harness's parsing, its blinding and its files —
 * never an answer's quality, which needs the real model.
 */

function label(over: Partial<ImageFixtureLabel> & { id: string; query: string }): ImageFixtureLabel {
  return { lang: 'de', expectedFiles: ['page-1.md'], expectedImages: ['images/page-1__1.png'], style: 'image', rationale: '', ...over };
}

const fixture: ImageFixture = {
  corpusManifestSha: 'test',
  labeledBy: 'test',
  notUsable: [],
  labels: [
    label({ id: 'img-01-a', query: 'Was zeigt das erste Bild?' }),
    label({ id: 'img-01-b', query: 'Welche Farbe hat das Diagramm?', lang: 'en' }),
    label({ id: 'neg-01', query: 'Frage ohne Bild', expectedImages: [], style: 'image-negative' }),
  ],
};

const sse = (frames: unknown[]): string => frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('');

describe('parseAskSse', () => {
  it('accumulates content frames and reads sources and the refusal off the final frame', () => {
    const answered = parseAskSse(sse([
      { content: 'Das Bild ', done: false },
      { content: 'zeigt einen Turm.', done: true },
      { done: true, final: true, conversationId: null, sources: [{ kind: 'page', pageId: 4, pageTitle: 'Turm', score: 0.9 }, { kind: 'image', pageTitle: 'Turm', attachmentUrl: '/api/x.png', pageId: 4 }] },
    ]));
    expect(answered).toEqual({
      answer: 'Das Bild zeigt einen Turm.',
      refused: false,
      sources: [{ pageTitle: 'Turm' }, { pageTitle: 'Turm', attachmentUrl: '/api/x.png' }],
    });
    const refused = parseAskSse(sse([
      { content: 'I do not have enough information.', done: true },
      { refused: true, refusalReason: 'low_confidence', confidence: 0.1, done: true, final: true, sources: [] },
    ]));
    expect(refused.refused).toBe(true);
    expect(refused.answer).toContain('not have enough');
  });

  it('refuses a stream that ended without a final frame rather than scoring an empty answer', () => {
    expect(() => parseAskSse(sse([{ content: 'half an', done: false }]))).toThrow(/without a final frame/);
  });
});

describe('askThroughRoute', () => {
  it('posts the question with deepSearch false and no conversation, with the bearer token', async () => {
    const app = Fastify({ logger: false });
    const seen: Array<{ body: unknown; auth: string | undefined }> = [];
    app.post('/api/llm/ask', async (request, reply) => {
      seen.push({ body: request.body, auth: request.headers.authorization });
      reply.header('content-type', 'text/event-stream');
      return sse([{ content: 'ok', done: true }, { done: true, final: true, sources: [] }]);
    });
    await app.ready();
    try {
      const ask = askThroughRoute(app, 'tok');
      await expect(ask('Frage?')).resolves.toEqual({ answer: 'ok', refused: false, sources: [] });
      expect(seen).toEqual([{ body: { question: 'Frage?', deepSearch: false }, auth: 'Bearer tok' }]);
      expect(askRequestBody('x')).not.toHaveProperty('conversationId');
    } finally {
      await app.close();
    }
  });

  it('refuses a non-200 answer with the status in the message', async () => {
    const app = Fastify({ logger: false });
    app.post('/api/llm/ask', async (_request, reply) => reply.code(503).send({ error: 'queue full' }));
    await app.ready();
    try {
      await expect(askThroughRoute(app, 'tok')('Frage?')).rejects.toThrow(/answered 503/);
    } finally {
      await app.close();
    }
  });
});

describe('generateArmAnswers — the blinding invariant', () => {
  const ask: AskFn = async (question) => ({
    answer: `Antwort auf: ${question}`,
    refused: question.includes('ohne'),
    sources: [{ pageTitle: 'Seite 1' }, { pageTitle: 'Seite 1', attachmentUrl: '/api/attachments/1/x.png' }],
  });

  it('writes rows with exactly the ADR fields, and the arm and query id ONLY in the mapping', async () => {
    const { answers, mapping, refused } = await generateArmAnswers(ask, fixture, { arm: 'A' });
    expect(answers).toHaveLength(3);
    expect(refused).toBe(1);
    for (const row of answers) {
      expect(Object.keys(row).sort()).toEqual(['answer', 'evidenceImages', 'itemId', 'question', 'refused', 'sources']);
      expect(AnswerItemSchema.safeParse(row).success).toBe(true);
      expect(mapping[row.itemId]).toBeDefined();
      expect(mapping[row.itemId]!.arm).toBe('A');
    }
    // Structural walk: no key at any depth is on the forbidden list.
    const keys = new Set<string>();
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.add(k.toLowerCase()); walk(x); }
    };
    walk(answers);
    for (const forbidden of BLINDING_FORBIDDEN_KEYS) expect(keys.has(forbidden), forbidden).toBe(false);
    // The mapping round-trips every fixture label exactly once.
    expect(Object.values(mapping).map((m) => m.queryId).sort()).toEqual(['img-01-a', 'img-01-b', 'neg-01']);
    // Refusal frames map to `refused: true` on the row.
    const negative = answers.find((a) => a.question === 'Frage ohne Bild')!;
    expect(negative.refused).toBe(true);
    // Evidence images are the label's source images — identical across arms, so they carry no arm.
    expect(answers.find((a) => a.question === 'Was zeigt das erste Bild?')!.evidenceImages).toEqual(['images/page-1__1.png']);
    expect(negative.evidenceImages).toEqual([]);
  });

  it('orders rows by item id, not by fixture order, so position cannot pair rows across arms', async () => {
    let n = 0;
    const ids = ['c0000000-0000-4000-8000-000000000000', 'a0000000-0000-4000-8000-000000000000', 'b0000000-0000-4000-8000-000000000000'];
    const { answers } = await generateArmAnswers(ask, fixture, { arm: 'C', _itemId: () => ids[n++]! });
    expect(answers.map((a) => a.itemId)).toEqual([ids[1], ids[2], ids[0]]);
  });
});

describe('assertBlinded', () => {
  const row = { itemId: 'a0000000-0000-4000-8000-000000000000', question: 'q', answer: 'a', refused: false, sources: [], evidenceImages: [] };

  it('refuses a forbidden key at the top level and nested inside a source', () => {
    expect(() => assertBlinded([{ ...row, arm: 'A' }])).toThrow(/\$\.arm/);
    expect(() => assertBlinded([{ ...row, sources: [{ pageTitle: 't', pageId: 3 }] }])).toThrow(/sources\[0\]\.pageId/);
    expect(() => assertBlinded([{ ...row, meta: { queryId: 'x' } }])).toThrow(/meta\.queryId/);
  });

  it('refuses a row outside the ADR shape even when no key is on the list', () => {
    expect(() => assertBlinded([{ ...row, extra: 1 }])).toThrow(/not the ADR row shape/);
  });
});

describe('writeAnswerArtifacts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arm-answers-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('writes the two files and hashes the bytes on disk', async () => {
    const generated = await generateArmAnswers(async (q) => ({ answer: q, refused: false, sources: [] }), fixture, { arm: 'C' });
    const written = writeAnswerArtifacts(dir, 'run-1', generated);
    expect(written.answersPath).toBe(join(dir, 'answers-run-1.jsonl'));
    expect(written.mappingPath).toBe(join(dir, 'mapping-run-1.json'));
    expect(written.answersSha256).toBe(sha256File(written.answersPath));
    expect(written.mappingSha256).toBe(sha256File(written.mappingPath));
    expect(readFileSync(written.answersPath, 'utf8').trim().split('\n')).toHaveLength(3);
    expect(readAnswers(written.answersPath)).toEqual(generated.answers);
    expect(readMapping(written.mappingPath)).toEqual(generated.mapping);
  });
});
