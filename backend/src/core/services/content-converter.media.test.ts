import { describe, it, expect } from 'vitest';
import {
  protectMedia,
  restoreMedia,
  htmlToMarkdown,
  markdownToHtml,
  confluenceToHtml,
  htmlToConfluence,
  extractLayoutSkeleton,
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

describe('expand sections survive the AI-Improve round-trip (#1221)', () => {
  // Before #1221, `details` was absent from MEDIA_SELECTOR and has no turndown
  // rule, so the AI-Improve HTML→Markdown→HTML round-trip flattened an expand
  // section into bare paragraphs — <summary> became prose, the #1211 identity
  // stamp was lost, and htmlToConfluence rebuilt no macro at all. On apply that
  // deletion was pushed to the customer's Confluence page.
  //
  // Stage 1 froze every <details>. Stage 2 keeps that freeze only where a
  // boundary token cannot survive — inside a markdown-constrained container —
  // and lets every other section round-trip as [[[EXPAND …]]] tokens, which is
  // what makes its body improvable again. These cases cover the freeze half;
  // the token half lives in content-converter.test.ts.
  const EXPAND =
    '<details data-macro-name="expand"><summary>Secret</summary><p>hidden body</p></details>';

  /** Wrap a section in each container that forces the opaque freeze. */
  const CONSTRAINED: { name: string; wrap: (inner: string) => string }[] = [
    { name: 'table cell', wrap: (i) => `<table><tbody><tr><td><p>Cell</p>${i}</td><td><p>Other</p></td></tr></tbody></table>` },
    { name: 'table header cell', wrap: (i) => `<table><tbody><tr><th><p>Head</p>${i}</th><th><p>Other</p></th></tr></tbody></table>` },
    { name: 'list item', wrap: (i) => `<ul><li><p>Item</p>${i}</li><li><p>Plain</p></li></ul>` },
    { name: 'blockquote', wrap: (i) => `<blockquote><p>Quoted</p>${i}</blockquote>` },
    { name: 'panel', wrap: (i) => `<div class="panel-info"><p>Panel</p>${i}</div>` },
  ];

  it('stays linear in nesting depth — a deep chain must not blow up protectMedia', () => {
    // The freeze walk descended into a non-frozen child expand TWICE: once
    // inside isFrozenExpand(child) and again directly, giving T(n)=2·T(n-1).
    // Measured before the fix: depth 14 ≈ 0.7s, 16 ≈ 2.9s, 18 ≈ 12.5s, 20 ≈ 56s
    // — synchronous on the Improve/apply request path, so a deep page written
    // by any user blocks the whole backend. A nested <details> needs no walk at
    // all: whatever it does, it is self-consistent (see expandTokenizesCleanly).
    const depth = 18;
    let html = '<p>core</p>';
    for (let i = depth; i > 0; i--) {
      html = `<details data-macro-name="expand"><summary>L${i}</summary>${html}</details>`;
    }
    const started = Date.now();
    const { media } = protectMedia(html);
    const elapsed = Date.now() - started;
    expect(media).toHaveLength(0); // nothing constrained — every level tokenises
    expect(elapsed).toBeLessThan(1000);
  });

  it('leaves an unconstrained section unfrozen so its body can be improved', () => {
    const { html: prot, media } = protectMedia(`<p>Intro</p>${EXPAND}<p>End</p>`);
    expect(media).toHaveLength(0);
    expect(prot).toContain('<details');
    expect(prot).not.toContain('CQ_MEDIA_PLACEHOLDER');
  });

  it('tokenises nested sections separately instead of freezing the outer one whole', () => {
    const nested =
      '<details data-macro-name="expand"><summary>Outer</summary>' +
      '<p>outer body</p>' +
      '<details data-macro-name="expand"><summary>Inner</summary><p>inner body</p></details>' +
      '</details>';
    const { html: prot, media } = protectMedia(`<p>Intro</p>${nested}`);
    expect(media).toHaveLength(0);
    const md = htmlToMarkdown(prot, { layoutTokens: true });
    expect((md.match(/\[\[\[EXPAND /g) ?? []).length).toBe(2);
    expect(md).toContain('outer body');
    expect(md).toContain('inner body');
  });

  it('gives media inside an unconstrained section its own token, not one capture for the section', () => {
    const withImg = `<details data-macro-name="expand"><summary>Pics</summary>${IMG}${DRAWIO}</details>`;
    const { html: prot, media } = protectMedia(`<p>Intro</p>${withImg}`);
    // The image and the drawio wrapper each get a token; the section does not.
    expect(media).toHaveLength(2);
    expect(media.every((m) => !m.html.includes('<details'))).toBe(true);
    expect(prot).toContain('<details');
    // Both originals come back verbatim, still inside the section. (The token
    // swap pads with spaces, so the section is not byte-identical.)
    const restored = restoreMedia(prot, media);
    for (const m of media) expect(restored).toContain(m.html);
    expect(restored.indexOf('data-confluence-filename')).toBeGreaterThan(restored.indexOf('<details'));
    expect(restored.indexOf('confluence-drawio')).toBeLessThan(restored.indexOf('</details>'));
  });

  for (const { name, wrap } of CONSTRAINED) {
    it(`freezes a section inside a ${name} as an opaque token`, () => {
      const { html: prot, media } = protectMedia(wrap(EXPAND));
      expect(media).toHaveLength(1);
      expect(media[0]!.html).toBe(EXPAND);
      expect(prot).toContain('CQ_MEDIA_PLACEHOLDER_0');
      expect(prot).not.toContain('<details');
      expect(restoreMedia(prot, media)).toContain(EXPAND);
    });
  }

  it('freezes a section inside a table cell without breaking the table', async () => {
    const html =
      '<table><tbody><tr><td><p>Cell</p>' +
      '<details data-macro-name="expand"><summary>In cell</summary><p>cell body</p></details>' +
      '</td><td><p>Other</p></td></tr></tbody></table>';
    const { html: prot, media } = protectMedia(html);
    expect(media).toHaveLength(1);

    const restored = restoreMedia(
      await markdownToHtml(htmlToMarkdown(prot, { layoutTokens: true })),
      media,
    );
    expect(restored).toContain('data-macro-name="expand"');
    expect(restored).toContain('<summary>In cell</summary>');
    // The token rode inside the cell — the table itself is still intact and the
    // section did not leak out of it.
    expect(restored).toContain('<td>');
    expect(restored).not.toContain('CQ_MEDIA_PLACEHOLDER_');
  });

  it('freezes a section nested inside a constrained one, and only the outermost', () => {
    // The outer section is inside a table cell, so it freezes; the inner one
    // travels inside that capture rather than getting a token of its own.
    const inner = '<details data-macro-name="expand"><summary>Inner</summary><p>inner body</p></details>';
    const outer = `<details data-macro-name="expand"><summary>Outer</summary><p>outer body</p>${inner}</details>`;
    const { html: prot, media } = protectMedia(`<table><tbody><tr><td>${outer}</td></tr></tbody></table>`);
    expect(media).toHaveLength(1);
    expect(media[0]!.html).toBe(outer);
    expect(prot).not.toContain('<details');
  });

  it('protects an unfrozen section nested inside a frozen one at the right level', () => {
    // Outer is NOT constrained, so it tokenises; the inner one sits in a table
    // cell inside it and must still freeze. Freezing is decided per section, not
    // inherited from the nearest <details>.
    const inner = '<details data-macro-name="expand"><summary>Inner</summary><p>inner body</p></details>';
    const outer =
      '<details data-macro-name="expand"><summary>Outer</summary>' +
      `<table><tbody><tr><td>${inner}</td></tr></tbody></table></details>`;
    const { html: prot, media } = protectMedia(outer);
    expect(media).toHaveLength(1);
    expect(media[0]!.html).toBe(inner);
    // The outer section survived as a real element for the token pass.
    expect(prot).toContain('<summary>Outer</summary>');
  });

  it('freezes a section containing a modern layout grid, which cannot open inside an expand', () => {
    // `ac:layout` is document-level in Confluence storage format, so [[[LAYOUT]]]
    // is only valid at the top of the token stack. A grid nested inside a
    // <details> (reachable in the editor — the layout node is `block` and the
    // details accepts `block*`) would therefore emit a token sequence that
    // rebuildLayoutStructure rejects, and the drop-guard would strip EVERY
    // token — flattening the expand away, i.e. the exact silent macro deletion
    // #1221 exists to prevent. Freeze the section instead: its body is not
    // improvable, but it survives.
    const grid =
      '<div class="confluence-layout"><div class="confluence-layout-section" data-layout-type="two_equal">' +
      '<div class="confluence-layout-cell"><p>L</p></div>' +
      '<div class="confluence-layout-cell"><p>R</p></div>' +
      '</div></div>';
    const withGrid = `<details data-macro-name="expand"><summary>Grid</summary>${grid}</details>`;
    const { html: prot, media } = protectMedia(withGrid);
    expect(media).toHaveLength(1);
    expect(media[0]!.html).toBe(withGrid);
    // Symmetric: neither the skeleton nor the markdown carries a token for it.
    expect(extractLayoutSkeleton(prot)).toEqual([]);
    expect(htmlToMarkdown(prot, { layoutTokens: true })).not.toContain('[[[');
    expect(restoreMedia(prot, media)).toContain(withGrid);
  });

  it('keeps the #781 layout skeleton in step with what the markdown can carry', () => {
    // extractLayoutSkeleton runs over the PROTECTED html (llm-conversations.ts),
    // so a legacy section frozen away inside a CONSTRAINED expand must not be
    // expected as a boundary token — otherwise every apply on such a page 422s.
    // Pinned rather than left to inspection: the failure would be a hard 422.
    const frozen =
      '<table><tbody><tr><td>' +
      '<details data-macro-name="expand"><summary>Wrapper</summary>' +
      '<div class="confluence-section"><div class="confluence-column"><p>col</p></div></div>' +
      '</details></td></tr></tbody></table>';
    const { html: prot, media } = protectMedia(frozen);
    expect(media).toHaveLength(1);
    // Symmetric: neither side sees the frozen subtree.
    expect(extractLayoutSkeleton(prot)).toEqual([]);
    expect(htmlToMarkdown(prot, { layoutTokens: true })).not.toContain('[[[');

    // An UNCONSTRAINED expand around the same layout is visible to both sides.
    const open =
      '<details data-macro-name="expand"><summary>Wrapper</summary>' +
      '<div class="confluence-section"><div class="confluence-column"><p>col</p></div></div>' +
      '</details>';
    const openProt = protectMedia(open).html;
    expect(extractLayoutSkeleton(openProt).map((t) => t.kind)).toEqual([
      'EXPAND', 'SECTION', 'COLUMN', 'COLUMN', 'SECTION', 'EXPAND',
    ]);
    const openMd = htmlToMarkdown(openProt, { layoutTokens: true });
    for (const token of ['[[[EXPAND ', '[[[SECTION]]]', '[[[COLUMN]]]', '[[[/COLUMN]]]', '[[[/SECTION]]]', '[[[/EXPAND]]]']) {
      expect(openMd).toContain(token);
    }
    // A section OUTSIDE any expand still tokenises as before.
    expect(
      extractLayoutSkeleton(protectMedia('<div class="confluence-section"><p>x</p></div>').html)
        .map((t) => t.kind),
    ).toEqual(['SECTION', 'SECTION']);
  });

  it("anchors an expand slot on its body, never on the summary the model never sees", () => {
    // The summary rides inside the token, so it can never appear in the model's
    // prose — anchoring recovery on it would guarantee a 422.
    const { html: prot } = protectMedia(EXPAND);
    const [open] = extractLayoutSkeleton(prot);
    expect(open!.kind).toBe('EXPAND');
    expect(open!.anchor).toBe('hidden body');
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
