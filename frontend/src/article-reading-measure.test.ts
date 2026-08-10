import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * The article reading measure is a CSS-layout fact, and jsdom performs no
 * layout — no render test can see it, and a browser test would only catch it
 * after a release. So it is guarded by parsing, the same way
 * `workspace-themes.test.ts` guards the palette and `ai-scroll-chain.test.ts`
 * guards `min-h-0`.
 *
 * What this protects: the document column is 1200px and every block used to
 * fill it, which measured ~99 characters per line at 1280px, ~101 at 1512 and
 * ~133 at 1920 — roughly twice the comfortable maximum, on the surface the
 * product exists to read. The fix puts the measure on the block CHILDREN so
 * tables, code and diagrams can opt back out to the full column.
 */

const dir = __dirname;
const css = readFileSync(resolve(dir, 'index.css'), 'utf-8');
const viewer = readFileSync(
  resolve(dir, 'shared/components/article/ArticleViewer.tsx'),
  'utf-8',
);
const editor = readFileSync(resolve(dir, 'shared/components/article/Editor.tsx'), 'utf-8');

describe('Article reading measure', () => {
  it('declares the measure as a token, in a font-size-independent unit', () => {
    const m = /--measure-article:\s*([\d.]+)rem/.exec(css);
    expect(m, '--measure-article must be declared in rem').not.toBeNull();
    const rem = Number(m![1]);
    // ~40rem is ~76 characters at the article's 16px. Outside this band it is
    // not a retune, it is a regression.
    expect(rem).toBeGreaterThanOrEqual(34);
    expect(rem).toBeLessThanOrEqual(46);
  });

  // `ch` resolves against the element's OWN font-size, so one shared `64ch`
  // gave an h2 at 20px a wider box than a paragraph at 16px: headings,
  // subheadings and body each landed on a different left edge and the centred
  // column visibly came apart. This is the exact mistake the first pass made.
  it('does not express the measure in ch', () => {
    expect(
      /--measure-article:\s*[\d.]+ch/.test(css),
      'ch is font-size-relative — headings would not share the body\'s left edge',
    ).toBe(false);
  });

  it('applies the measure to the block children, not the container', () => {
    // Constraining the container instead would clamp tables, code and diagrams
    // too — which is why `max-w-none` was there in the first place.
    const rule = /\.article-measure\s+\.tiptap\s*>\s*\*\s*\{([^}]*)\}/.exec(css);
    expect(rule, '.article-measure .tiptap > * rule not found').not.toBeNull();
    expect(rule![1]).toMatch(/max-width:\s*var\(--measure-article\)/);
    expect(rule![1], 'children must centre, or the column hugs one edge').toMatch(
      /margin-inline:\s*auto/,
    );
  });

  it.each([
    ['table', 'a wide data table'],
    ['pre', 'a code block'],
    ['figure', 'a captioned image'],
    ['.tableWrapper', "TipTap's scroll wrapper"],
    ['.code-block-wrapper', 'the titled code block'],
    ['.confluence-layout', 'a Confluence column layout'],
    ['.drawio-nodeview', 'a draw.io diagram'],
  ])('lets %s (%s) break out to the full column', (selector) => {
    const breakout = css.slice(css.indexOf('.article-measure .tiptap > :is('));
    const block = breakout.slice(0, breakout.indexOf('}') + 1);
    expect(block).toContain(selector);
    expect(block).toMatch(/max-width:\s*100%/);
  });

  // Constraining only the prose left the title and label row ~100px to the left
  // of the paragraphs they belong to, and the AI summary card wider than the
  // article it summarises. The column is one edge or it reads as broken.
  it('measures the whole document column, not just the prose', () => {
    const rule = /\.article-document\s*>\s*\*\s*\{([^}]*)\}/.exec(css);
    expect(rule, '.article-document > * rule not found').not.toBeNull();
    expect(rule![1]).toMatch(/max-width:\s*var\(--measure-article\)/);
    expect(rule![1]).toMatch(/margin-inline:\s*auto/);
  });

  it('exempts the viewer container, which is the break-out track', () => {
    const rule = /\.article-document\s*>\s*\.article-viewer-container\s*\{([^}]*)\}/.exec(css);
    expect(rule, 'the viewer container must stay full width').not.toBeNull();
    expect(rule![1]).toMatch(/max-width:\s*100%/);
  });

  it('puts the document-column class on the article shell', () => {
    const page = readFileSync(resolve(dir, 'features/pages/PageViewPage.tsx'), 'utf-8');
    expect(page).toMatch(/article-document mx-auto max-w-\[1200px\]/);
  });

  // If these drift apart the line breaks move the moment you press Edit, and
  // again on Save — the reader and the writer must see the same shape.
  it('is carried by BOTH the reader and the editor', () => {
    expect(viewer, 'ArticleViewer lost article-measure').toMatch(
      /className=\{cn\([\s\S]{0,400}?article-measure/,
    );
    expect(editor, 'Editor lost article-measure').toMatch(
      /className=\{cn\([\s\S]{0,400}?article-measure/,
    );
  });

  it('keeps max-w-none on the containers, which the child rule depends on', () => {
    // Removing it would re-clamp the container to Tailwind's 65ch and take the
    // wide blocks down with it.
    expect(viewer).toMatch(/article-measure[^']*max-w-none|max-w-none[^']*article-measure/);
    expect(editor).toMatch(/article-measure[^']*max-w-none|max-w-none[^']*article-measure/);
  });
});
