import { describe, it, expect } from 'vitest';
import { protectMedia, restoreMedia, htmlToMarkdown, markdownToHtml } from './content-converter.js';

const DRAWIO = '<div class="confluence-drawio" data-diagram-name="Arch"><img src="/api/attachments/5/Arch.png" alt="d"><a class="drawio-edit-link" data-drawio="true" href="#">Edit</a></div>';
const IMG = '<img src="/api/attachments/5/photo.png" data-confluence-image-source="attachment" data-confluence-filename="photo.png" alt="Photo">';

describe('protectMedia / restoreMedia', () => {
  it('replaces media with deterministic tokens and restores them verbatim', () => {
    const html = `<p>Intro</p>${IMG}<p>Mid</p>${DRAWIO}<p>End</p>`;
    const { html: protectedHtml, media } = protectMedia(html);
    expect(protectedHtml).toContain('CQ_MEDIA_PLACEHOLDER_0');
    expect(protectedHtml).toContain('CQ_MEDIA_PLACEHOLDER_1');
    expect(protectedHtml).not.toContain('confluence-drawio');
    expect(media).toHaveLength(2);

    const restored = restoreMedia(protectedHtml, media);
    expect(restored).toContain('data-diagram-name="Arch"');
    expect(restored).toContain('data-confluence-filename="photo.png"');
  });

  it('is deterministic — same input yields the same token order', () => {
    const html = `${IMG}${DRAWIO}`;
    expect(protectMedia(html).media.map((m) => m.token))
      .toEqual(protectMedia(html).media.map((m) => m.token));
  });

  it('survives a full markdown round-trip and re-injects media (LLM-drops-line safe)', async () => {
    const html = `<p>Intro</p>${DRAWIO}${IMG}`;
    const { html: protectedHtml, media } = protectMedia(html);
    const md = htmlToMarkdown(protectedHtml);
    // turndown escapes underscores so CQ_MEDIA_PLACEHOLDER_0 → CQ\_MEDIA\_PLACEHOLDER\_0
    expect(md).toContain('CQ\\_MEDIA\\_PLACEHOLDER\\_0');
    const back = restoreMedia(await markdownToHtml(md), media);
    expect(back).toContain('confluence-drawio');
    expect(back).toContain('data-confluence-filename');
  });
});

describe('confluence-drawio turndown <-> markdownToHtml round-trip (#723 converter coverage)', () => {
  it('drawio survives a direct htmlToMarkdown → markdownToHtml round-trip', async () => {
    const html = '<div class="confluence-drawio" data-diagram-name="Net Arch"><img src="/api/attachments/5/Net%20Arch.png"></div>';
    const md = htmlToMarkdown(html);
    expect(md).toContain('```drawio');
    expect(md).toContain('Net Arch');
    const back = await markdownToHtml(md);
    expect(back).toContain('class="confluence-drawio"');
    expect(back).toContain('data-diagram-name="Net Arch"');
  });
});
