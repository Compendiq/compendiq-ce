/**
 * #1614 PR2 — per-arm answer generation for ADR-027's judged endpoints.
 *
 * The primary endpoint is human-judged ANSWER correctness, so each arm's
 * answers have to come out of the real ask path — `POST /api/llm/ask`, the
 * same retrieval, the same prompt, the same model resolution the product
 * uses — and reach the judge without anything that says which arm produced
 * them. Two files per run, by the ADR's "Judging protocol":
 *
 *   answers-<runId>.jsonl   one item per fixture label:
 *                           { itemId, question, answer, refused, sources, evidenceImages }
 *                           `itemId` is a random UUID. NO arm, query id, run
 *                           configuration or chunk provenance — `assertBlinded`
 *                           walks every row and refuses a key that would leak.
 *   mapping-<runId>.json    itemId → { arm, queryId }, the only place the two
 *                           are joined; its sha256 is recorded in the run's
 *                           provenance BEFORE judging starts and checked at
 *                           `--unblind`.
 *
 * `generateArmAnswers` takes the ask as a FUNCTION. The script wires it to
 * `buildApp().inject(...)` (`askThroughRoute`); the tests wire it to a stub
 * that answers in the route's SSE shape, because a mocked chat model can only
 * verify the tooling and must never produce a number anyone reads as
 * quality. Nothing in this module touches the chat request path.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { EVAL_ARMS, type EvalArm } from './arms.js';
import type { ImageFixture } from './fixture.js';

export const AnswerSourceSchema = z.object({
  pageTitle: z.string(),
  attachmentUrl: z.string().optional(),
}).strict();

/**
 * Exactly the ADR's row, `.strict()` so a field added upstream (a `kind`, a
 * `pageId`, a score) cannot ride along into the judge's file unnoticed.
 */
export const AnswerItemSchema = z.object({
  itemId: z.string().uuid(),
  question: z.string().min(1),
  answer: z.string(),
  refused: z.boolean(),
  sources: z.array(AnswerSourceSchema),
  /** The label's source images, manifest-relative — what the judge judges against. */
  evidenceImages: z.array(z.string()),
}).strict();
export type AnswerItem = z.infer<typeof AnswerItemSchema>;

export const MappingSchema = z.record(
  z.string().uuid(),
  z.object({ arm: z.enum(EVAL_ARMS), queryId: z.string().min(1) }).strict(),
);
export type Mapping = z.infer<typeof MappingSchema>;

const ProviderIdentitySchema = z.object({
  identity: z.string().min(1),
  model: z.string().min(1),
  endpoint: z.string().min(1),
});

/**
 * What one answer run was made under — the ADR's "Report provenance" for the
 * answer side. Written beside the two files; read by `--unblind`, which
 * refuses a sheet whose mapping sha no longer matches.
 */
export const AnswerRunProvenanceSchema = z.object({
  runId: z.string().min(1),
  arm: z.enum(EVAL_ARMS),
  revisionSha: z.string().regex(/^[0-9a-f]{7,40}$/),
  capturedAt: z.string().datetime(),
  hardware: z.string().min(1).nullable(),
  corpusManifestSha: z.string().min(1),
  querySetSha: z.string().regex(/^[0-9a-f]{64}$/),
  answerModel: ProviderIdentitySchema,
  /** O10 erratum: no temperature option exists on the ask path; recorded, not set. */
  temperature: z.literal('provider default'),
  ragAnswerMaxImages: z.literal(0),
  deepSearch: z.literal(false),
  /** Every RAG knob the route read, recorded rather than assumed. */
  retrieval: z.record(z.string(), z.union([z.number(), z.string(), z.boolean(), z.null()])),
  items: z.number().int().nonnegative(),
  refused: z.number().int().nonnegative(),
  answersSha256: z.string().regex(/^[0-9a-f]{64}$/),
  mappingSha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type AnswerRunProvenance = z.infer<typeof AnswerRunProvenanceSchema>;

/** What one ask came back with, whichever transport carried it. */
export interface AskOutcome {
  answer: string;
  refused: boolean;
  sources: Array<{ pageTitle: string; attachmentUrl?: string }>;
}

export type AskFn = (question: string) => Promise<AskOutcome>;

/**
 * Parse the route's SSE body: `data: {content, done}` frames accumulate the
 * answer, and the FINAL frame (`final: true`) carries `sources` and, on a
 * refusal, `refused: true`. A body without a final frame is a stream that
 * broke mid-answer and is refused rather than scored as an empty answer.
 */
export function parseAskSse(body: string): AskOutcome {
  let answer = '';
  let final: Record<string, unknown> | null = null;
  for (const line of body.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const frame = JSON.parse(line.slice('data: '.length)) as Record<string, unknown>;
    if (frame.final === true) {
      final = frame;
      continue;
    }
    if (typeof frame.content === 'string') answer += frame.content;
  }
  if (!final) throw new Error('The ask stream ended without a final frame — the answer is incomplete and is not scored');
  const sources = Array.isArray(final.sources) ? (final.sources as Array<Record<string, unknown>>) : [];
  return {
    answer,
    refused: final.refused === true,
    sources: sources.map((s) => ({
      pageTitle: typeof s.pageTitle === 'string' ? s.pageTitle : '',
      ...(typeof s.attachmentUrl === 'string' ? { attachmentUrl: s.attachmentUrl } : {}),
    })),
  };
}

/** The one request body every arm sends: the question, deep search off, no conversation. */
export function askRequestBody(question: string): { question: string; deepSearch: false } {
  return { question, deepSearch: false };
}

/** The slice of a Fastify instance the harness needs — `buildApp()`'s or a test's. */
export interface Injectable {
  inject(opts: {
    method: 'POST';
    url: string;
    headers: Record<string, string>;
    payload: unknown;
  }): Promise<{ statusCode: number; body: string }>;
}

/** An `AskFn` over `POST /api/llm/ask` on an injected app with a bearer token. */
export function askThroughRoute(app: Injectable, token: string): AskFn {
  return async (question) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/llm/ask',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: askRequestBody(question),
    });
    if (res.statusCode !== 200) {
      throw new Error(`POST /api/llm/ask answered ${res.statusCode}: ${res.body.slice(0, 300)}`);
    }
    return parseAskSse(res.body);
  };
}

/**
 * Keys that would tell a judge which arm, which query or which configuration
 * produced a row. Checked on every key at every depth, case-insensitively,
 * so a `sources[].pageId` or a nested `meta.arm` is caught as well as a
 * top-level one.
 */
export const BLINDING_FORBIDDEN_KEYS = [
  'arm', 'queryid', 'query_id', 'runid', 'run_id', 'config', 'revision', 'revisionsha', 'model',
  'provider', 'chunk', 'chunkindex', 'chunktext', 'derived', 'provenance', 'metadata', 'pageid',
  'page_id', 'score', 'similarity', 'confidence',
] as const;

/** Refuse any answers row that carries a key on the forbidden list, at any depth. */
export function assertBlinded(rows: readonly unknown[]): void {
  const forbidden = new Set<string>(BLINDING_FORBIDDEN_KEYS);
  const walk = (value: unknown, path: string, index: number): void => {
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`, index));
      return;
    }
    if (value === null || typeof value !== 'object') return;
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (forbidden.has(key.toLowerCase())) {
        throw new Error(
          `answers row ${index} carries "${path}.${key}" — a judge who can see that can see the arm. ` +
            'The answers file holds itemId, question, answer, refused, sources[{pageTitle, attachmentUrl?}] ' +
            'and evidenceImages, nothing else (ADR-027 "Judging protocol").',
        );
      }
      walk(v, `${path}.${key}`, index);
    }
  };
  rows.forEach((row, i) => walk(row, '$', i));
  for (const [i, row] of rows.entries()) {
    const parsed = AnswerItemSchema.safeParse(row);
    if (!parsed.success) {
      throw new Error(`answers row ${i} is not the ADR row shape: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
    }
  }
}

export interface GenerateArmAnswersOptions {
  arm: EvalArm;
  onProgress?: (done: number, total: number) => void;
  /** TEST SEAM: the item id source, so a test can pin the blinding walk on known ids. */
  _itemId?: () => string;
}

export interface GeneratedAnswers {
  answers: AnswerItem[];
  mapping: Mapping;
  refused: number;
}

/**
 * Ask every fixture label once and write the two artifacts' contents.
 *
 * Items come back in ITEM-ID order rather than fixture order: a judge reading
 * a file whose rows follow the fixture could pair rows across arms by
 * position. Random UUIDs sorted are a random permutation, so no seam is
 * needed for that and none is offered.
 */
export async function generateArmAnswers(
  ask: AskFn,
  fixture: ImageFixture,
  opts: GenerateArmAnswersOptions,
): Promise<GeneratedAnswers> {
  const itemId = opts._itemId ?? randomUUID;
  const answers: AnswerItem[] = [];
  const mapping: Mapping = {};
  let refused = 0;
  for (const [i, label] of fixture.labels.entries()) {
    const outcome = await ask(label.query);
    const id = itemId();
    if (mapping[id]) throw new Error(`item id ${id} was issued twice`);
    if (outcome.refused) refused++;
    answers.push({
      itemId: id,
      question: label.query,
      answer: outcome.answer,
      refused: outcome.refused,
      sources: outcome.sources.map((s) => ({
        pageTitle: s.pageTitle,
        ...(s.attachmentUrl !== undefined ? { attachmentUrl: s.attachmentUrl } : {}),
      })),
      evidenceImages: [...label.expectedImages],
    });
    mapping[id] = { arm: opts.arm, queryId: label.id };
    opts.onProgress?.(i + 1, fixture.labels.length);
  }
  answers.sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0));
  assertBlinded(answers);
  return { answers, mapping, refused };
}

export function sha256Of(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sha256File(path: string): string {
  return sha256Of(readFileSync(path));
}

/** `answers-<id>.jsonl`, one JSON object per line. */
export function serializeAnswers(answers: readonly AnswerItem[]): string {
  return answers.map((a) => JSON.stringify(a)).join('\n') + (answers.length > 0 ? '\n' : '');
}

export function answersPath(dir: string, runId: string): string {
  return join(dir, `answers-${runId}.jsonl`);
}
export function mappingPath(dir: string, runId: string): string {
  return join(dir, `mapping-${runId}.json`);
}
export function provenancePath(dir: string, runId: string): string {
  return join(dir, `provenance-${runId}.json`);
}

export interface WrittenAnswerArtifacts {
  answersPath: string;
  mappingPath: string;
  answersSha256: string;
  mappingSha256: string;
}

/** Write both files and return their hashes, computed from the bytes on disk. */
export function writeAnswerArtifacts(dir: string, runId: string, generated: GeneratedAnswers): WrittenAnswerArtifacts {
  assertBlinded(generated.answers);
  const answersFile = answersPath(dir, runId);
  const mappingFile = mappingPath(dir, runId);
  writeFileSync(answersFile, serializeAnswers(generated.answers));
  writeFileSync(mappingFile, `${JSON.stringify(generated.mapping, null, 2)}\n`);
  return {
    answersPath: answersFile,
    mappingPath: mappingFile,
    answersSha256: sha256File(answersFile),
    mappingSha256: sha256File(mappingFile),
  };
}

/** Read and validate an answers file; the blinding walk runs on every read. */
export function readAnswers(path: string): AnswerItem[] {
  const rows = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line, i) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        throw new Error(`${path}:${i + 1} is not JSON`);
      }
    });
  assertBlinded(rows);
  return rows.map((row) => AnswerItemSchema.parse(row));
}

export function readMapping(path: string): Mapping {
  return MappingSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}
