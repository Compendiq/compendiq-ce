/**
 * #1614 PR2 — per-arm answer generation for ADR-027's judged endpoints.
 *
 * The primary endpoint is human-judged ANSWER correctness, so each arm's
 * answers have to come out of the real ask path — `POST /api/llm/ask`, the
 * same retrieval, the same prompt, the same model resolution the product
 * uses — and reach the judge without anything that says which arm produced
 * them. Three files per run, by the ADR's "Judging protocol":
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
 *   provenance-<runId>.json what the run was made under, both files' sha256,
 *                           and the per-reason refusal counts — the judge
 *                           never sees this file and `--unblind` holds it to
 *                           the arm's retrieval report.
 *
 * `sources[].attachmentUrl` is the ONE arm-revealing field the ADR's row
 * shape admits: it is present only where the arm surfaced an image source
 * (A's leg hit, B's D11 citation) and never on C. It stays, because the
 * judge has to see what the answer cited; the judging protocol
 * (docs/runbooks/retrieval-eval.md "Blinding and judging") tells the judge to
 * read it as a citation and never as a reason to guess the arm.
 *
 * The asymmetry that matters, stated rather than implied: for the PRIMARY
 * B-vs-A pair the blinding holds — both arms carry the field wherever an
 * image source surfaced — but the field is absent from EVERY arm C row by
 * construction (C has no image leg and no derived chunks), so **C is the
 * separable arm**. C's correctness is a secondary endpoint judged by the
 * same person, so a judge who reads the field as an arm tell can separate
 * C's rows from A's and B's. That is a known, accepted limitation of the
 * secondary endpoints, not of the primary one (ADR-027 O10 erratum).
 *
 * `generateArmAnswers` takes the ask as a FUNCTION. The script wires it to
 * `buildApp().inject(...)` (`askThroughRoute`); the tests wire it to a stub
 * that answers in the route's SSE shape, because a mocked chat model can only
 * verify the tooling and must never produce a number anyone reads as
 * quality. Nothing in this module touches the chat request path.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { EVAL_ARMS, RetrievalKnobsSchema, type EvalArm } from './arms.js';
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
 * answer side. Written beside the two files as `provenance-<runId>.json`;
 * `judge-arms.ts --merge` reads it beside every source it merges and
 * `--unblind` reads it again and refuses a sheet whose answer runs were not
 * made under the arm reports' held-fixed configuration.
 */
export const AnswerRunProvenanceSchema = z.object({
  runId: z.string().min(1),
  arm: z.enum(EVAL_ARMS),
  revisionSha: z.string().regex(/^[0-9a-f]{7,40}$/),
  /** The exact command line that produced the run (ADR-027 "Report provenance": commands). */
  command: z.string().min(1),
  capturedAt: z.string().datetime(),
  hardware: z.string().min(1).nullable(),
  corpusManifestSha: z.string().min(1),
  querySetSha: z.string().regex(/^[0-9a-f]{64}$/),
  answerModel: ProviderIdentitySchema,
  /** O10 erratum: no temperature option exists on the ask path; recorded, not set. */
  temperature: z.literal('provider default'),
  ragAnswerMaxImages: z.literal(0),
  deepSearch: z.literal(false),
  /**
   * Every RAG knob the route read, recorded rather than assumed — the SAME
   * required set as the arm report's (`HELD_FIXED_KNOBS`), so `--unblind`
   * compares the two sides over a named set and not over whichever keys the
   * two files happen to share (review r2 findings 3–4).
   */
  retrieval: RetrievalKnobsSchema,
  items: z.number().int().nonnegative(),
  refused: z.number().int().nonnegative(),
  /**
   * The route's `refusalReason` per refused item, counted here and NEVER
   * written to the judge's file. Only protocol refusals (`no_context`,
   * `weak_match`, `image_only_context`) can appear: an infrastructure refusal
   * aborts the run (`INFRASTRUCTURE_REFUSAL_REASONS`).
   */
  refusalReasons: z.record(z.string(), z.number().int().nonnegative()),
  answersSha256: z.string().regex(/^[0-9a-f]{64}$/),
  mappingSha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type AnswerRunProvenance = z.infer<typeof AnswerRunProvenanceSchema>;

/**
 * Refusal reasons that say the SERVICE could not answer, not that the
 * knowledge base has nothing: `semantic_index_unavailable` is the embedder or
 * the index failing (llm-ask.ts). Scoring such a row as a refusal would enter
 * an outage into the primary and refusal endpoints as the arm's quality, so
 * the run aborts on the first one instead.
 */
export const INFRASTRUCTURE_REFUSAL_REASONS = ['semantic_index_unavailable'] as const;

/** What one ask came back with, whichever transport carried it. */
export interface AskOutcome {
  answer: string;
  refused: boolean;
  /** The route's `refusalReason` on a refusal; null when it answered or named none. */
  refusalReason: string | null;
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
    refusalReason: final.refused === true && typeof final.refusalReason === 'string' ? final.refusalReason : null,
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
  /** Per `refusalReason`, for the provenance file only. */
  refusalReasons: Record<string, number>;
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
  const refusalReasons: Record<string, number> = {};
  let refused = 0;
  for (const [i, label] of fixture.labels.entries()) {
    const outcome = await ask(label.query);
    if (outcome.refused && outcome.refusalReason !== null && (INFRASTRUCTURE_REFUSAL_REASONS as readonly string[]).includes(outcome.refusalReason)) {
      throw new Error(
        `Aborting arm ${opts.arm} after ${i} of ${fixture.labels.length} questions: the route refused "${label.id}" with ` +
          `${outcome.refusalReason} — an infrastructure refusal (the embedder or the semantic index failed), not the ` +
          'protocol\'s. Nothing is written: scored as a refusal it would enter an outage into the endpoints as the ' +
          'arm\'s quality. Fix the service and re-run the whole arm.',
      );
    }
    const id = itemId();
    if (mapping[id]) throw new Error(`item id ${id} was issued twice`);
    if (outcome.refused) {
      refused++;
      const reason = outcome.refusalReason ?? 'unstated';
      refusalReasons[reason] = (refusalReasons[reason] ?? 0) + 1;
    }
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
  return { answers, mapping, refused, refusalReasons };
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

/** Write `provenance-<id>.json`; the caller has already hashed both files it names. */
export function writeAnswerProvenance(dir: string, runId: string, provenance: AnswerRunProvenance): string {
  const file = provenancePath(dir, runId);
  writeFileSync(file, `${JSON.stringify(AnswerRunProvenanceSchema.parse(provenance), null, 2)}\n`);
  return file;
}

/** Parse a provenance file, naming it in the refusal — "refused if absent", never annotated. */
export function readAnswerProvenance(path: string): AnswerRunProvenance {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`${path}: ${err instanceof Error && 'code' in err && err.code === 'ENOENT' ? 'missing' : 'not JSON'} — every answer run writes provenance-<runId>.json beside its answers, and the sheet refuses a run without it`);
  }
  const parsed = AnswerRunProvenanceSchema.safeParse(json);
  if (parsed.success) return parsed.data;
  const first = parsed.error.issues[0];
  throw new Error(`${path} is not an answer-run provenance file (${first ? `${first.path.join('.') || '<root>'}: ${first.message}` : 'invalid'})`);
}

/** The run id an answers file was written under (`answers-<runId>.jsonl`), or a refusal. */
export function runIdOfAnswersFile(path: string): string {
  const match = /^answers-(.+)\.jsonl$/.exec(basename(path));
  if (!match) throw new Error(`${path} is not named answers-<runId>.jsonl, so its mapping and provenance cannot be found beside it`);
  return match[1]!;
}
