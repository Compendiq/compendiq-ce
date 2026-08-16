import { describe, it, expect } from 'vitest';
import { splitFences } from './markdown-fences.js';

/**
 * `splitFences` decides what the translator is allowed to see. Everything it
 * marks `code: false` is rewritten by a language model. So a missed fence does
 * not throw — it silently returns German where `fastify.register(...)` used to
 * be, producing a corpus that still reads as text and cannot be told apart
 * from real content by any metric downstream. These are the cases that decide
 * whether the German corpus is a measurement or noise.
 */
describe('splitFences (#1114 German eval slice)', () => {
  const rejoin = (md: string) => splitFences(md).map((p) => p.text).join('\n');

  it('round-trips a document exactly', () => {
    const md = '# Title\n\nProse.\n\n```js\nconst a = 1;\n```\n\nMore prose.\n';
    // Exact, including the trailing newline: the rejoined document is what
    // gets written back to disk, so any drift here edits the corpus.
    expect(rejoin(md)).toBe(md);
  });

  it('marks fenced blocks as code and prose as translatable', () => {
    const parts = splitFences('Prose one.\n\n```ts\ncode();\n```\n\nProse two.');
    expect(parts.filter((p) => p.code).map((p) => p.text)).toEqual(['```ts\ncode();\n```']);
    expect(parts.filter((p) => !p.code).length).toBe(2);
  });

  it('never exposes code to the translator, whatever the fence length', () => {
    // Four-backtick fences are used to show three-backtick examples inside
    // documentation about markdown — exactly what these corpora contain.
    const md = 'Prose.\n\n````md\n```js\nnested();\n```\n````\n\nEnd.';
    const code = splitFences(md).filter((p) => p.code).map((p) => p.text).join('\n');
    expect(code).toContain('nested();');
    const prose = splitFences(md).filter((p) => !p.code).map((p) => p.text).join('\n');
    expect(prose).not.toContain('nested();');
  });

  it('handles tilde fences', () => {
    const parts = splitFences('Prose.\n\n~~~python\nprint(1)\n~~~\n\nEnd.');
    expect(parts.some((p) => p.code && p.text.includes('print(1)'))).toBe(true);
  });

  it('treats an unterminated fence as code rather than prose', () => {
    // Fail CLOSED. A truncated document is common in vendored docs, and
    // sending its tail to the translator is the corrupting outcome; keeping
    // it verbatim merely leaves some English in the corpus.
    const parts = splitFences('Prose.\n\n```js\nconst unterminated = 1;');
    expect(parts.at(-1)!.code).toBe(true);
    expect(parts.at(-1)!.text).toContain('const unterminated = 1;');
  });

  it('keeps indented fences inside list items as code', () => {
    const md = 'Steps:\n\n1. Do this:\n\n   ```sh\n   npm run build\n   ```\n\nDone.';
    const code = splitFences(md).filter((p) => p.code).map((p) => p.text).join('\n');
    expect(code).toContain('npm run build');
  });

  it('leaves a document with no fences entirely translatable', () => {
    const parts = splitFences('Just prose.\n\nMore prose.');
    expect(parts.every((p) => !p.code)).toBe(true);
  });
});
