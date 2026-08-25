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
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rewriteAttachmentRefs, parentKeyFor } from './page-relocate-service.js';
import {
  htmlToConfluence,
  confluenceToHtml,
  markdownToHtml,
} from '../../../core/services/content-converter.js';

/** Storage for an image borrowed from another page — ordinary Confluence markup. */
const CROSS_PAGE_STORAGE =
  '<p><ac:image><ri:attachment ri:filename="chart.png">' +
  '<ri:page ri:content-title="Other Page" ri:space-key="OTHER" /></ri:attachment></ac:image></p>';

describe('rewriteAttachmentRefs (#1123)', () => {
  it('re-keys images from the Confluence cache', () => {
    const { html, refs } = rewriteAttachmentRefs(
      '<p><img src="/api/attachments/42/chart.png" /></p>',
      ['/api/attachments/42/'],
      '/api/attachments/900001/',
      true,
    );

    expect(html).toContain('src="/api/attachments/900001/chart.png"');
    expect(html).not.toContain('/api/attachments/42/');
    expect(refs).toEqual([{ local: 'chart.png', target: 'chart.png' }]);
  });

  // ── Review finding B1: cross-page references ──────────────────────────────
  //
  // `getLocalFilenameForImageSource` mints a synthetic `stem.xref-<hash>.ext`
  // whenever an `ri:attachment` names an owner page, so the cache key and the
  // real attachment name diverge. Every other test here uses names where the
  // two coincide — which is exactly why the clobber was invisible.

  it('preserves the true attachment filename when the URL carries a synthetic xref name', () => {
    const html = confluenceToHtml(CROSS_PAGE_STORAGE, '700005', 'CONF');
    // Precondition: the two names really do differ for this input.
    expect(html).toContain('/api/attachments/700005/chart.xref-7726434ef328.png');
    expect(html).toContain('data-confluence-filename="chart.png"');

    const { html: moved, refs } = rewriteAttachmentRefs(
      html,
      ['/api/attachments/700005/'],
      '/api/attachments/900001/',
      true,
    );

    // Bytes are cached under the synthetic name but must be PUBLISHED under the
    // real one, and the new URL must follow the published name.
    expect(refs).toEqual([{ local: 'chart.xref-7726434ef328.png', target: 'chart.png' }]);
    expect(moved).toContain('data-confluence-filename="chart.png"');
    expect(moved).toContain('src="/api/attachments/900001/chart.png"');
  });

  it('strips the owner-page markers so the reference resolves against the new page', () => {
    const html = confluenceToHtml(CROSS_PAGE_STORAGE, '700005', 'CONF');

    const { html: moved } = rewriteAttachmentRefs(
      html,
      ['/api/attachments/700005/'],
      '/api/attachments/900001/',
      true,
    );

    expect(moved).not.toContain('data-confluence-owner-page-title');
    expect(moved).not.toContain('data-confluence-owner-space-key');

    // The regenerated storage must name the real file and must NOT steer the
    // reference at the page the image was borrowed from — relocate uploaded the
    // bytes to the new page, not to "Other Page".
    const republished = htmlToConfluence(moved);
    expect(republished).toContain('ri:filename="chart.png"');
    expect(republished).not.toContain('xref-');
    expect(republished).not.toContain('ri:page');
    expect(republished).not.toContain('Other Page');
  });

  it('survives the full Confluence → local → Confluence round trip', () => {
    // The guaranteed path, and the state this feature itself creates.
    const html = confluenceToHtml(CROSS_PAGE_STORAGE, '700005', 'CONF');

    const { html: local } = rewriteAttachmentRefs(
      html, ['/api/attachments/700005/'], '/api/local-attachments/42/', false,
    );
    // Going local re-keys the directory only — the filename is untouched.
    expect(local).toContain('src="/api/local-attachments/42/chart.xref-7726434ef328.png"');
    expect(local).toContain('data-confluence-filename="chart.png"');

    const { html: back, refs } = rewriteAttachmentRefs(
      local, ['/api/local-attachments/42/'], '/api/attachments/900001/', true,
    );

    expect(refs).toEqual([{ local: 'chart.xref-7726434ef328.png', target: 'chart.png' }]);
    const republished = htmlToConfluence(back);
    expect(republished).toContain('ri:filename="chart.png"');
    expect(republished).not.toContain('xref-');
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
    const { html, refs } = rewriteAttachmentRefs(
      '<p><img src="/api/attachments/42/a.png" /><img src="/api/local-attachments/42/b.png" /></p>',
      ['/api/attachments/42/', '/api/local-attachments/42/'],
      '/api/attachments/900001/',
      true,
    );

    expect(refs.map((r) => r.target).sort()).toEqual(['a.png', 'b.png']);
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
    const { html, refs } = rewriteAttachmentRefs(
      '<p><img src="/api/attachments/42/my%20diagram%20(v2).png" /></p>',
      ['/api/attachments/42/'],
      '/api/local-attachments/42/',
      false,
    );

    expect(refs).toEqual([{ local: 'my diagram (v2).png', target: 'my diagram (v2).png' }]);
    expect(html).toContain('/api/local-attachments/42/my%20diagram%20(v2).png');
  });

  // ── #1169: the anchor arm is live, not defensive ──────────────────────────
  //
  // The Markdown import (#1133) produces `<a href="/api/attachments/<key>/…">`
  // whenever a link targets an internal attachment URL, and `htmlToConfluence`
  // *preserves* the anchor rather than dropping it — so one reaches `body_html`
  // and survives a storage-format round-trip. A move stages the bytes under the
  // new key and then deletes the old cache directory, so an un-rewritten anchor
  // is a dead link. Only images are *marked* for publish; the href itself is
  // re-keyed in both directions.

  it('rewrites anchor hrefs, not just image sources', () => {
    const { html, refs } = rewriteAttachmentRefs(
      '<p><a href="/api/attachments/42/spec.pdf">Spec</a></p>',
      ['/api/attachments/42/'],
      '/api/local-attachments/42/',
      false,
    );

    expect(html).toContain('href="/api/local-attachments/42/spec.pdf"');
    expect(refs).toEqual([{ local: 'spec.pdf', target: 'spec.pdf' }]);
  });

  it('re-keys the anchor the Markdown import actually produces', async () => {
    // Pins the producer rather than a hand-written string: if `markdownToHtml`
    // ever stops emitting a bare `href`, this stops being a live path and the
    // arm above can be revisited.
    const imported = await markdownToHtml('[Spec](/api/attachments/42/spec.pdf)');
    expect(imported).toContain('href="/api/attachments/42/spec.pdf"');
    // It also survives the storage round-trip, so it is still there by the time
    // a relocate reads `body_html` back.
    expect(htmlToConfluence(imported)).toContain('href="/api/attachments/42/spec.pdf"');

    const { html } = rewriteAttachmentRefs(
      imported,
      ['/api/attachments/42/'],
      '/api/local-attachments/42/',
      false,
    );

    expect(html).toContain('href="/api/local-attachments/42/spec.pdf"');
  });

  it('re-keys an anchor on publish without marking it as an attachment', () => {
    // `htmlToConfluence` converts only `img[src^="/api/attachments/"]` into an
    // `ri:attachment`, so marking an anchor would be a lie. The href is
    // re-keyed onto the cache prefix and nothing more.
    const { html } = rewriteAttachmentRefs(
      '<p><a href="/api/local-attachments/42/spec.pdf">Spec</a></p>',
      ['/api/local-attachments/42/'],
      '/api/attachments/900001/',
      true,
    );

    expect(html).toContain('href="/api/attachments/900001/spec.pdf"');
    expect(html).not.toContain('data-confluence-filename');
  });

  it('leaves an unrelated page\'s attachments alone', () => {
    const input = '<p><img src="/api/attachments/99/other.png" /></p>';

    const { html, refs } = rewriteAttachmentRefs(
      input,
      ['/api/attachments/42/'],
      '/api/attachments/900001/',
      true,
    );

    expect(html).toBe(input);
    expect(refs).toEqual([]);
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
      refs: [],
    });
    expect(rewriteAttachmentRefs('<p>text</p>', ['/api/attachments/42/'], '/x/', true)).toEqual({
      html: '<p>text</p>',
      refs: [],
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

describe('relocate collab invalidation', () => {
  it('409s a live collab room and DELETEs BYTEA after each body_html rewrite', () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'page-relocate-service.ts'),
      'utf8',
    );
    expect(src).toMatch(/rejectIfLiveCollabRoom/);
    const bodyHtmlUpdates = [...src.matchAll(/body_html\s*=/g)];
    expect(bodyHtmlUpdates.length).toBeGreaterThanOrEqual(3);
    expect(src).toMatch(/invalidateCollabDocAfterBodyWrite\(page\.id, txClient\)/);
    expect(src).toMatch(/invalidateCollabDocAfterBodyWrite\(snapshot\.id, txClient\)/);
    const invalidateCalls = [...src.matchAll(/invalidateCollabDocAfterBodyWrite\(/g)];
    expect(invalidateCalls.length).toBe(3);
  });
});
