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
    const rule = /\.article-measure\s+\.tiptap\s*>\s*:is\(([^)]*)\)\s*\{([^}]*)\}/.exec(css);
    expect(rule, 'prose allow-list rule not found').not.toBeNull();
    expect(rule![2]).toMatch(/max-width:\s*var\(--measure-article\)/);
    expect(rule![2], 'children must centre, or the column hugs one edge').toMatch(
      /margin-inline:\s*auto/,
    );
  });

  // Whether these selectors match the DOM is asserted by rendering, in
  // `shared/components/article/article-measure-dom.test.tsx`. A CSS-text test
  // cannot tell a live selector from a dead one — the previous version of this
  // file certified three selectors that matched nothing the app renders.
  it.each(['p', 'h2', 'ul', 'ol', 'blockquote', 'hr'])(
    'measures <%s>',
    (tag) => {
      const rule = /\.article-measure \.tiptap > :is\(([^)]*)\)/.exec(css);
      const tags = rule![1].split(',').map((s) => s.trim());
      expect(tags).toContain(tag);
    },
  );

  it('is an allow-list of prose, never a deny-list of wide blocks', () => {
    // `> *` plus exemptions is the shape that failed: a missed exemption
    // silently shrinks a diagram, and the reader and editor do not render the
    // same element for a code block, so one list cannot cover both.
    expect(/\.article-measure \.tiptap > \*/.test(css)).toBe(false);
    const rule = /\.article-measure \.tiptap > :is\(([^)]*)\)/.exec(css);
    for (const sel of rule![1].split(',').map((s) => s.trim())) {
      expect(sel, `${sel} must be a bare tag name — classes and attributes can silently miss`)
        .toMatch(/^[a-z][a-z0-9]*$/);
    }
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

  // A single toMatch was satisfied by either read shell, so one branch could
  // lose the class silently. Count them, and cover edit mode — which the first
  // version missed entirely, leaving the title 1200px wide above a 40rem body.
  it('puts the document-column class on every shell that renders a title', () => {
    const page = readFileSync(resolve(dir, 'features/pages/PageViewPage.tsx'), 'utf-8');
    const hits = page.match(/className="article-document /g) ?? [];
    expect(
      hits.length,
      'expected three: the empty-page shell, the reading shell, and the edit-mode title',
    ).toBe(3);

    // The edit-mode title lives in its own wrapper, not the reading shell.
    const editBranch = page.slice(page.indexOf('{editing ? ('), page.indexOf('data-testid="article-content-shell"'));
    expect(
      editBranch,
      'the edit-mode title must be measured, or it hangs left of its own paragraphs',
    ).toMatch(/article-document/);
  });

  // `Editor` carries `article-measure` for every caller, so any route that
  // renders its own title beside it has to measure that title too.
  it('measures the New Page title, which shares the Editor', () => {
    const newPage = readFileSync(resolve(dir, 'features/pages/NewPagePage.tsx'), 'utf-8');
    expect(newPage).toMatch(/article-document/);
  });

  // An input is inline-block, and `margin-inline: auto` is a no-op on an inline
  // box — the title renders at the right WIDTH but stays left-aligned in a
  // column whose body is centred. Measured, this was a 240px offset.
  it.each([
    ['features/pages/PageViewPage.tsx', 'the edit-mode title'],
    ['features/pages/NewPagePage.tsx', 'the New Page title'],
  ])('gives %s input `block` so auto margins can centre it', (file) => {
    const src = readFileSync(resolve(dir, file), 'utf-8');
    expect(
      src,
      'a measured <input> needs `block`, or auto margins do nothing',
    ).toMatch(/className="block w-full/);
  });

  // If these drift apart the line breaks move the moment you press Edit, and
  // again on Save — the reader and the writer must see the same shape.
  it('is carried by BOTH the reader and the editor', () => {
    // Matched as a class-string literal rather than by distance from `cn(` — a
    // comment growing above it must not be able to fail this.
    expect(viewer, 'ArticleViewer lost article-measure').toMatch(
      /'[^']*\barticle-measure\b[^']*'/,
    );
    expect(editor, 'Editor lost article-measure').toMatch(/'[^']*\barticle-measure\b[^']*'/);
  });

  it('keeps max-w-none on the containers, which the child rule depends on', () => {
    // Removing it would re-clamp the container to Tailwind's 65ch and take the
    // wide blocks down with it.
    expect(viewer).toMatch(/article-measure[^']*max-w-none|max-w-none[^']*article-measure/);
    expect(editor).toMatch(/article-measure[^']*max-w-none|max-w-none[^']*article-measure/);
  });
});
