import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const inspectorSource = readFileSync(
  resolve(__dirname, '../../shared/components/article/ArticleRightPane.tsx'),
  'utf-8',
);

/**
 * `Edit` is the only first-class chrome action on `/pages/:id` in read mode.
 * It lives on the same sticky 48px chassis as the write toolbar, at the same
 * 32px (`h-8`) box as every format-toolbar control. Labels sit beside it as
 * pills, not inside a count button. Operate verbs live in the inspector.
 * It used to be 12px ghost text in a ~24px box, last in a wrapping operate
 * row, so at 834px and 390px it landed alone below the 44px thumb minimum.
 *
 * This is a hierarchy fact, not a layout one — jsdom cannot measure it and a
 * render test would only assert the class string anyway, so it is checked here
 * where the intent can be stated.
 */
const source = readFileSync(
  resolve(__dirname, 'PageViewPage.tsx'),
  'utf-8',
);

/** The JSX for the Edit trigger, from its testid back to the opening tag. */
function editButton(): string {
  const anchor = source.indexOf('data-testid="edit-page-btn"');
  expect(anchor, 'Edit button not found by testid').toBeGreaterThan(-1);
  const open = source.lastIndexOf('<button', anchor);
  return source.slice(open, source.indexOf('</button>', anchor));
}

describe('the Edit affordance', () => {
  it('is a real button, not ghost text at the weight of the secondaries', () => {
    expect(editButton()).toMatch(/nm-button-ghost/);
  });

  it('never shrinks or wraps away from the end of the row', () => {
    expect(editButton()).toMatch(/shrink-0/);
  });

  it('uses the same 32px box as the format-toolbar controls', () => {
    expect(editButton()).toMatch(/nm-button-ghost/);
    expect(editButton()).toMatch(/\bh-8\b/);
    expect(editButton()).toMatch(/px-2\.5/);
    expect(editButton()).toMatch(/text-xs/);
    expect(editButton()).not.toMatch(/max-sm:min-h-11/);
    // Write-mode sticky chassis still matches the 48px header line.
    expect(source).toContain('min-h-[calc(3rem-1px)]');
  });

  it('keeps its keyboard hint', () => {
    expect(editButton()).toMatch(/shortcutId="toggle-edit"/);
  });

  it('hosts layout presets on the inspector, not the article header strip', () => {
    expect(source).not.toContain('LayoutPresetMenu');
    expect(source).not.toContain('useArticleLayoutControls');
    expect(inspectorSource).toContain('LayoutPresetMenu');
    expect(inspectorSource).toContain('useArticleLayoutControls');
  });

  // The accent belongs to actions, and the only filled Steel on this route is
  // the setup banner's. A second filled button would move the competition
  // rather than end it.
  it('is not the filled primary', () => {
    expect(editButton()).not.toMatch(/nm-button-primary/);
  });
});
