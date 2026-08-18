import { describe, it, expect } from 'vitest';
import type { Source } from './SourceCitations';
import { isImageSource } from './image-source';

function source(over: Partial<Source>): Source {
  return { pageTitle: 'Page', ...over };
}

describe('isImageSource', () => {
  it('is true for kind: image with a non-empty attachmentUrl', () => {
    expect(isImageSource(source({ kind: 'image', attachmentUrl: '/api/attachments/1/a.png' }))).toBe(true);
  });

  it('is false when kind is absent', () => {
    expect(isImageSource(source({ attachmentUrl: '/api/attachments/1/a.png' }))).toBe(false);
  });

  it('is false when attachmentUrl is absent', () => {
    expect(isImageSource(source({ kind: 'image' }))).toBe(false);
  });

  // review r1 #5 — an empty string passes a bare `typeof === 'string'` check,
  // which would take the image branch (and its image `aria-label`) on a chip
  // with no picture in it. Mirrors the backend's `toPersistedSources` guard.
  it('is false when attachmentUrl is the empty string', () => {
    expect(isImageSource(source({ kind: 'image', attachmentUrl: '' }))).toBe(false);
  });
});
