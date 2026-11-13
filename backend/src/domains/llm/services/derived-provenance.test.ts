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
import { buildDerivedImageSources, distinctDerivedImages, readDerivedProvenance } from './derived-provenance.js';
import type { PageIdentityReader } from './page-identity.js';

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

  /**
   * An in-memory identity reader: every page is a Confluence page whose
   * directory key is `c<id>`. Injected through `buildDerivedImageSources`'s
   * own parameter — the read is not what these cases are about.
   */
  function identities(): PageIdentityReader {
    return {
      async load(pageIds) {
        return new Map(pageIds.map((id) => [id, { id, confluence_id: `c${id}`, source: 'confluence' as const }]));
      },
    };
  }

  it('orders by the carrying row’s position in the final array — before score, part, page and key (#1716)', () => {
    // The array order IS the pipeline's verdict (`SearchResult`'s contract in
    // `rag-service.ts`): reranking, the ranking prior, MMR and identifier pins
    // reorder rows whose fused `score` no longer describes that order. So the
    // row at position 0 leads with the lowest score, and an earlier position
    // beats an earlier part and a lower page id.
    const images = distinctDerivedImages([
      row(2, 'b.png', 0.02, 2),
      row(1, 'a.png', 0.05, 2),
      row(1, 'a0.png', 0.05, 1),
      row(3, 'c.png', 0.02, 2),
    ]);
    expect(images.map((i) => i.derived.attachmentKey)).toEqual(['b.png', 'a.png', 'a0.png', 'c.png']);
  });

  it('follows the input order rather than the attachment key', () => {
    // Before #1716 the key decided this pair whatever the input order, on the
    // reasoning that the order retrieval returned the rows in was arbitrary.
    // It is the final result order, so it decides.
    const forward = [row(1, 'zulu.png', 0.05), row(1, 'alpha.png', 0.05)];
    expect(distinctDerivedImages(forward).map((i) => i.derived.attachmentKey)).toEqual(['zulu.png', 'alpha.png']);
    expect(distinctDerivedImages([...forward].reverse()).map((i) => i.derived.attachmentKey))
      .toEqual(['alpha.png', 'zulu.png']);
  });

  it('puts a reranked head first although the row below it has the higher fused score, and cites only it at max 1', async () => {
    // The issue's rerank case: the cross-encoder moved B to position 0 (0.95
    // against 0.10) while A kept the higher fused score.
    const rows = [
      { ...row(2, 'b.png', 0.01613), rerankScore: 0.95 },
      { ...row(1, 'a.png', 0.01639), rerankScore: 0.1 },
    ];
    expect(distinctDerivedImages(rows).map((i) => i.derived.attachmentKey)).toEqual(['b.png', 'a.png']);
    const cited = await buildDerivedImageSources(rows, 1, identities());
    expect(cited.map((s) => s.attachmentKey)).toEqual(['b.png']);
  });

  it('puts a pinned derived row (score 0) at position 0 first, cites only it at max 1, and keeps every row’s score', async () => {
    // A NEW pin carries `score: 0` and leads by array position alone
    // (`lookupIdentifier`); before #1716 its picture sorted LAST. The score
    // still travels unchanged, and `similarity` stays null: no cross-modal
    // score (ADR-027 D12).
    const rows = [
      { ...row(7, 'inc.png', 0), pinned: true as const },
      row(1, 'a.png', 0.0328),
      row(2, 'b.png', 0.0161),
    ];
    expect(distinctDerivedImages(rows).map((i) => [i.derived.attachmentKey, i.score]))
      .toEqual([['inc.png', 0], ['a.png', 0.0328], ['b.png', 0.0161]]);
    expect((await buildDerivedImageSources(rows, 1, identities())).map((s) => s.attachmentKey)).toEqual(['inc.png']);
    const cited = await buildDerivedImageSources(rows, 4, identities());
    expect(cited.map((s) => [s.attachmentKey, s.score, s.similarity]))
      .toEqual([['inc.png', 0, null], ['a.png', 0.0328, null], ['b.png', 0.0161, null]]);
    expect(cited[0]).toEqual({
      kind: 'image',
      pageId: 7,
      pageTitle: 'Page 7',
      spaceKey: 'OPS',
      attachmentUrl: '/api/attachments/c7/inc.png',
      attachmentStore: 'confluence',
      attachmentKey: 'inc.png',
      contentHash: 'sha256:7-inc.png',
      analysisVersion: 1,
      similarity: null,
      score: 0,
    });
  });

  it('cites a picture two rows carry ONCE, from the EARLIER row — its part and its score', () => {
    // Two parts of one multi-part serialization in one top-K. The later row
    // has the earlier part and the higher score; the earlier row still wins.
    // The order depends on the input's values and order only: a separately
    // built copy of the same input returns the identical list.
    const rows = [row(1, 'x.png', 0.01, 2), row(2, 'y.png', 0.03, 1), row(1, 'x.png', 0.05, 1)];
    const images = distinctDerivedImages(rows);
    expect(images.map((i) => [i.derived.attachmentKey, i.derived.part, i.score]))
      .toEqual([['x.png', 2, 0.01], ['y.png', 1, 0.03]]);
    expect(distinctDerivedImages(structuredClone(rows))).toEqual(images);
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
