import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

// #1956: the schema renders the deprecated `align` attribute. A browser applies it as a presentational hint, which any
// author rule beats, and `.prose :where(th)` sets `text-align: left`, so a header cell needs an explicit rule. The
// rendering itself was verified in a real browser (epic evidence); this pins the rules that make it work.
const css = readFileSync(resolve(__dirname, 'index.css'), 'utf-8');

describe('table cell alignment stylesheet (#1956)', () => {
  it.each(['left', 'center', 'right'])('aligns a header or body cell carrying align="%s"', (align) => {
    const rule = new RegExp(String.raw`\.tiptap :is\(th, td\)\[align="${align}"\]\s*\{\s*text-align:\s*${align};\s*\}`);
    expect(css).toMatch(rule);
  });

  it('keeps the rules above the left-aligned prose header rule in specificity: no !important, a class and an attribute', () => {
    const block = css.slice(css.indexOf('.tiptap :is(th, td)[align="left"]'), css.indexOf('/* ProseMirror multi-cell selection highlight'));
    expect(block).not.toContain('!important');
    expect(css).toMatch(/\.prose :where\(th\) \{[^}]*text-align: left;/);
  });
});
