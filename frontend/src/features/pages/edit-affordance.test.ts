import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * `Edit` is the primary action on `/pages/:id` and was its quietest control:
 * 12px ghost text in a ~24px box, identical in weight to Relocate / Verify /
 * Graph beside it and last in a wrapping row, so at 834px and 390px it landed
 * alone on a second line below the 44px thumb minimum. The source comment above
 * it already called it "the most used control on the page".
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

  it('uses the real secondary button so it outranks Relocate / Verify', () => {
    expect(editButton()).toMatch(/nm-button-ghost/);
    expect(editButton()).not.toMatch(/px-2\.5 py-1 text-xs/);
    expect(source).toContain('min-h-[calc(3rem-1px)]');
  });

  // 2.5.5: the row is reachable one-handed on a phone, where this used to be a
  // ~24px target in the hardest reach zone.
  it('clears a 44px touch target below the sm breakpoint', () => {
    expect(editButton()).toMatch(/max-sm:min-h-11/);
  });

  it('keeps its keyboard hint', () => {
    expect(editButton()).toMatch(/shortcutId="toggle-edit"/);
  });

  it('hosts layout presets in the article strip, not the global header', () => {
    expect(source).toContain('LayoutPresetMenu');
    expect(source).toContain('useArticleLayoutControls');
  });

  // The accent belongs to actions, and the only filled teal on this route is
  // the setup banner's. A second filled button would move the competition
  // rather than end it.
  it('is not the filled primary', () => {
    expect(editButton()).not.toMatch(/nm-button-primary/);
  });
});
