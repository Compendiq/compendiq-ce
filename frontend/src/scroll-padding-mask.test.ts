import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * The strip of scroll padding that a sticky box does not reach (#1186, #1218).
 *
 * AppLayout's main scroll container carries padding. A `position: sticky` box
 * inside it does NOT come to rest against the scrollport's edge: it is clamped
 * to its containing block, and that block begins *after* the padding. Measured
 * in Chromium at a 1440x900 viewport, a `sticky top-0` toolbar stops at the
 * scroll container's content-box top — one padding step below the edge where
 * the scrollport finally clips — so content scrolls up through that strip in
 * full view, between the app header and the stuck toolbar. The same gap exists
 * at the block-end, below a `sticky bottom-0` bar (#1218).
 *
 * There are two ways to keep content out of it, and this file enforces both:
 *
 *   (a) COVER IT — reach one padding step past your own box with an opaque
 *       under-mask. PageViewPage's edit toolbar (fixed in #1186) and
 *       NewPagePage's sticky toolbar (fixed in the same way once the New Page
 *       redesign copied PageViewPage's bar-across-the-column treatment but
 *       reused the *older* `before:bg-background` mask instead — the wrong
 *       fill for a route where the main column IS the pane, which painted a
 *       chassis-coloured band across the white document above the toolbar).
 *       The height of that reach is not a free choice: it is AppLayout's
 *       padding, in another file. It has already drifted once (pt-4 to
 *       pt-5), and a mask that no longer matches fails silently — the bleed
 *       simply returns, thinner. The invariants below read both numbers out
 *       of the sources rather than restating them, the same approach as
 *       `nginx-api-body-limit.test.ts`.
 *
 *   (b) NEVER SCROLL INTO IT — leave the scroll container with no overflow at
 *       all, so nothing ever passes through either strip. `/ai` (#1218): its
 *       message pane owns the scroller, reached by carrying `min-h-0` down
 *       every wrapper between the scroll container and the pane. Its two bars
 *       keep plain `inset-0` under-masks, which are belt-and-braces from that
 *       point on rather than the thing holding the strip shut.
 *
 * Strategy (b) is not open to every surface: covering the block-end strip the
 * way (a) covers the block-start one is what #769 forbids — an absolutely
 * positioned mask overflowing the block-end edge grows the scrollable overflow
 * region, adding phantom scroll. A surface with a sticky bottom bar therefore
 * has to stop scrolling rather than mask its way out.
 *
 * The chain itself is pinned in `ai-scroll-chain.test.ts`, not here — one
 * invariant, one file, so the two cannot drift apart. What this file asserts
 * about `/ai` is that the delegation is real: strategy (b) is only a strategy
 * while something enforces it.
 *
 * There is no unit test that can catch any of this by rendering: jsdom
 * performs no layout, so the strip has no height and nothing scrolls through
 * it.
 */

const SRC = __dirname;

function read(relativePath: string): string {
  return readFileSync(resolve(SRC, relativePath), 'utf-8');
}

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

const EDIT_TOOLBAR_WRAPPER = 'className="sticky -top-5 z-30 isolate -mt-5"';

/**
 * The classes on a sticky toolbar's under-mask.
 *
 * Located by marker, and tied to the toolbar it belongs to: the reach asserted
 * below is the only place the exact height is pinned, so silently reading some
 * *other* element would leave the real mask free to drift back to a plain box.
 * Every way of not finding the right element throws by name instead. Shared by
 * PageViewPage's edit toolbar and NewPagePage's sticky toolbar — both use the
 * identical wrapper/under-mask recipe, so one locator serves both sources.
 */
function stickyToolbarMaskClasses(source: string, sourceName: string, maskTestId: string): string {
  const wrapperAt = source.indexOf(EDIT_TOOLBAR_WRAPPER);
  if (wrapperAt < 0) {
    throw new Error(`No sticky toolbar wrapper (${EDIT_TOOLBAR_WRAPPER}) in ${sourceName}`);
  }

  const maskMarker = `data-testid="${maskTestId}"`;
  const markers = source.split(maskMarker).length - 1;
  if (markers !== 1) {
    throw new Error(`Expected exactly one ${maskMarker} in ${sourceName}, found ${markers}`);
  }

  const maskAt = source.indexOf(maskMarker);
  if (maskAt < wrapperAt) {
    throw new Error('The toolbar mask no longer sits inside the sticky toolbar wrapper');
  }

  // Nothing may come between the wrapper and its mask but the wrapper's own
  // comment: a second sticky surface opening in that gap would mean the
  // marker now labels a mask belonging to something else.
  const between = source.slice(wrapperAt + EDIT_TOOLBAR_WRAPPER.length, maskAt);
  if (/className="[^"]*\bsticky\b/.test(between)) {
    throw new Error('Another sticky surface opens between the toolbar and its mask');
  }

  const classes = source.slice(maskAt).match(/^[^>]*?className="([^"]+)"/);
  if (!classes) throw new Error('The toolbar mask carries no className');
  return classes[1]!;
}

describe('nothing shows in the scroll container padding (#1186, #1218)', () => {
  it('the scroll container declares one unconditional top padding', () => {
    // A breakpoint variant (sm:pt-8) would give the padding two heights while
    // every mask below can only track one, so the taller one would bleed.
    expect(scrollContainerClasses()).not.toMatch(/(?:^|\s)[a-z-]+:pt-/);
    expect(scrollPaddingTopSteps()).toBeGreaterThan(0);
  });

  it("the edit toolbar's under-mask reaches exactly that far above the toolbar", () => {
    const classes = stickyToolbarMaskClasses(pageViewSource, 'PageViewPage.tsx', 'edit-toolbar-mask');
    // Anti-vacuity: the subject must be the mask itself, not any element the
    // locator happened to land on.
    expect(classes, `not an under-mask: ${classes}`).toContain('z-[-1]');

    const reach = classes.match(/(?:^|\s)-top-(\d+)(?:\s|$)/);
    expect(reach, `mask does not reach above its box: ${classes}`).not.toBeNull();
    expect(Number(reach![1])).toBe(scrollPaddingTopSteps());
  });

  it("the New Page sticky toolbar's under-mask reaches exactly that far above the toolbar", () => {
    // Same recipe as PageViewPage's edit toolbar (see the fill-colour note
    // above the class comment) — reused via the same locator and the same
    // wrapper marker, so the two cannot drift apart unnoticed.
    const classes = stickyToolbarMaskClasses(newPageSource, 'NewPagePage.tsx', 'new-page-toolbar-mask');
    expect(classes, `not an under-mask: ${classes}`).toContain('z-[-1]');
    // The mask must paint the document pane's own colour, not the app
    // chrome's — that distinction is the entire fix this file documents.
    expect(classes, `mask paints chrome colour, not the pane: ${classes}`).toContain('bg-card');
    expect(classes, `mask paints the chassis colour over the document: ${classes}`).not.toMatch(/\bbg-background\b/);

    const reach = classes.match(/(?:^|\s)-top-(\d+)(?:\s|$)/);
    expect(reach, `mask does not reach above its box: ${classes}`).not.toBeNull();
    expect(Number(reach![1])).toBe(scrollPaddingTopSteps());
  });

  it('/ai takes the other strategy, and something enforces it', () => {
    // Strategy (b) has no mask to measure: the evidence that /ai stays out of
    // both strips is that its wrapper chain still shrinks, and that is pinned
    // one file over. Deleting or gutting that guard would leave this file's
    // header describing a strategy nothing holds anyone to — so the pointer
    // itself is asserted, rather than the chain being re-asserted here.
    const guard = read('ai-scroll-chain.test.ts');

    expect(guard, 'the /ai chain guard no longer pins min-h-0').toContain('min-h-0');
    for (const row of [
      'shared/components/layout/AppLayout.tsx',
      'shared/components/layout/PageTransition.tsx',
      'features/ai/AiAssistantPage.tsx',
    ]) {
      expect(guard, `the /ai chain guard no longer covers ${row}`).toContain(row);
    }

    // Naming the rows is not the same as still checking them. A guard whose
    // cases are skipped keeps every string above and asserts nothing, which is
    // the one failure mode a pointer-only check cannot see — so the machinery
    // that does the checking is named too.
    expect(guard, 'the /ai chain guard has skipped or pending cases').not.toMatch(
      /\b(it|test|describe)\s*\.\s*(skip|todo|fails)\b/,
    );
    expect(guard, 'the /ai chain guard no longer evaluates its min-h-0 predicate').toContain(
      'declaresMinHeightZero(',
    );
    expect(guard, 'the /ai chain guard no longer asserts that predicate').toMatch(/\.toBe\(true\)/);
  });
});
