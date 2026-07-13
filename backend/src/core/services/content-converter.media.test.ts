import { describe, it, expect } from 'vitest';
import {
  protectMedia,
  restoreMedia,
  htmlToMarkdown,
  markdownToHtml,
  confluenceToHtml,
  htmlToConfluence,
} from './content-converter.js';

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

  it('restores media whose src contains $-replacement sequences byte-identically (#723)', () => {
    // Confluence attachment URLs / encoded query strings legitimately contain
    // `$`. As a replacement string, `$&`, `$1`, `` $` ``, `$'`, `$$` would be
    // interpreted as String.replace special patterns and corrupt the media.
    const trickyImg =
      '<img src="/api/attachments/5/a$1$&b$$c$`d$\'e.png" alt="Photo">';
    const html = `<p>Intro</p>${trickyImg}<p>End</p>`;
    const { html: protectedHtml, media } = protectMedia(html);
    expect(protectedHtml).toContain('CQ_MEDIA_PLACEHOLDER_0');
    // The stored original (outerHTML) carries the literal `$` sequences.
    const original = media[0]!.html;
    expect(original).toContain('$1$');
    expect(original).toContain('$$');

    // Bare-token path must reproduce the original byte-identically.
    const restored = restoreMedia(protectedHtml, media);
    expect(restored).toContain(original);

    // And the <p>TOKEN</p> path that markdown produces — must restore to
    // EXACTLY the original (no `$&`/`$1`/`$$` interpretation leaking garbage).
    const wrapped = '<p>CQ_MEDIA_PLACEHOLDER_0</p>';
    expect(restoreMedia(wrapped, media)).toBe(original);
  });

  it('does not corrupt a later token nested inside an earlier media element (#723)', () => {
    // An earlier media element whose alt/data-diagram-name literally contains a
    // *later* placeholder token must not be re-scanned when the later token is
    // restored, or the injected media would be rewritten in place.
    const earlier =
      '<img src="/api/attachments/5/x.png" alt="see CQ_MEDIA_PLACEHOLDER_1 below">';
    const later = '<img src="/api/attachments/5/y.png" alt="Later">';
    const html = `<p>Intro</p>${earlier}<p>Mid</p>${later}<p>End</p>`;
    const { html: protectedHtml, media } = protectMedia(html);
    expect(media).toHaveLength(2);
    const [earlierOriginal, laterOriginal] = [media[0]!.html, media[1]!.html];
    expect(earlierOriginal).toContain('CQ_MEDIA_PLACEHOLDER_1');

    const restored = restoreMedia(protectedHtml, media);
    // Both originals present verbatim, exactly once each.
    expect(restored).toContain(earlierOriginal);
    expect(restored).toContain(laterOriginal);
    expect(restored.split(laterOriginal).length - 1).toBe(1);
    // The literal token text inside `earlier`'s alt must survive untouched —
    // it must NOT have been replaced by `later`'s HTML.
    expect(restored).toContain('alt="see CQ_MEDIA_PLACEHOLDER_1 below"');
  });

  it('does not let token N match the prefix of token N0..N9 (#723)', () => {
    // 11 media so tokens reach CQ_MEDIA_PLACEHOLDER_10. Token 1 must not match
    // the leading "..._1" of "..._10".
    const imgs = Array.from(
      { length: 11 },
      (_v, i) => `<img src="/api/attachments/5/img${i}.png" alt="i${i}">`,
    );
    const html = imgs.map((m, i) => `<p>p${i}</p>${m}`).join('');
    const { html: protectedHtml, media } = protectMedia(html);
    expect(media).toHaveLength(11);

    const restored = restoreMedia(protectedHtml, media);
    for (const m of media) {
      expect(restored).toContain(m.html);
      expect(restored.split(m.html).length - 1).toBe(1);
    }
    // No leftover token fragments.
    expect(restored).not.toContain('CQ_MEDIA_PLACEHOLDER_');
  });

  it('opaque-protects an unknown-macro placeholder so AI-Improve cannot flatten it (#865)', () => {
    // Before #865 the unknown-macro div was NOT in MEDIA_SELECTOR, so the
    // AI-Improve HTML→Markdown→HTML round-trip flattened the placeholder text
    // into prose and htmlToConfluence rebuilt nothing. Freezing it whole keeps
    // it intact across the round-trip.
    const unknown =
      '<div class="confluence-macro-unknown" data-macro-name="roadmap">[Confluence macro: roadmap]</div>';
    const html = `<p>Intro</p>${unknown}<p>End</p>`;
    const { html: protectedHtml, media } = protectMedia(html);
    expect(media).toHaveLength(1);
    expect(protectedHtml).toContain('CQ_MEDIA_PLACEHOLDER_0');
    expect(protectedHtml).not.toContain('confluence-macro-unknown');

    const restored = restoreMedia(protectedHtml, media);
    expect(restored).toContain('class="confluence-macro-unknown"');
    expect(restored).toContain('data-macro-name="roadmap"');
  });

  it('unknown-macro placeholder survives a full markdown round-trip (#865)', async () => {
    const unknown =
      '<div class="confluence-macro-unknown" data-macro-name="roadmap">[Confluence macro: roadmap]</div>';
    const html = `<p>Intro</p>${unknown}`;
    const { html: protectedHtml, media } = protectMedia(html);
    const md = htmlToMarkdown(protectedHtml);
    const back = restoreMedia(await markdownToHtml(md), media);
    expect(back).toContain('confluence-macro-unknown');
    expect(back).toContain('data-macro-name="roadmap"');
  });
});

describe('atomic macro placeholders survive the AI-Improve round-trip (#901)', () => {
  // toc / children / attachments / include / jira / status / user-mention hold
  // no LLM-editable prose. Before #901 they were NOT in MEDIA_SELECTOR, so the
  // AI-Improve HTML→Markdown→HTML round-trip flattened them to plain text
  // ([Table of Contents], [JIRA: PROJ-42], @alice, …) and htmlToConfluence
  // rebuilt nothing — the macro was permanently lost on write-back.
  const STORAGE = [
    '<p>Intro</p>',
    '<ac:structured-macro ac:name="toc"><ac:parameter ac:name="maxLevel">3</ac:parameter></ac:structured-macro>',
    '<p>See <ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">PROJ-42</ac:parameter></ac:structured-macro> assigned to ',
    '<ac:link><ri:user ri:username="alice"/></ac:link>.</p>',
  ].join('');

  it('round-trips toc, jira and user-mention macros back to storage format', async () => {
    const html = confluenceToHtml(STORAGE);
    const { html: prot, media } = protectMedia(html);
    const md = htmlToMarkdown(prot);
    const rebuilt = await markdownToHtml(md);
    const restored = restoreMedia(rebuilt, media);
    const back = htmlToConfluence(restored);

    expect(back).toContain('ac:name="toc"');
    expect(back).toContain('PROJ-42');
    expect(back).toContain('ri:user');
    expect(back).toContain('ri:username="alice"');
  });

  it('protectMedia freezes the atomic placeholders as tokens', () => {
    const html = confluenceToHtml(STORAGE);
    const { html: prot, media } = protectMedia(html);
    // toc div + jira span + user-mention span are all frozen.
    expect(media).toHaveLength(3);
    expect(prot).not.toContain('confluence-toc');
    expect(prot).not.toContain('confluence-jira-issue');
    expect(prot).not.toContain('confluence-user-mention');
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
