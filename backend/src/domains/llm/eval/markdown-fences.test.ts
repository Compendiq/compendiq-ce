import { describe, it, expect } from 'vitest';
import { splitFences, assertUsableTranslation, chunkProse } from './markdown-fences.js';

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

describe('assertUsableTranslation (#1114)', () => {
  it('rejects empty output for non-empty input', () => {
    expect(() => assertUsableTranslation('Some prose.', '')).toThrow(/EMPTY content/);
  });

  it('rejects whitespace-only output, which is empty in every way that matters', () => {
    expect(() => assertUsableTranslation('Some prose.', '   \n  ')).toThrow(/EMPTY content/);
  });

  it('names the reasoning-model cause, because that is what actually happens', () => {
    // The failure arrives as a clean 200 with content:"" — nothing in the
    // response says "reasoning model", so the error message has to.
    expect(() => assertUsableTranslation('x', '')).toThrow(/reasoning model/);
  });

  it('allows empty output for empty input', () => {
    // Consecutive fences leave genuinely empty prose segments between them.
    expect(() => assertUsableTranslation('', '')).not.toThrow();
    expect(() => assertUsableTranslation('  \n ', '')).not.toThrow();
  });

  it('allows a normal translation', () => {
    expect(() => assertUsableTranslation('The plugin registers a hook.', 'Das Plugin registriert einen Hook.')).not.toThrow();
  });
});

describe('chunkProse (#1114)', () => {
  it('reconstructs the input exactly', () => {
    // The property everything else rests on: chunking must not be able to
    // alter a document that survives translation unchanged.
    const text = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} with some words in it.`).join('\n\n');
    expect(chunkProse(text, 200).join('\n')).toBe(text);
  });

  it('returns a short run untouched, as a single chunk', () => {
    expect(chunkProse('Short.', 1000)).toEqual(['Short.']);
  });

  it('actually splits a run that exceeds the budget', () => {
    const text = Array.from({ length: 30 }, (_, i) => `Para ${i}.`).join('\n\n');
    const chunks = chunkProse(text, 50);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('\n')).toBe(text);
  });

  it('splits at blank lines, never mid-paragraph', () => {
    // A cut mid-sentence hands the translator half a thought; the output is
    // visibly worse and there is no way to detect it afterwards.
    const text = 'Aaa aaa aaa.\n\nBbb bbb bbb.\n\nCcc ccc ccc.';
    for (const chunk of chunkProse(text, 20)) {
      expect(chunk.startsWith(' ')).toBe(false);
      // Every chunk is whole paragraphs, so it never ends mid-sentence.
      expect(chunk.trim().endsWith('.')).toBe(true);
    }
  });

  it('emits an over-long single paragraph whole rather than cutting it', () => {
    // A too-large request that gets a real error beats silently mangled prose.
    const huge = 'x'.repeat(5000);
    expect(chunkProse(huge, 100)).toEqual([huge]);
  });

  it('handles the 47KB shape that hung the first run', () => {
    const text = Array.from({ length: 800 }, (_, i) => `Line ${i} of a very long ecosystem listing.`).join('\n\n');
    const chunks = chunkProse(text, 4000);
    expect(chunks.every((c) => c.length <= 4200)).toBe(true);
    expect(chunks.join('\n')).toBe(text);
  });
});

describe('chunkProse — list-aware splitting (#1114)', () => {
  it('splits a long unbroken bulleted list, which paragraph rules cannot', () => {
    // The real case: a 47KB plugin catalogue with no blank lines anywhere.
    // Under paragraph-only splitting this stayed one chunk, and an 8KB chunk
    // is the size that makes a translator summarise instead of translate.
    const list = Array.from({ length: 400 }, (_, i) => `- [plugin-${i}](https://example.com/${i}) does a thing.`).join('\n');
    const chunks = chunkProse(list, 2500);
    expect(chunks.length).toBeGreaterThan(5);
    expect(chunks.join('\n')).toBe(list);
    expect(chunks.every((c) => c.length <= 2600)).toBe(true);
  });

  it('still refuses to cut a long PROSE paragraph mid-sentence', () => {
    // Hard-wrapped prose has no safe line boundary, so the old rule stands.
    const prose = Array.from({ length: 200 }, () => 'some continuing prose text here').join('\n');
    expect(chunkProse(prose, 500)).toEqual([prose]);
  });

  it('handles numbered lists too', () => {
    const list = Array.from({ length: 200 }, (_, i) => `${i + 1}. Step number ${i} with description.`).join('\n');
    const chunks = chunkProse(list, 1000);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.join('\n')).toBe(list);
  });
});

describe('chunkProse — hard-wrapped list items (#1114)', () => {
  it('splits a list whose items wrap over several lines', () => {
    // The shape that defeated the first attempt: items are hard-wrapped, so
    // most lines carry NO marker (297 of 745 in the real file). A
    // marker-density heuristic misses it; splitting per line would cut the
    // wrapped descriptions in half. The boundary has to be the item.
    const items = Array.from({ length: 200 }, (_, i) =>
      `- [plugin-${i}](https://example.com/${i}) does something useful\n  and the description wraps\n  onto further lines.`);
    const list = items.join('\n');
    const chunks = chunkProse(list, 2500);
    // ~22KB of items at a 2500 budget: roughly ten chunks. The point is that
    // it splits at all — under the paragraph rule this was ONE chunk.
    expect(chunks.length).toBeGreaterThanOrEqual(8);
    expect(chunks.join('\n')).toBe(list);
    expect(chunks.every((c) => c.length <= 2700)).toBe(true);
    // No chunk may begin with a continuation line — that would mean an item
    // was cut away from its own marker.
    for (const c of chunks) expect(/^\s{2,}\S/.test(c.split('\n')[0]!)).toBe(false);
  });
});
