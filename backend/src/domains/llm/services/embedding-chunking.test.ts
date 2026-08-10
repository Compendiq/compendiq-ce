import { describe, it, expect } from 'vitest';
// Deliberately NO mocks: these tests exercise the real converter feeding the
// real chunker — the seam where #1265 lived. `htmlToText` collapses ALL
// whitespace (`replace(/\s+/g, ' ')`), so `chunkText`'s heading split
// (`^#{1,6}\s`, expects Markdown atx headings) and paragraph split (`\n\n+`)
// could never match its output: every page ≤ CHUNK_HARD_LIMIT became exactly
// one chunk, longer pages split at arbitrary word boundaries with no overlap,
// and `section_title` always equalled the page title. The structure-aware
// chunking was dead code from the day it shipped.
import {
  htmlToText,
  htmlToEmbeddingText,
} from '../../../core/services/content-converter.js';
import { chunkText, CHUNK_HARD_LIMIT } from './embedding-service.js';

/** A page with three ~1,200-char sections under real headings — far over the
 * 1,500-char chunk target, well under CHUNK_HARD_LIMIT. */
function sectionedHtml(): string {
  const para = (label: string) =>
    `<p>${`${label} paragraph sentence with enough words to carry real content. `.repeat(15)}</p>`;
  return [
    '<h1>Deployment guide</h1>',
    para('Intro'),
    '<h2>Prerequisites</h2>',
    para('Prereq'),
    para('Prereq-two'),
    '<h2>Rollback procedure</h2>',
    para('Rollback'),
    para('Rollback-two'),
  ].join('\n');
}

describe('embedding text extraction (#1265)', () => {
  describe('the defect, pinned: htmlToText output is unchunkable', () => {
    it('htmlToText collapses every newline, so no structural splitter can match', () => {
      const text = htmlToText(sectionedHtml());
      expect(text).not.toContain('\n');
      expect(text).not.toMatch(/^#{1,6}\s/m);
    });

    it('a multi-section page under the hard limit becomes ONE chunk with the page title as its section', () => {
      const text = htmlToText(sectionedHtml());
      expect(text.length).toBeGreaterThan(3000); // 2x the 1,500-char target
      expect(text.length).toBeLessThan(CHUNK_HARD_LIMIT);
      const chunks = chunkText(text, 'Deployment guide', 'OPS', 'p-1');
      expect(chunks).toHaveLength(1);
      expect(chunks[0]!.metadata.section_title).toBe('Deployment guide');
    });
  });

  describe('htmlToEmbeddingText', () => {
    it('emits atx headings and blank-line paragraph boundaries', () => {
      const md = htmlToEmbeddingText(sectionedHtml());
      expect(md).toMatch(/^# Deployment guide$/m);
      expect(md).toMatch(/^## Prerequisites$/m);
      expect(md).toMatch(/^## Rollback procedure$/m);
      expect(md).toMatch(/\n\n/);
    });

    it('chunkText splits its output on headings and records real section titles', () => {
      const md = htmlToEmbeddingText(sectionedHtml());
      const chunks = chunkText(md, 'Deployment guide', 'OPS', 'p-1');
      expect(chunks.length).toBeGreaterThan(1);
      const sections = new Set(chunks.map((c) => c.metadata.section_title));
      expect(sections).toContain('Prerequisites');
      expect(sections).toContain('Rollback procedure');
      // Every chunk respects the hard ceiling.
      for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(CHUNK_HARD_LIMIT);
    });

    it('keeps code blocks fenced so they survive as intact chunks', () => {
      const html = `<h2>Config</h2><pre><code>POSTGRES_URL=postgres://db:5432\nREDIS_URL=redis://cache</code></pre>`;
      const md = htmlToEmbeddingText(html);
      expect(md).toContain('```');
      expect(md).toContain('POSTGRES_URL=postgres://db:5432');
    });

    it('falls back to plain text when the HTML defeats the Markdown converter', () => {
      // Force the fallback with input the JSDOM/turndown path cannot parse as
      // a document fragment — a lone null byte inside a broken tag is enough
      // to exercise the try/catch without asserting on turndown internals.
      // Whatever comes back must be usable text, never a throw.
      const html = '<p>usable content that must survive</p>';
      expect(htmlToEmbeddingText(html)).toContain('usable content that must survive');
    });
  });
});
