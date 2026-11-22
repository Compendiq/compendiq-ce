/**
 * #1965 body_text backfill: the pure predicate, the frozen pre-fix
 * derivation, the silent console and the parser worker protocol (design r12
 * §3–§4). Worker tests start real `worker_threads` workers; nothing sleeps.
 */
import { execFileSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import he from 'he';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PARSER_WORKER_MARKER,
  classifyPair,
  preFix1e908b20,
  sha256Hex,
} from './body-text-backfill-parser.js';
import {
  BODY_TEXT_BACKFILL_LIMITS,
  BodyTextBackfillParser,
  armBodyTextBackfill,
  bodyTextBackfillParserEntry,
  stopBodyTextBackfill,
  type BodyTextBackfillLimits,
} from './body-text-backfill.js';
import { htmlToText } from './content-converter.js';

const limits = (overrides: Partial<BodyTextBackfillLimits> = {}): BodyTextBackfillLimits => ({
  ...BODY_TEXT_BACKFILL_LIMITS, ...overrides,
});

/** A worker entry as an ES module `data:` URL (a test seam for broken workers). */
const moduleUrl = (source: string): URL => new URL(`data:text/javascript,${encodeURIComponent(source)}`);

const parsers: BodyTextBackfillParser[] = [];
function parser(overrides: Partial<BodyTextBackfillLimits> = {}, entry?: URL): BodyTextBackfillParser {
  const created = new BodyTextBackfillParser(limits(overrides), entry);
  parsers.push(created);
  return created;
}

afterEach(() => {
  for (const created of parsers.splice(0)) created.terminate();
  armBodyTextBackfill();
});

describe('predicate (§3)', () => {
  it('classifies in order current → diverged → affected, with the current derivation as the new value', () => {
    // current wins even though the raw text has no `&` (which alone would be diverged).
    expect(classifyPair('<p>plain</p>', 'plain')).toEqual({ outcome: 'current' });
    // raw text without `&`: nothing can have been decoded twice.
    expect(classifyPair('<p>plain &lt;b&gt;</p>', 'other')).toEqual({ outcome: 'diverged' });
    // stored is neither current nor the pre-fix shape (manually diverged / Notion-joined).
    expect(classifyPair('<p>Use &amp;lt;br&amp;gt;</p>', 'Use\n\n<br>')).toEqual({ outcome: 'diverged' });
    const affected = classifyPair('<p>Use &amp;lt;br&amp;gt;</p>', 'Use <br>');
    expect(affected).toEqual({
      outcome: 'affected',
      corrected: 'Use &lt;br&gt;',
      htmlSha256: sha256Hex('<p>Use &amp;lt;br&amp;gt;</p>'),
      textSha256: sha256Hex('Use <br>'),
    });
    expect(affected.outcome === 'affected' && affected.corrected).toBe(htmlToText('<p>Use &amp;lt;br&amp;gt;</p>'));
  });

  it('treats an already-current row as current even when the old derivation would also match it', () => {
    // `&amp;` decoded once is `&`; decoding `&` again changes nothing → current.
    expect(classifyPair('<p>A &amp; B</p>', 'A & B')).toEqual({ outcome: 'current' });
  });

  it('matches only the exact pre-fix output, whitespace collapse included', () => {
    expect(classifyPair('<p> Use\t&amp;amp;  x </p>', 'Use & x').outcome).toBe('affected');
    expect(classifyPair('<p> Use\t&amp;amp;  x </p>', 'Use &  x').outcome).toBe('diverged');
  });
});

describe('frozen pre-fix derivation (1e908b20^)', () => {
  it('is exactly the pre-#1940 htmlToText: he.decode(textContent) then whitespace collapse', () => {
    // Verbatim body of htmlToText at 1e908b20^ (content-converter.ts:3882-3886).
    const historical = (html: string) => {
      const dom = new JSDOM(`<body>${html}</body>`, { contentType: 'text/html' });
      const text = dom.window.document.body.textContent ?? '';
      return he.decode(text).replace(/\s+/g, ' ').trim();
    };
    const corpus = [
      '<p>Use &amp;lt;br&amp;gt;</p>', '<p>Write &amp;amp; for an ampersand</p>', '<p>&amp;#60; &amp;nbsp; x</p>',
      '\n <p> a &amp;\tb </p>\n', '<p>see https://x.test/?id=1&amp;reg=eu&amp;copy=2</p>', '<p>plain</p>', '',
    ];
    for (const html of corpus) {
      const raw = new JSDOM(`<body>${html}</body>`, { contentType: 'text/html' }).window.document.body.textContent ?? '';
      expect(preFix1e908b20(raw)).toBe(historical(html));
    }
    expect(preFix1e908b20('Use &lt;br&gt;')).toBe('Use <br>');
    expect(preFix1e908b20('see ?id=1&reg=eu&copy=2')).toBe('see ?id=1®=eu©=2');
  });

  it('is the algorithm recorded at commit 1e908b20^ in this repository', () => {
    let source: string;
    try {
      source = execFileSync('git', ['show', '1e908b20^:backend/src/core/services/content-converter.ts'], {
        encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      // A shallow clone without that commit cannot check provenance.
      return;
    }
    expect(source).toContain("return he.decode(text).replace(/\\s+/g, ' ').trim();");
  });
});

describe('silent console', () => {
  const canary = 'zz-private-canary-1965';
  const html = `<style>@import "${canary}";</style><p>Use &amp;lt;br&amp;gt;</p>`;
  // The style text is part of textContent; this is the pre-fix stored value.
  const stored = `@import "${canary}";Use <br>`;

  it('control: the default JSDOM console of htmlToText does forward the @import diagnostic', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      htmlToText(html);
      expect(errors.mock.calls.flat().map(String).join('\n')).toContain(canary);
    } finally {
      errors.mockRestore();
    }
  });

  it('the predicate parse forwards nothing to console or stderr', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const stderr = vi.spyOn(process.stderr, 'write');
    try {
      expect(classifyPair(html, stored).outcome).toBe('affected');
      expect(errors).not.toHaveBeenCalled();
      expect(warns).not.toHaveBeenCalled();
      expect(stderr.mock.calls.flat().map(String).join('')).not.toContain(canary);
    } finally {
      errors.mockRestore();
      warns.mockRestore();
      stderr.mockRestore();
    }
  });

  it('the worker thread writes nothing to its stdout or stderr while classifying the canary pair', async () => {
    const worker = new Worker(bodyTextBackfillParserEntry(), {
      workerData: { marker: PARSER_WORKER_MARKER }, execArgv: ['--import', 'tsx'], stdout: true, stderr: true,
    });
    let output = '';
    worker.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    worker.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    const ended = Promise.all([
      new Promise((resolve) => worker.stdout.on('end', resolve)),
      new Promise((resolve) => worker.stderr.on('end', resolve)),
    ]);
    const answers: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      worker.on('error', reject);
      worker.on('message', (message: { type: string }) => {
        answers.push(message);
        if (message.type === 'ready') {
          worker.postMessage({ type: 'classify', requestId: 1, pairs: [{ key: 'k', html, text: stored }] });
        } else {
          resolve();
        }
      });
    });
    await worker.terminate();
    await ended;
    expect(answers[1]).toMatchObject({ type: 'result', requestId: 1, results: [{ key: 'k', outcome: 'affected' }] });
    expect(output).not.toContain(canary);
    expect(output).toBe('');
  });
});

describe('parser worker (§4)', () => {
  it('passes the ready + canary handshake, then answers an ordinary request pair by pair', async () => {
    const client = parser();
    const results = await client.classify([
      { key: 'a', html: '<p>plain</p>', text: 'plain' },
      { key: 'b', html: '<p>Use &amp;lt;br&amp;gt;</p>', text: 'Use <br>' },
      { key: 'c', html: '<p>Use &amp;lt;br&amp;gt;</p>', text: 'something else' },
    ]);
    expect(results).toEqual([
      { key: 'a', outcome: 'current' },
      {
        key: 'b', outcome: 'affected', corrected: 'Use &lt;br&gt;',
        htmlSha256: sha256Hex('<p>Use &amp;lt;br&amp;gt;</p>'), textSha256: sha256Hex('Use <br>'),
      },
      { key: 'c', outcome: 'diverged' },
    ]);
  });

  it('the handshake has its own deadline: a worker that never posts ready ends the run (parser_unavailable)', async () => {
    const client = parser({ handshakeTimeoutMs: 300 }, moduleUrl('setInterval(() => {}, 1000);'));
    await expect(client.classify([{ key: 'a', html: '<p>&amp;</p>', text: '&' }]))
      .rejects.toMatchObject({ name: 'RunInterrupted', code: 'parser_unavailable' });
  });

  it('an import failure ends the run without classifying (parser_unavailable)', async () => {
    const client = parser({}, moduleUrl('throw new Error("import failed");'));
    await expect(client.classify([{ key: 'a', html: '<p>&amp;</p>', text: '&' }]))
      .rejects.toMatchObject({ name: 'RunInterrupted', code: 'parser_unavailable' });
  });

  it('a missing worker file ends the run without classifying (parser_unavailable)', async () => {
    const client = parser({}, new URL('./does-not-exist-body-text-parser.mjs', import.meta.url));
    await expect(client.classify([{ key: 'a', html: '<p>&amp;</p>', text: '&' }]))
      .rejects.toMatchObject({ name: 'RunInterrupted', code: 'parser_unavailable' });
  });

  it('an exit during the handshake ends the run (parser_unavailable)', async () => {
    const client = parser({}, moduleUrl('process.exit(0);'));
    await expect(client.classify([{ key: 'a', html: '<p>&amp;</p>', text: '&' }]))
      .rejects.toMatchObject({ name: 'RunInterrupted', code: 'parser_unavailable' });
  });

  it('a wrong canary answer ends the run (parser_unavailable)', async () => {
    const client = parser({}, moduleUrl(`
      import { parentPort } from 'node:worker_threads';
      parentPort.postMessage({ type: 'ready' });
      parentPort.on('message', (m) => parentPort.postMessage({ type: 'result', requestId: m.requestId,
        results: m.pairs.map((p) => ({ key: p.key, outcome: 'current' })) }));
    `));
    await expect(client.classify([{ key: 'a', html: '<p>&amp;</p>', text: '&' }]))
      .rejects.toMatchObject({ name: 'RunInterrupted', code: 'parser_unavailable' });
  });

  it('a protocol error after the canary ends the run (parser_protocol), never classifying the rows', async () => {
    const client = parser({}, moduleUrl(`
      import { createHash } from 'node:crypto';
      import { parentPort } from 'node:worker_threads';
      const sha = (v) => createHash('sha256').update(v, 'utf8').digest('hex');
      parentPort.postMessage({ type: 'ready' });
      parentPort.on('message', (m) => {
        if (m.pairs[0].key === 'canary') {
          parentPort.postMessage({ type: 'result', requestId: m.requestId, results: [{ key: 'canary',
            outcome: 'affected', corrected: '&lt;br&gt;', htmlSha256: sha(m.pairs[0].html), textSha256: sha(m.pairs[0].text) }] });
        } else {
          parentPort.postMessage({ type: 'result', requestId: m.requestId + 7, results: [] });
        }
      });
    `));
    await expect(client.classify([{ key: 'a', html: '<p>&amp;</p>', text: '&' }]))
      .rejects.toMatchObject({ name: 'RunInterrupted', code: 'parser_protocol' });
  });

  it('a stop during the handshake ends it at once', async () => {
    const client = parser({}, moduleUrl('setInterval(() => {}, 1000);'));
    const pending = client.classify([{ key: 'a', html: '<p>&amp;</p>', text: '&' }]);
    const settled = expect(pending).rejects.toMatchObject({ name: 'StopSignal' });
    await stopBodyTextBackfill();
    client.terminate();
    await settled;
  });

  it('a request over the time limit fails, and the next request is served by a fresh worker that passed the canary', async () => {
    // A real slow parse: about two hundred thousand elements against a 20 ms limit.
    const slow = `<div>${'<span>&amp;lt;x&amp;gt;</span>'.repeat(200_000)}</div>`;
    const client = parser({ requestTimeoutMs: 20 });
    expect(await client.classify([{ key: 'slow', html: slow, text: 'x' }])).toBeNull();
    const fast = parser();
    expect(await fast.classify([{ key: 'ok', html: '<p>plain</p>', text: 'plain' }])).toEqual([{ key: 'ok', outcome: 'current' }]);
  });

  it('a real allocation beyond the isolate limit fails that request only; the parent stays alive and the next pair is parsed by a fresh healthy worker', async () => {
    const client = parser({ parserOldGenerationMb: 64, parserYoungGenerationMb: 16 });
    const huge = `<p>${'<b>&amp;</b>'.repeat(400_000)}</p>`;
    expect(await client.classify([{ key: 'huge', html: huge, text: '&' }])).toBeNull();
    expect(await client.classify([{ key: 'next', html: '<p>Use &amp;lt;br&amp;gt;</p>', text: 'Use <br>' }]))
      .toMatchObject([{ key: 'next', outcome: 'affected', corrected: 'Use &lt;br&gt;' }]);
  });

  it('stop terminates the worker during a request and it is not restarted', async () => {
    const client = parser();
    expect(await client.classify([{ key: 'warm', html: '<p>plain</p>', text: 'plain' }])).not.toBeNull();
    const slow = `<div>${'<span>&amp;lt;x&amp;gt;</span>'.repeat(200_000)}</div>`;
    const pending = client.classify([{ key: 'slow', html: slow, text: 'x' }]);
    const settled = expect(pending).rejects.toMatchObject({ name: 'StopSignal' });
    await stopBodyTextBackfill();
    client.terminate();
    await settled;
    await expect(client.classify([{ key: 'again', html: '<p>plain</p>', text: 'plain' }]))
      .rejects.toMatchObject({ name: 'StopSignal' });
  });

  it('a large pair (a column above 4 MiB) is answered on its own request', async () => {
    const big = `<p>${'Use &amp;lt;br&amp;gt; '.repeat(260_000)}</p>`;
    expect(big.length).toBeGreaterThan(4 * 1024 * 1024);
    const text = Array.from({ length: 260_000 }, () => 'Use <br>').join(' ');
    const client = parser();
    const [result] = (await client.classify([{ key: 'big', html: big, text }]))!;
    expect(result).toMatchObject({ key: 'big', outcome: 'affected' });
  });
});
