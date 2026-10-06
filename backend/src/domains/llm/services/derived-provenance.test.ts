/**
 * ADR-027 D9.4/D12 — the provenance reader is TOTAL and STRICT, and the
 * `(pageId, store, key)` dedup is the one ordering both the citation append
 * and the answer-time byte pick consume.
 *
 * Why the strictness is worth its own file: D12 requires the four citation
 * fields to travel together or not at all, and a partially-populated
 * `metadata` is exactly how one of them would travel alone — through the
 * contract's co-presence rule, into a stored conversation that a later reopen
 * then fails to parse. The decision is made once, here, where the JSON is
 * first touched, so every consumer inherits it.
 */
import { describe, expect, it } from 'vitest';
import { distinctDerivedImages, readDerivedProvenance } from './derived-provenance.js';

const COMPLETE = {
  page_title: 'Checkout outage',
  section_title: '[Image: console.png — screenshot]',
  space_key: 'OPS',
  confluence_id: 'cid-1',
  source: 'image_analysis',
  attachment_source: 'confluence',
  attachment_key: 'console.png',
  content_hash: 'sha256:abc',
  analysis_id: 9,
  analysis_version: 1,
  part: 1,
  parts: 2,
};

describe('readDerivedProvenance', () => {
  it('reads the D9.4 shape off a derived chunk', () => {
    expect(readDerivedProvenance(COMPLETE)).toEqual({
      attachmentSource: 'confluence',
      attachmentKey: 'console.png',
      contentHash: 'sha256:abc',
      analysisId: 9,
      analysisVersion: 1,
      part: 1,
      parts: 2,
    });
  });

  it('answers undefined for an authored chunk', () => {
    // Provenance is decided by `metadata.source` and nothing else (D9.4):
    // never by position, never by the shape of the text.
    expect(readDerivedProvenance({
      page_title: 'P', section_title: 'S', space_key: 'OPS', confluence_id: 'cid-1',
    })).toBeUndefined();
  });

  it('answers undefined for a metadata that is not an object at all', () => {
    for (const value of [null, undefined, 'image_analysis', 7, []]) {
      expect(readDerivedProvenance(value)).toBeUndefined();
    }
  });

  it.each(['attachment_source', 'attachment_key', 'content_hash', 'analysis_id', 'analysis_version', 'part', 'parts'])(
    'answers undefined — never a partial object — when %s is missing',
    (field) => {
      const partial: Record<string, unknown> = { ...COMPLETE };
      delete partial[field];
      expect(readDerivedProvenance(partial)).toBeUndefined();
    },
  );

  it('answers undefined for a wrong-typed field', () => {
    expect(readDerivedProvenance({ ...COMPLETE, analysis_version: '1' })).toBeUndefined();
    expect(readDerivedProvenance({ ...COMPLETE, attachment_key: '' })).toBeUndefined();
    // Not one of the two stores: `buildPageImageUrl` would build a URL from a
    // store it does not serve.
    expect(readDerivedProvenance({ ...COMPLETE, attachment_source: 's3' })).toBeUndefined();
  });
});

describe('distinctDerivedImages', () => {
  function row(pageId: number, key: string, score: number, part = 1) {
    return {
      pageId,
      pageTitle: `Page ${pageId}`,
      spaceKey: 'OPS',
      score,
      derived: {
        attachmentSource: 'confluence' as const,
        attachmentKey: key,
        contentHash: `sha256:${pageId}-${key}`,
        analysisId: pageId,
        analysisVersion: 1,
        part,
        parts: 2,
      },
    };
  }

  it('orders by the carrying row’s fused rank, then part, then page', () => {
    // There is no cross-modal score to sort on (ADR-027 `:4318`), so the row's
    // own fused rank is the only ranking quantity — and the fallbacks make the
    // order TOTAL, which is what keeps two identical requests citing the same
    // pictures in the same order.
    const images = distinctDerivedImages([
      row(2, 'b.png', 0.02, 2),
      row(1, 'a.png', 0.05, 2),
      row(1, 'a0.png', 0.05, 1),
      row(3, 'c.png', 0.02, 2),
    ]);
    expect(images.map((i) => i.derived.attachmentKey)).toEqual(['a0.png', 'a.png', 'b.png', 'c.png']);
  });

  it('breaks the last tie on attachmentKey, so the order is TOTAL as documented', () => {
    // Review r1 finding 4. Two DIFFERENT images of the SAME page at the same
    // fused score and the same part tie on every earlier key, and without
    // this fallback they resolve by `Array#sort` stability — i.e. by the
    // order retrieval happened to return the rows in, which is not a
    // property either caller controls. The docstring claims the order is
    // total; this is what makes that true.
    const forward = distinctDerivedImages([row(1, 'zulu.png', 0.05), row(1, 'alpha.png', 0.05)]);
    const reversed = distinctDerivedImages([row(1, 'alpha.png', 0.05), row(1, 'zulu.png', 0.05)]);
    expect(forward.map((i) => i.derived.attachmentKey)).toEqual(['alpha.png', 'zulu.png']);
    expect(reversed.map((i) => i.derived.attachmentKey)).toEqual(['alpha.png', 'zulu.png']);
  });

  it('collapses several rows of ONE picture to one image', () => {
    // A multi-part serialization puts several chunks of the same file in the
    // index; two of them in one top-K must not spend two citation slots.
    const images = distinctDerivedImages([
      row(1, 'multi.png', 0.05, 1),
      row(1, 'multi.png', 0.05, 2),
    ]);
    expect(images).toHaveLength(1);
    expect(images[0]!.derived.part).toBe(1);
  });

  it('keeps the SAME key on two pages apart — the identity is the triple', () => {
    // One diagram reused across two pages is two citations, because a citation
    // names the page the reader can open. The byte pick collapses them later
    // by digest, which is a different decision about the same file.
    expect(distinctDerivedImages([row(1, 'shared.png', 0.05), row(2, 'shared.png', 0.04)])).toHaveLength(2);
  });

  it('ignores rows with no provenance', () => {
    expect(distinctDerivedImages([{ pageId: 1, score: 0.05 }, row(2, 'b.png', 0.01)]))
      .toHaveLength(1);
  });
});
