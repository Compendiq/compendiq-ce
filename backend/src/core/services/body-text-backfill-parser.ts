/**
 * Worker-thread parser of the `body_text` backfill (#1965, design r12 §3–§4).
 *
 * Runs inside a `worker_threads` worker started by `body-text-backfill.ts`.
 * It has no database access and logs nothing: it receives html/stored-text
 * pairs, classifies each with the pure predicate below and answers with the
 * outcome and, for an affected pair, the corrected text plus SHA-256 digests
 * of the exact html and stored text it classified. One request at a time;
 * every DOM and input is dropped as soon as its pair is answered.
 *
 * The predicate is exported for unit tests; production calls it only here.
 */
import { createHash } from 'node:crypto';
import { getHeapStatistics } from 'node:v8';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import he from 'he';
import { VirtualConsole } from 'jsdom';
import { collapseBodyText, htmlTextContent } from './content-converter.js';

/** Marker the job passes in `workerData`; without it this module stays inert. */
export const PARSER_WORKER_MARKER = 'compendiq-body-text-backfill-parser';

export type PairOutcome = 'current' | 'diverged' | 'affected';

export interface PairInput {
  /** Opaque key chosen by the job (`p:<pageId>`, `d:<pageId>`, `v:<uuid>`). */
  key: string;
  html: string;
  text: string;
}

export type Classification =
  | { outcome: 'current' | 'diverged' }
  | { outcome: 'affected'; corrected: string; htmlSha256: string; textSha256: string };

export type PairResult = ({ key: string } & Classification) | { key: string; outcome: 'unevaluable' };

export type ParserRequest = { type: 'classify'; requestId: number; pairs: PairInput[] };

export type ParserResponse =
  /** `heapSizeLimitMb`: the isolate's effective V8 heap limit, checked by the job. */
  | { type: 'ready'; heapSizeLimitMb: number }
  | { type: 'result'; requestId: number; results: PairResult[] };

/**
 * The frozen pre-#1940 derivation (`git show 1e908b20^:backend/src/core/
 * services/content-converter.ts`, `htmlToText`): the parser's text content
 * decoded a second time with `he.decode`, then whitespace-collapsed. Rows
 * written before #1735 hold exactly this value. Never "fix" it: it must stay
 * the old algorithm so the predicate recognises the old shape.
 */
export function preFix1e908b20(rawTextContent: string): string {
  return he.decode(rawTextContent).replace(/\s+/g, ' ').trim();
}

/** JSDOM diagnostics (CSS, script, resource errors) go nowhere. */
export function silentConsole(): VirtualConsole {
  return new VirtualConsole();
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Classify one complete pair whose html contains `&` (the job decides
 * `no_text`, `oversized` and `no_ampersand` before loading anything).
 * Order: `current` (stored equals the current derivation) → `diverged`
 * (the text content holds no `&`, or stored differs from the pre-fix
 * derivation) → `affected` (new value: the current derivation).
 */
export function classifyPair(html: string, stored: string, virtualConsole = silentConsole()): Classification {
  const raw = htmlTextContent(html, virtualConsole);
  const current = collapseBodyText(raw);
  if (stored === current) return { outcome: 'current' };
  if (!raw.includes('&') || stored !== preFix1e908b20(raw)) return { outcome: 'diverged' };
  return { outcome: 'affected', corrected: current, htmlSha256: sha256Hex(html), textSha256: sha256Hex(stored) };
}

function answer(request: ParserRequest): ParserResponse {
  const results: PairResult[] = [];
  const virtualConsole = silentConsole();
  for (let index = 0; index < request.pairs.length; index += 1) {
    const pair = request.pairs[index]!;
    let result: PairResult;
    try {
      result = { ...classifyPair(pair.html, pair.text, virtualConsole), key: pair.key };
    } catch {
      // A parse that throws is a row failure on a healthy worker (the worker
      // answered); nothing of the error leaves the thread.
      result = { key: pair.key, outcome: 'unevaluable' };
    }
    results.push(result);
    // Drop the input as soon as its pair is answered.
    request.pairs[index] = { key: pair.key, html: '', text: '' };
  }
  return { type: 'result', requestId: request.requestId, results };
}

const port = parentPort;
if (!isMainThread && port && (workerData as { marker?: unknown } | null)?.marker === PARSER_WORKER_MARKER) {
  port.on('message', (message: unknown) => {
    const request = message as Partial<ParserRequest> | null;
    if (
      !request || request.type !== 'classify' || typeof request.requestId !== 'number'
      || !Array.isArray(request.pairs)
    ) {
      // Protocol violation: answer with nothing; the job treats the silence
      // plus the exit as a run failure.
      process.exit(2);
    }
    port.postMessage(answer(request as ParserRequest));
  });
  port.postMessage({
    type: 'ready', heapSizeLimitMb: getHeapStatistics().heap_size_limit / (1024 * 1024),
  } satisfies ParserResponse);
}
