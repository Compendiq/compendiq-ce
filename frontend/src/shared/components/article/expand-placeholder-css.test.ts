import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * The untitled-expand placeholder must render OUT OF FLOW (#1227).
 *
 * `article-extensions.ts` stamps `data-expand-placeholder` on an empty
 * `detailsSummary` and `index.css` paints it with a `::before`. An in-flow
 * `::before` is laid out ahead of the text position, which pushes the caret
 * past its own width — and the toolbar insert
 * (`Editor.tsx`'s `insertExpandSection`) deliberately drops the caret in that
 * very summary, so this is the first thing an author sees after clicking the
 * button. Measured in Chromium against ProseMirror's real empty-summary DOM
 * (`<summary><br class="ProseMirror-trailingBreak"></summary>`): in flow, the
 * first typed character lands 178px from the summary's left edge — 161px of
 * label plus the disclosure marker — against 17px once the label is taken out
 * of flow. The author types visually behind a label that then disappears.
 *
 * The obvious objection is that a summary is the click target for the whole
 * section and so needs its height, which is why the first cut of #1227 left
 * the label in flow on purpose. Measurement says it costs nothing: an empty
 * summary is 33px tall with `float: left; height: 0`, with an
 * absolutely-positioned variant, AND with no placeholder rule at all. The
 * trailing `<br>` — which ProseMirror renders in editable and non-editable
 * mode alike — is what gives the line its height.
 *
 * No render test can see any of this: jsdom performs no layout, so the
 * `::before` has no box and the caret has no position. Hence a source-level
 * invariant, failing by name so the reader knows what went back in flow.
 */
describe('untitled expand placeholder CSS (#1227)', () => {
  const css = readFileSync(resolve(__dirname, '../../../index.css'), 'utf-8');

  const rule = (() => {
    const start = css.indexOf('.tiptap summary[data-expand-placeholder]::before');
    expect(start, 'the placeholder rule is gone from index.css').toBeGreaterThan(-1);
    const open = css.indexOf('{', start);
    return css.slice(open + 1, css.indexOf('}', open));
  })();

  it('paints the label from the decoration attribute', () => {
    expect(rule).toContain('content: attr(data-expand-placeholder)');
  });

  it('keeps the label out of flow so the caret starts at the summary', () => {
    // The same idiom as `.tiptap p.is-editor-empty:first-child::before`. An
    // absolutely-positioned variant measures identically and would be just as
    // correct — what must not come back is a label with no out-of-flow
    // property at all.
    const outOfFlow = /float:\s*left/.test(rule) || /position:\s*absolute/.test(rule);
    expect(outOfFlow, 'placeholder label is back in flow — the caret will sit behind it').toBe(true);
    if (/float:\s*left/.test(rule)) expect(rule).toMatch(/height:\s*0/);
  });

  it('does not swallow clicks meant for the summary', () => {
    expect(rule).toMatch(/pointer-events:\s*none/);
  });
});

describe('expand module chrome', () => {
  const css = readFileSync(resolve(__dirname, '../../../index.css'), 'utf-8');

  it('hides the UA disclosure marker so the drawn chevron is the only affordance', () => {
    expect(css).toMatch(/details > summary.*::-webkit-details-marker/s);
    expect(css).toMatch(/details > summary.*::marker/s);
  });

  it('does not wrap the section in a card', () => {
    const start = css.indexOf('.prose :where(details) {');
    expect(start).toBeGreaterThan(-1);
    const block = css.slice(start, css.indexOf('}', start));
    expect(block).toMatch(/border:\s*none/);
    expect(block).toMatch(/background:\s*transparent/);
  });

  it('draws the chevron on the summary so it centers on the title line', () => {
    expect(css).toContain('.prose :where(details > summary)::after');
    expect(css).toContain('.prose :where(details[open] > summary)::after');
    expect(css).toMatch(/translateY\(-50%\)\s+rotate\(-45deg\)/);
  });
});
