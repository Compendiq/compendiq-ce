import { describe, expect, it } from 'vitest';
import { buildEmbeddingText, chunkText } from './embedding-service.js';

// #1108 — the title/section prefix. Applied at EMBED time, never stored:
// chunk_text is read back by /api/search as a snippet and by buildRagContext,
// which already prints its own [Source] header.

describe('buildEmbeddingText (#1108)', () => {
  it('puts the page title and section in the embedded text', () => {
    expect(buildEmbeddingText('the body', 'Prototype Poisoning', 'BOOM')).toBe('Prototype Poisoning — BOOM\n\nthe body');
  });

  it('does not repeat the title when the chunk has no heading of its own', () => {
    // chunkText seeds section_title with the page title until a heading is
    // seen, so the naive format would emit "X — X" and spend tokens on it.
    expect(buildEmbeddingText('the body', 'Hooks', 'Hooks')).toBe('Hooks\n\nthe body');
  });

  it('tolerates a missing section, which the shadow backfill can hit on old rows', () => {
    expect(buildEmbeddingText('the body', 'Hooks', '')).toBe('Hooks\n\nthe body');
  });

  it('is what makes a title-only query findable at all', () => {
    // The whole point: a page whose body never repeats its own title.
    const body = 'This document explains the mechanism in detail.';
    expect(body).not.toContain('Prototype Poisoning');
    expect(buildEmbeddingText(body, 'Prototype Poisoning', 'Prototype Poisoning')).toContain('Prototype Poisoning');
  });
});

describe('chunkText still stores unprefixed text (#1108)', () => {
  it('leaves chunk.text bare and carries the title in metadata only', () => {
    const chunks = chunkText('# Section One\n\nSome body text that is long enough to keep.', 'My Page', 'SPACE', 'cid');
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      expect(c.text.startsWith('My Page')).toBe(false);
      expect(c.metadata.page_title).toBe('My Page');
    }
  });
});
