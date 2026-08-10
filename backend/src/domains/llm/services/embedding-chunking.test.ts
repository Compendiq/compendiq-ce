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
  markdownToSnippetText,
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

    it('never splits inside a fenced code block, and never fabricates section titles from # comments (#1265 B1)', () => {
      // The densest content type in a technical KB: a code block whose body
      // is full of `# ` comment lines. The old m-flagged regex split treated
      // each as a heading — fabricating section titles from YAML comments,
      // emitting a dangling-fence sliver chunk, and absorbing the prose after
      // the block into a fake section.
      const html = [
        '<h1>Runbook</h1>',
        '<pre><code class="language-yaml"># database settings',
        'host: localhost',
        'port: 5432',
        '# cache settings',
        'redis: cache:6379</code></pre>',
        '<p>Then restart the service.</p>',
      ].join('\n');
      const md = htmlToEmbeddingText(html);
      const chunks = chunkText(md, 'Runbook', 'OPS', 'p-1');
      expect(chunks).toHaveLength(1);
      expect(chunks[0]!.metadata.section_title).toBe('Runbook');
      // The fence arrives intact, comments and all, prose after it included.
      expect(chunks[0]!.text).toContain('# database settings');
      expect(chunks[0]!.text).toContain('# cache settings');
      expect(chunks[0]!.text).toContain('Then restart the service.');
      expect(chunks[0]!.text.match(/```/g)?.length).toBe(2);
    });

    it('does not treat blank lines inside a fence as paragraph boundaries', () => {
      // An oversized section paragraph-splits — but a fence containing blank
      // lines must ride whole, not be cut mid-fence.
      const fenceBody = `first: 1\n\nsecond: 2\n\nthird: 3`;
      const filler = 'Prose sentence that fills the section well beyond the packing target. '.repeat(30);
      const md = `# Config\n\n${filler}\n\n\`\`\`yaml\n${fenceBody}\n\`\`\`\n\n${filler}`;
      const chunks = chunkText(md, 'Config', 'OPS', 'p-1');
      expect(chunks.length).toBeGreaterThan(1);
      // The property: the paragraph splitter never CUTS the fence — any chunk
      // touching a fence row carries the whole fence body. (The word-overlap
      // may duplicate a small trailing fence wholesale into the next chunk;
      // duplication is context repetition, not a split.) Under the old
      // blank-line split the three rows land in different chunks.
      const touching = chunks.filter((c) => /first: 1|second: 2|third: 3/.test(c.text));
      expect(touching.length).toBeGreaterThan(0);
      for (const c of touching) {
        expect(c.text).toContain('first: 1');
        expect(c.text).toContain('second: 2');
        expect(c.text).toContain('third: 3');
      }
    });

    it('packs consecutive small sections instead of one chunk per heading (#1265 M7)', () => {
      const md = Array.from(
        { length: 40 },
        (_, i) =>
          `## Topic ${i}\n\nA sentence about topic ${i} carrying enough words to give each glossary entry real length. Another sentence for body.`,
      ).join('\n\n');
      const chunks = chunkText(md, 'Glossary', 'OPS', 'p-1');
      // 40 headings (~5,600 chars) must NOT become 40 chunks — they pack
      // toward the 1,500-char target, so roughly four. Titles come from each
      // packed run's opening section.
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.length).toBeLessThan(10);
      expect(chunks[0]!.metadata.section_title).toBe('Topic 0');
      // The later headings stay visible inside the packed chunk text.
      expect(chunks[0]!.text).toContain('## Topic 1');
    });

    it('strips base64 data: URIs so an inlined image cannot become junk vectors (#1265 B2)', () => {
      const base64 = 'iVBORw0KGgoAAAANSUhEUg'.repeat(200);
      const html = `<p>Diagram below.</p><img src="data:image/png;base64,${base64}" alt="architecture overview">`;
      const md = htmlToEmbeddingText(html);
      expect(md).toContain('architecture overview');
      expect(md).toContain('data:uri-omitted');
      expect(md.length).toBeLessThan(300);
    });

    it('falls back to plain text when the HTML defeats the Markdown converter', () => {
      // Real trigger, measured: ~2,000-deep tag nesting overflows turndown's
      // recursion. The fallback must hand back the text content, not throw.
      const html = `${'<div>'.repeat(2000)}deep content that must survive${'</div>'.repeat(2000)}`;
      expect(htmlToEmbeddingText(html)).toContain('deep content that must survive');
    });
  });

  describe('markdownToSnippetText (#1265)', () => {
    it('flattens Markdown chunk text into a prose excerpt', () => {
      const md = '# Setup\n\nUse `2\\*3` and ![screenshot one](/api/attachments/4711/s.png) then [the guide](/pages/9).\n\n```bash\nnpm install\n```';
      const snippet = markdownToSnippetText(md);
      expect(snippet).toContain('2*3');
      expect(snippet).toContain('screenshot one');
      expect(snippet).toContain('the guide');
      expect(snippet).not.toContain('](');
      expect(snippet).not.toContain('```');
      expect(snippet).not.toContain('# Setup');
      expect(snippet).toContain('Setup');
    });

    it('is idempotent on plain text (keyword-fallback rows pass through)', () => {
      const plain = 'Plain body text excerpt with nothing to flatten.';
      expect(markdownToSnippetText(plain)).toBe(plain);
    });
  });
});
