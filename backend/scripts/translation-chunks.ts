/**
 * Split a document into bounded prose chunks for translation, and reassemble
 * it afterwards (#1114).
 *
 * Why this exists: asking an agent (or a model) to translate a 63KB document
 * in one pass does not fail loudly — it SUMMARISES. Measured here, two
 * attempts on `vitest__api__expect.md` returned 28% and 28% of the source, 23
 * of 89 headings and 33 of 105 code blocks, while reporting success. Explicit
 * per-file targets did not fix it, because the limit is on what a single
 * response can faithfully reproduce, not on willingness.
 *
 * So the document is never handed over whole. `split` emits numbered prose
 * chunks; only those are translated. `join` puts the translations back with
 * every fenced code block re-inserted **verbatim from the source**, which
 * makes code preservation structural rather than something the translator has
 * to be trusted to honour — the failure mode that corrupts a corpus while
 * still looking like prose.
 *
 *   npx tsx scripts/translation-chunks.ts split <src> <chunks.json>
 *   npx tsx scripts/translation-chunks.ts join  <src> <chunks.json> <out.md>
 *
 * `join` refuses to write unless every chunk has a non-empty translation, so
 * a partially completed file cannot reach the corpus looking finished.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { splitFences, chunkProse } from '../src/domains/llm/eval/markdown-fences.js';

const MAX_CHUNK_CHARS = Number(process.env.CHUNK_CHARS ?? 2500);

interface ChunkFile {
  source: string;
  /** Prose chunks in document order. `de` is filled in by the translator. */
  chunks: Array<{ i: number; en: string; de?: string }>;
}

/** Prose chunks in document order, with code segments excluded entirely. */
function proseChunks(md: string): string[] {
  const out: string[] = [];
  for (const part of splitFences(md)) {
    if (part.code) continue;
    for (const c of chunkProse(part.text, MAX_CHUNK_CHARS)) out.push(c);
  }
  return out;
}

const [, , mode, srcPath, chunkPath, outPath] = process.argv;

if (mode === 'split') {
  const md = readFileSync(srcPath!, 'utf8');
  const chunks = proseChunks(md).map((en, i) => ({ i, en }));
  const payload: ChunkFile = { source: srcPath!, chunks };
  writeFileSync(chunkPath!, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  const chars = chunks.reduce((n, c) => n + c.en.length, 0);
  console.log(`${chunks.length} prose chunks, ${chars} chars (source ${md.length} chars)`);
} else if (mode === 'join') {
  const md = readFileSync(srcPath!, 'utf8');
  const payload = JSON.parse(readFileSync(chunkPath!, 'utf8')) as ChunkFile;

  const expected = proseChunks(md);
  if (payload.chunks.length !== expected.length) {
    throw new Error(`chunk count mismatch: file has ${payload.chunks.length}, source yields ${expected.length}`);
  }
  const missing = payload.chunks.filter((c) => !c.de || !c.de.trim()).map((c) => c.i);
  if (missing.length) {
    throw new Error(`refusing to join: ${missing.length} chunk(s) untranslated: ${missing.slice(0, 20).join(', ')}`);
  }
  // Guard the same way the source was split, so a translator that silently
  // reordered or dropped a chunk cannot pass.
  for (const [i, c] of payload.chunks.entries()) {
    if (c.en !== expected[i]) throw new Error(`chunk ${i} no longer matches the source text — was the file edited?`);
  }

  const translations = payload.chunks.map((c) => c.de!);
  let next = 0;
  const rebuilt: string[] = [];
  for (const part of splitFences(md)) {
    if (part.code) {
      rebuilt.push(part.text); // verbatim, always
      continue;
    }
    const n = chunkProse(part.text, MAX_CHUNK_CHARS).length;
    rebuilt.push(translations.slice(next, next + n).join('\n'));
    next += n;
  }
  writeFileSync(outPath!, rebuilt.join('\n'), 'utf8');
  console.log(`wrote ${outPath} (${rebuilt.join('\n').length} chars)`);
} else {
  console.error('usage: translation-chunks.ts split|join <src> <chunks.json> [out.md]');
  process.exit(1);
}
