import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * The under-masks that hide article content in the app's scroll padding (#1186).
 *
 * AppLayout's main scroll container carries top padding. A `position: sticky`
 * box inside it does NOT come to rest against the scrollport's top edge: it is
 * clamped to its containing block, and that block begins *after* the padding.
 * Measured in Chromium at a 1440x900 viewport, a `sticky top-0` toolbar stops
 * at the scroll container's content-box top — one padding step below the edge
 * where the scrollport finally clips — so article content scrolls up through
 * that strip in full view, between the app header and the stuck toolbar.
 *
 * A surface that covers the strip does it by reaching one padding step above
 * its own box with an opaque under-mask. The height of that reach is not a
 * free choice: it is AppLayout's padding, in another file. It has already
 * drifted once (pt-4 to pt-5), and a mask that no longer matches fails
 * silently — the bleed simply returns, thinner. These invariants read both
 * numbers out of the sources rather than restating them, the same approach as
 * `nginx-api-body-limit.test.ts`.
 *
 * Exactly two surfaces are enforced here, and this file claims nothing about
 * any other:
 *   - PageViewPage's sticky edit toolbar (fixed in #1186);
 *   - NewPagePage's sticky header group, which never lost its mask.
 * `/ai` is knowingly NOT covered: both of AiAssistantPage's bars sit in this
 * same scroll container with `inset-0` masks and keep the live strip, tracked
 * in #1218. Its bottom bar cannot take the mirrored fix — a block-end overhang
 * grows the scrollable region, which is #769's phantom scroll — so covering it
 * needs a different mechanism, and adding it to this list needs that work
 * first, not a wider regex.
 *
 * There is no unit test that can catch this by rendering: jsdom performs no
 * layout, so the strip has no height and nothing scrolls through it.
 */

const SRC = __dirname;

function read(relativePath: string): string {
  return readFileSync(resolve(SRC, relativePath), 'utf-8');
}

/** Tailwind's default spacing step, in px at a 16px root font size. */
const SPACING_STEP_PX = 4;

const appLayoutSource = read('shared/components/layout/AppLayout.tsx');
const pageViewSource = read('features/pages/PageViewPage.tsx');
const newPageSource = read('features/pages/NewPagePage.tsx');

/** The classes on AppLayout's main scroll container. */
function scrollContainerClasses(): string {
  const match = appLayoutSource.match(/data-scroll-container[^>]*?className="([^"]+)"/);
  if (!match) throw new Error('No data-scroll-container element found in AppLayout.tsx');
  return match[1]!;
}

/** Its top padding, in Tailwind spacing steps. */
function scrollPaddingTopSteps(): number {
  const classes = scrollContainerClasses();
  const match = classes.match(/(?:^|\s)pt-(\d+)(?:\s|$)/);
  if (!match) throw new Error(`No unconditional pt-* on the scroll container: ${classes}`);
  return Number(match[1]);
}

const EDIT_TOOLBAR_WRAPPER = 'className="sticky top-0 z-30 isolate"';
const EDIT_TOOLBAR_MASK = 'data-testid="edit-toolbar-mask"';

/**
 * The classes on the edit toolbar's under-mask.
 *
 * Located by marker, and tied to the toolbar it belongs to: the reach asserted
 * below is the only place the exact height is pinned, so silently reading some
 * *other* element would leave the real mask free to drift back to a plain box.
 * Every way of not finding the right element throws by name instead.
 */
function editToolbarMaskClasses(): string {
  const wrapperAt = pageViewSource.indexOf(EDIT_TOOLBAR_WRAPPER);
  if (wrapperAt < 0) {
    throw new Error(`No sticky edit-toolbar wrapper (${EDIT_TOOLBAR_WRAPPER}) in PageViewPage.tsx`);
  }

  const markers = pageViewSource.split(EDIT_TOOLBAR_MASK).length - 1;
  if (markers !== 1) {
    throw new Error(`Expected exactly one ${EDIT_TOOLBAR_MASK} in PageViewPage.tsx, found ${markers}`);
  }

  const maskAt = pageViewSource.indexOf(EDIT_TOOLBAR_MASK);
  if (maskAt < wrapperAt) {
    throw new Error('The edit-toolbar mask no longer sits inside the sticky toolbar wrapper');
  }

  // Nothing may come between the wrapper and its mask but the wrapper's own
  // comment: a second sticky surface opening in that gap would mean the
  // marker now labels a mask belonging to something else.
  const between = pageViewSource.slice(wrapperAt + EDIT_TOOLBAR_WRAPPER.length, maskAt);
  if (/className="[^"]*\bsticky\b/.test(between)) {
    throw new Error('Another sticky surface opens between the edit toolbar and its mask');
  }

  const classes = pageViewSource.slice(maskAt).match(/^[^>]*?className="([^"]+)"/);
  if (!classes) throw new Error('The edit-toolbar mask carries no className');
  return classes[1]!;
}

describe('sticky under-masks cover the scroll container padding (#1186)', () => {
  it('the scroll container declares one unconditional top padding', () => {
    // A breakpoint variant (sm:pt-8) would give the padding two heights while
    // every mask below can only track one, so the taller one would bleed.
    expect(scrollContainerClasses()).not.toMatch(/(?:^|\s)[a-z-]+:pt-/);
    expect(scrollPaddingTopSteps()).toBeGreaterThan(0);
  });

  it("the edit toolbar's under-mask reaches exactly that far above the toolbar", () => {
    const classes = editToolbarMaskClasses();
    // Anti-vacuity: the subject must be the mask itself, not any element the
    // locator happened to land on.
    expect(classes, `not an under-mask: ${classes}`).toContain('z-[-1]');

    const reach = classes.match(/(?:^|\s)-top-(\d+)(?:\s|$)/);
    expect(reach, `mask does not reach above its box: ${classes}`).not.toBeNull();
    expect(Number(reach![1])).toBe(scrollPaddingTopSteps());
  });

  it("the New Page sticky header's mask still covers the same strip", () => {
    // This surface never lost its mask, which is why #1186 was reported
    // against the article editor and not here. Its reach is an absolute px
    // value rather than a spacing step, so it is compared at a 16px root; a
    // rem-scaled root shrinks its margin, which is why the article editor's
    // mask uses the spacing scale and tracks the padding at any root size.
    const header = newPageSource.match(/data-testid="new-page-sticky-header"[\s\S]{0,400}?className="([^"]+)"/);
    expect(header, 'no sticky header found in NewPagePage.tsx').not.toBeNull();

    const reach = header![1]!.match(/before:-top-\[(\d+)px\]/);
    expect(reach, `sticky header has no upward mask: ${header![1]}`).not.toBeNull();
    expect(Number(reach![1])).toBeGreaterThanOrEqual(scrollPaddingTopSteps() * SPACING_STEP_PX);
  });
});
