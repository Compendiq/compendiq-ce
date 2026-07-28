/**
 * Unit tests for the attachment-reference rewriter used by relocate (#1123).
 *
 * Pure function over HTML — tested directly with real inputs, then fed through
 * the real `htmlToConfluence` to prove the markers it sets actually produce the
 * `ri:attachment` references Confluence needs. The failure mode this guards
 * against is silent: an image whose src survives the move unchanged still
 * *renders* in the editor until the old attachment directory is cleaned up.
 */
import { describe, it, expect } from 'vitest';
import { rewriteAttachmentRefs, parentKeyFor } from './page-relocate-service.js';
import { htmlToConfluence } from '../../../core/services/content-converter.js';

describe('rewriteAttachmentRefs (#1123)', () => {
  it('re-keys images from the Confluence cache', () => {
    const { html, filenames } = rewriteAttachmentRefs(
      '<p><img src="/api/attachments/42/chart.png" /></p>',
      ['/api/attachments/42/'],
      '/api/attachments/900001/',
      true,
    );

    expect(html).toContain('src="/api/attachments/900001/chart.png"');
    expect(html).not.toContain('/api/attachments/42/');
    expect(filenames).toEqual(['chart.png']);
  });

  it('re-keys images from the local store, which the two stores otherwise strand', () => {
    // `htmlToConfluence`'s selector is `img[src^="/api/attachments/"]`, so a
    // local-store image that is not normalised first survives into storage
    // format as a raw <img> pointing at a route Confluence cannot reach.
    const { html } = rewriteAttachmentRefs(
      '<p><img src="/api/local-attachments/42/diagram.png" /></p>',
      ['/api/attachments/42/', '/api/local-attachments/42/'],
      '/api/attachments/900001/',
      true,
    );

    expect(html).toContain('src="/api/attachments/900001/diagram.png"');
    expect(htmlToConfluence(html)).toContain('ri:filename="diagram.png"');
  });

  it('produces ri:attachment references for images from both stores at once', () => {
    const { html, filenames } = rewriteAttachmentRefs(
      '<p><img src="/api/attachments/42/a.png" /><img src="/api/local-attachments/42/b.png" /></p>',
      ['/api/attachments/42/', '/api/local-attachments/42/'],
      '/api/attachments/900001/',
      true,
    );

    expect(filenames.sort()).toEqual(['a.png', 'b.png']);
    const storage = htmlToConfluence(html);
    expect(storage).toContain('ri:filename="a.png"');
    expect(storage).toContain('ri:filename="b.png"');
  });

  it('leaves external-URL images as ri:url rather than mislabelling them', () => {
    const input =
      '<p><img src="/api/attachments/42/remote.png" data-confluence-image-source="external-url" ' +
      'data-confluence-url="https://example.com/remote.png" /></p>';

    const { html } = rewriteAttachmentRefs(
      input,
      ['/api/attachments/42/'],
      '/api/attachments/900001/',
      true,
    );

    expect(html).toContain('data-confluence-image-source="external-url"');
    expect(html).not.toContain('data-confluence-filename');
    expect(htmlToConfluence(html)).toContain('ri:url');
  });

  it('round-trips URL-encoded filenames', () => {
    const { html, filenames } = rewriteAttachmentRefs(
      '<p><img src="/api/attachments/42/my%20diagram%20(v2).png" /></p>',
      ['/api/attachments/42/'],
      '/api/local-attachments/42/',
      false,
    );

    expect(filenames).toEqual(['my diagram (v2).png']);
    expect(html).toContain('/api/local-attachments/42/my%20diagram%20(v2).png');
  });

  it('rewrites anchor hrefs, not just image sources', () => {
    const { html } = rewriteAttachmentRefs(
      '<p><a href="/api/attachments/42/spec.pdf">Spec</a></p>',
      ['/api/attachments/42/'],
      '/api/local-attachments/42/',
      false,
    );

    expect(html).toContain('href="/api/local-attachments/42/spec.pdf"');
  });

  it('leaves an unrelated page\'s attachments alone', () => {
    const input = '<p><img src="/api/attachments/99/other.png" /></p>';

    const { html, filenames } = rewriteAttachmentRefs(
      input,
      ['/api/attachments/42/'],
      '/api/attachments/900001/',
      true,
    );

    expect(html).toBe(input);
    expect(filenames).toEqual([]);
  });

  it('ignores nested paths that would escape the attachment key', () => {
    const input = '<p><img src="/api/attachments/42/nested/evil.png" /></p>';

    const { html } = rewriteAttachmentRefs(
      input,
      ['/api/attachments/42/'],
      '/api/attachments/900001/',
      true,
    );

    expect(html).toBe(input);
  });

  it('is a no-op on empty or reference-free HTML', () => {
    expect(rewriteAttachmentRefs('', ['/api/attachments/42/'], '/x/', true)).toEqual({
      html: '',
      filenames: [],
    });
    expect(rewriteAttachmentRefs('<p>text</p>', ['/api/attachments/42/'], '/x/', true)).toEqual({
      html: '<p>text</p>',
      filenames: [],
    });
  });
});

describe('parentKeyFor (#1123)', () => {
  it('returns the confluence_id for a Confluence page', () => {
    expect(parentKeyFor('confluence', 42, '900001')).toBe('900001');
  });

  it('returns the numeric id as text for a standalone page', () => {
    expect(parentKeyFor('standalone', 42, null)).toBe('42');
  });

  it('falls back to the numeric id when a Confluence row has no confluence_id', () => {
    // Defensive: a Confluence-sourced row mid-relocate has already had its
    // confluence_id cleared, and children of it key on the numeric id.
    expect(parentKeyFor('confluence', 42, null)).toBe('42');
  });
});
