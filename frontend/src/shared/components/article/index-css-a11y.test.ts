import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Regression tests for #951 — code-copy and draw.io controls that are hidden
 * with opacity:0 and revealed only on :hover must also be revealed on keyboard
 * focus, otherwise keyboard users can never see them (WCAG 2.4.7 Focus Visible).
 *
 * jsdom cannot compute focus-visible opacity from a stylesheet, so the reliable
 * check is that index.css declares a focus-based reveal selector for each
 * hover-revealed control. Each reveal must set opacity back to 1.
 */

const cssPath = resolve(__dirname, '../../../index.css');
const css = readFileSync(cssPath, 'utf-8');

/** Collapse whitespace so selector assertions are insensitive to formatting. */
const normalized = css.replace(/\s+/g, ' ');

/** Return the `{ ... }` declaration body for the first rule matching `selector`. */
function ruleBody(selector: string): string {
  const idx = normalized.indexOf(selector);
  expect(idx, `selector not found: ${selector}`).toBeGreaterThanOrEqual(0);
  const open = normalized.indexOf('{', idx);
  const close = normalized.indexOf('}', open);
  return normalized.slice(open + 1, close);
}

describe('#951 keyboard focus reveals hover-only controls', () => {
  it('code-copy button is revealed when the pre or the button receives focus', () => {
    const revealsOnFocus =
      normalized.includes('pre:focus-within .code-copy-btn') ||
      normalized.includes('.code-copy-btn:focus-visible') ||
      normalized.includes('.code-copy-btn:focus');
    expect(revealsOnFocus).toBe(true);

    if (normalized.includes('pre:focus-within .code-copy-btn')) {
      expect(ruleBody('pre:focus-within .code-copy-btn')).toContain('opacity: 1');
    }
  });

  it('inline draw.io edit button is revealed on keyboard focus', () => {
    const revealsOnFocus =
      normalized.includes('.confluence-drawio:focus-within .drawio-inline-edit-btn') ||
      normalized.includes('.drawio-inline-edit-btn:focus-visible') ||
      normalized.includes('.drawio-inline-edit-btn:focus');
    expect(revealsOnFocus).toBe(true);

    if (normalized.includes('.confluence-drawio:focus-within .drawio-inline-edit-btn')) {
      expect(
        ruleBody('.confluence-drawio:focus-within .drawio-inline-edit-btn'),
      ).toContain('opacity: 1');
    }
  });

  it('draw.io node-view overlay is revealed when the node view receives focus', () => {
    expect(normalized).toContain(
      '.drawio-nodeview:focus-within .drawio-nodeview__overlay',
    );
    expect(
      ruleBody('.drawio-nodeview:focus-within .drawio-nodeview__overlay'),
    ).toContain('opacity: 1');
  });
});
