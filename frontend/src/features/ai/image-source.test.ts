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

  // An empty string passes a bare `typeof === 'string'` check, which would
  // take the image branch (and its image `aria-label`) on a chip with no
  // picture in it. Same rule as the backend's `toPersistedSources` guard —
  // both import `ATTACHMENT_URL_PATTERN` from contracts.
  it('is false when attachmentUrl is the empty string', () => {
    expect(isImageSource(source({ kind: 'image', attachmentUrl: '' }))).toBe(false);
  });

  // The last gate before `<img>`: `useAuthenticatedSrc` sets any non-`/api/`
  // src directly, so a URL outside the two attachment routes is not a picture.
  it('is false when attachmentUrl is outside the attachment routes, true for both route prefixes', () => {
    expect(isImageSource(source({ kind: 'image', attachmentUrl: 'https://evil.example/x.png' }))).toBe(false);
    expect(isImageSource(source({ kind: 'image', attachmentUrl: '/api/attachmentsX/1/a.png' }))).toBe(false);
    expect(isImageSource(source({ kind: 'image', attachmentUrl: '/api/local-attachments/1/a.png' }))).toBe(true);
  });
});
