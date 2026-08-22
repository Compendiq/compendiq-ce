/**
 * #1349 — pure halves of the orphan sweep: the raw-string URL reference
 * collector that feeds the keep-set, and the image-like candidate predicate.
 * No DB, no filesystem. The walk itself is covered against real Postgres and
 * a temp tree in attachment-sweep-service.integration.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  collectAttachmentUrlReferences,
  isImageLikeCandidate,
  type AttachmentKeepSets,
} from './attachment-sweep-service.js';

function emptySets(): AttachmentKeepSets {
  return { confluence: new Set<string>(), local: new Set<string>() };
}

describe('collectAttachmentUrlReferences (#1349 keep-set feeder)', () => {
  it('collects img src references into the store the URL prefix names', () => {
    const sets = emptySets();
    collectAttachmentUrlReferences(
      '<img src="/api/attachments/90001/keep.png"><img src="/api/local-attachments/7/diagram.png">',
      sets,
    );
    expect(sets.confluence.has('keep.png')).toBe(true);
    expect(sets.local.has('diagram.png')).toBe(true);
    expect(sets.local.has('keep.png')).toBe(false);
  });

  it('collects anchor href references too (#1169: Markdown import produces <a> refs)', () => {
    const sets = emptySets();
    collectAttachmentUrlReferences(
      '<a href="/api/attachments/90001/manual.pdf">the manual</a>',
      sets,
    );
    expect(sets.confluence.has('manual.pdf')).toBe(true);
  });

  it('decodes the filename segment and keeps the raw spelling as well', () => {
    const sets = emptySets();
    collectAttachmentUrlReferences('<img src="/api/attachments/1/Screen%20shot.png">', sets);
    // The bytes sit on disk under the DECODED name; a file literally named
    // with % sequences is also kept, because the collector cannot know which.
    expect(sets.confluence.has('Screen shot.png')).toBe(true);
    expect(sets.confluence.has('Screen%20shot.png')).toBe(true);
  });

  it('strips query strings and fragments before keying', () => {
    const sets = emptySets();
    collectAttachmentUrlReferences('<img src="/api/attachments/1/a.png?v=2#frag">', sets);
    expect(sets.confluence.has('a.png')).toBe(true);
    expect(sets.confluence.has('a.png?v=2')).toBe(false);
  });

  it('works on raw text without any HTML structure (body_storage, plain text)', () => {
    const sets = emptySets();
    collectAttachmentUrlReferences(
      'see /api/attachments/42/pasted.png and /api/local-attachments/42/x.webp for details',
      sets,
    );
    expect(sets.confluence.has('pasted.png')).toBe(true);
    expect(sets.local.has('x.webp')).toBe(true);
  });

  it('tolerates null/undefined bodies and a lone % in the name', () => {
    const sets = emptySets();
    collectAttachmentUrlReferences(null, sets);
    collectAttachmentUrlReferences(undefined, sets);
    collectAttachmentUrlReferences('<img src="/api/attachments/1/100%.png">', sets);
    expect(sets.confluence.has('100%.png')).toBe(true);
  });

  it('keeps the full decoded name for every character encodeURIComponent leaves literal (review r2)', () => {
    // Every URL writer in the product goes through encodeURIComponent, which
    // leaves ! ' ( ) * ~ (and - _ .) UNENCODED — so these characters appear
    // literally in the URL. A filename class that terminates at any of them
    // records a truncated prefix, the on-disk file misses the keep-set, and
    // a live sweep deletes a referenced file. The apostrophe was the one the
    // original class excluded.
    for (const name of ["John's notes.png", 'shot!.png', 'fig (1).png', 'star*max.png', 'wave~2.png']) {
      const sets = emptySets();
      collectAttachmentUrlReferences(
        `<img src="/api/attachments/90001/${encodeURIComponent(name)}">`,
        sets,
      );
      expect(sets.confluence.has(name), `keep-set must hold ${JSON.stringify(name)}`).toBe(true);
    }
  });

  it('a single-quoted attribute spelling still lands the trimmed name (over-keeping is safe)', () => {
    // With ' inside the filename class, a single-quoted attribute drags the
    // closing quote into the match; the punctuation trim adds the clean
    // variant, and keeping the quoted spelling as well only over-keeps.
    const sets = emptySets();
    collectAttachmentUrlReferences("<img src='/api/attachments/90001/plain.png'>", sets);
    expect(sets.confluence.has('plain.png')).toBe(true);
  });

  it('never emits a name that is not a plain basename', () => {
    const sets = emptySets();
    collectAttachmentUrlReferences('<img src="/api/attachments/1/..%2Fescape.png">', sets);
    for (const name of sets.confluence) {
      expect(name.includes('/')).toBe(false);
      expect(name.startsWith('.')).toBe(false);
    }
  });
});

describe('isImageLikeCandidate (#1349 — the only per-file candidate class)', () => {
  it('accepts the supported raster/vector extensions and draw.io PNG exports', () => {
    for (const name of ['a.png', 'b.JPG', 'c.jpeg', 'd.gif', 'e.svg', 'f.webp', 'diagram.png']) {
      expect(isImageLikeCandidate(name)).toBe(true);
    }
  });

  it('accepts external-image cache keys with or without an extension', () => {
    expect(isImageLikeCandidate('external-0123456789ab.png')).toBe(true);
    expect(isImageLikeCandidate('external-0123456789ab')).toBe(true);
  });

  it('refuses everything else — non-image cached attachments are never candidates', () => {
    for (const name of ['manual.pdf', 'diagram.drawio', 'notes.docx', 'archive.zip', 'x.xml', 'README']) {
      expect(isImageLikeCandidate(name)).toBe(false);
    }
  });
});
