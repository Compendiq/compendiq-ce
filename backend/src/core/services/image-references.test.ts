import { describe, it, expect } from 'vitest';
import {
  extractImageReferencesFromHtml,
  isExternalImageKey,
  extractImageReferences,
} from './image-references.js';

/**
 * #1115 P2 — the enumerator the image-embedding worker walks.
 *
 * The rule under test is the P0 record's: **source follows the URL prefix**,
 * never `pages.confluence_id IS NULL`. `relocateToLocal` persists a body whose
 * `<img src>` were rewritten onto `/api/local-attachments/`, so a page with a
 * NULL `confluence_id` can have every one of its images in the LOCAL store —
 * and a page pasted into after that move carries both prefixes at once.
 */
describe('extractImageReferencesFromHtml (#1115)', () => {
  it('reads the Confluence-cache prefix as source "confluence"', () => {
    expect(
      extractImageReferencesFromHtml('<p><img src="/api/attachments/123456/diagram.png"></p>'),
    ).toEqual([{ source: 'confluence', key: 'diagram.png' }]);
  });

  it('reads the local-store prefix as source "local"', () => {
    expect(
      extractImageReferencesFromHtml('<p><img src="/api/local-attachments/42/sketch.png"></p>'),
    ).toEqual([{ source: 'local', key: 'sketch.png' }]);
  });

  it('carries both prefixes off one page (the post-relocate paste case)', () => {
    const html = `
      <img src="/api/local-attachments/42/moved.png">
      <img src="/api/attachments/42/pasted.png">
    `;
    expect(extractImageReferencesFromHtml(html)).toEqual([
      { source: 'local', key: 'moved.png' },
      { source: 'confluence', key: 'pasted.png' },
    ]);
  });

  it('URL-decodes the basename, because the writer stored the raw name', () => {
    // `content-converter.ts` and the paste route both percent-encode the
    // filename into the `src`; the bytes are on disk under the raw name, so a
    // key that keeps the encoding resolves to nothing — silently.
    expect(
      extractImageReferencesFromHtml('<img src="/api/attachments/7/Screen%20shot%20(1).png">'),
    ).toEqual([{ source: 'confluence', key: 'Screen shot (1).png' }]);
  });

  it('keeps a filename whose raw name really contains a percent sequence', () => {
    // `decodeURIComponent` throws on a lone `%`; the raw name is the honest
    // fallback, and it is what is on disk when the writer never encoded.
    expect(extractImageReferencesFromHtml('<img src="/api/attachments/7/100%.png">')).toEqual([
      { source: 'confluence', key: '100%.png' },
    ]);
  });

  it('ignores a query string and a fragment', () => {
    expect(
      extractImageReferencesFromHtml('<img src="/api/attachments/7/a.png?v=2#frag">'),
    ).toEqual([{ source: 'confluence', key: 'a.png' }]);
  });

  it('dedupes by (source, key) and keeps first-seen order', () => {
    const html = `
      <img src="/api/attachments/7/a.png">
      <img src="/api/local-attachments/7/a.png">
      <img src="/api/attachments/7/a.png">
    `;
    expect(extractImageReferencesFromHtml(html)).toEqual([
      { source: 'confluence', key: 'a.png' },
      { source: 'local', key: 'a.png' },
    ]);
  });

  it('ignores external, data and unrecognised sources', () => {
    const html = `
      <img src="https://example.com/remote.png">
      <img src="data:image/png;base64,iVBORw0KGgo=">
      <img src="/api/pages/7/thumbnail.png">
      <img>
    `;
    expect(extractImageReferencesFromHtml(html)).toEqual([]);
  });

  it('refuses a key that is not a plain filename', () => {
    // `resolveAttachmentBytes` refuses these too, but an enumerator that emits
    // them writes a row nothing can ever resolve.
    const html = `
      <img src="/api/attachments/7/">
      <img src="/api/attachments/7/.hidden.png">
    `;
    expect(extractImageReferencesFromHtml(html)).toEqual([]);
  });

  it('answers empty for a null-ish or empty body', () => {
    expect(extractImageReferencesFromHtml('')).toEqual([]);
    expect(extractImageReferencesFromHtml(null)).toEqual([]);
  });

  it('leaves the Confluence storage-format enumerator alone', () => {
    // Both live in this module; the storage one parses `ac:image`, which a
    // standalone page never has.
    const storage =
      '<ac:image><ri:attachment ri:filename="stored.png" /></ac:image>';
    expect(extractImageReferences(storage)).toEqual([
      expect.objectContaining({ localFilename: 'stored.png' }),
    ]);
    expect(extractImageReferencesFromHtml(storage)).toEqual([]);
  });
});

describe('isExternalImageKey (#1115)', () => {
  it('recognises the name buildExternalLocalFilename writes', () => {
    expect(isExternalImageKey('external-0123456789ab.png')).toBe(true);
    expect(isExternalImageKey('external-0123456789ab')).toBe(true);
  });

  it('does not claim a file that merely starts with the word', () => {
    expect(isExternalImageKey('external-diagram.png')).toBe(false);
    expect(isExternalImageKey('externally-sourced.png')).toBe(false);
    expect(isExternalImageKey('diagram.png')).toBe(false);
  });
});
