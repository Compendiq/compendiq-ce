import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Regression test for the article body's reading measure (#P1 from the
 * pages-surface critique). `.prose` set no font-size of its own, so the
 * article inherited the app's 14px UI text and, unconstrained by the outer
 * 1200px column, wrapped at up to ~128 characters per line at wide
 * viewports. jsdom performs no real layout, so — like workspace-themes.test.ts
 * — this parses the actual CSS out of index.css rather than rendering and
 * measuring pixels.
 */

const css = readFileSync(resolve(__dirname, './index.css'), 'utf-8');

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (!match) throw new Error(`No CSS rule found for selector: ${selector}`);
  return match[1]!;
}

describe('article reading measure', () => {
  it('gives .prose an explicit 16px base font-size instead of inheriting the 14px UI size', () => {
    const body = ruleBody('.prose');
    expect(body).toMatch(/font-size:\s*1rem/);
  });

  it('sets paragraph line-height to 1.65, not the cramped 1.6 the UI chrome uses', () => {
    const body = ruleBody('.prose :where(p)');
    expect(body).toMatch(/line-height:\s*1\.65/);
  });

  it('caps text elements — not the whole .prose container — at a 68ch reading measure', () => {
    // Deliberately NOT on `.prose` itself: a narrower container would also
    // drag tables, images, code blocks and Confluence macros down to 68ch,
    // when only the text needs the narrower measure.
    const capBody = ruleBody('.prose :where(h1, h2, h3, h4, h5, h6, p, li, blockquote)');
    expect(capBody).toMatch(/max-width:\s*68ch/);

    // The container itself must stay unconstrained so wide content keeps
    // using the full 1200px outer column.
    const proseBase = ruleBody('.prose');
    expect(proseBase).not.toMatch(/max-width/);
  });

  it('leaves tables at their own deliberately smaller, unconstrained size', () => {
    // Tables already opt into a denser 15px and must not be swept into the
    // 68ch text cap or the 16px base bump — both are deliberate choices for
    // tabular content, not part of the flagged reading-column regression.
    const body = ruleBody('.prose :where(table)');
    expect(body).toMatch(/font-size:\s*0\.9375rem/);
    expect(body).not.toMatch(/max-width/);
  });
});
