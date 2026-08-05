import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * The `min-h-0` chain that makes /ai's message pane scroll instead of the page
 * (#1218).
 *
 * `min-height: auto` is the automatic minimum size of a flex item: it refuses
 * to shrink below its content. One row of the chain keeping that default is
 * enough to stop the whole chain shrinking, so the /ai column grows to its
 * content and AppLayout's scroll container — not the pane — is what scrolls.
 * That is the state this file was written against: `#1142` gave the message
 * pane `min-h-0 flex-1 overflow-y-auto`, but the three wrappers between it and
 * the scroll container had `min-height: auto`, and measured in Chromium the
 * pane's own scroller never engaged at any viewport from 1920x1080 down to
 * 390x844 — the outer container overflowed by 2009-3201px instead.
 *
 * The visible symptom was at the two ends. AppLayout's scroll container is
 * padded (`pt-5 pb-5`), and a `position: sticky` box inside it comes to rest
 * against its containing block, which begins *after* that padding — so both of
 * /ai's sticky bars stop one padding step short of the scrollport's clip edge
 * and live message text scrolls through the 20px strip at each end, in full
 * view (#1186 is the same mechanism at the block-start; #1218 reported the
 * block-end). With the chain complete the outer container has no overflow at
 * all, so nothing ever scrolls into either strip.
 *
 *   AppLayout scroll container  (data-scroll-container)
 *     -> PageTransition          (shared by every route)
 *       -> AppLayout max-width wrapper
 *         -> AiAssistantPage page root
 *           -> message pane      (data-testid="ai-message-pane")
 *
 * **All four ancestors are load-bearing: adding `min-h-0` to three of them
 * fixes nothing**, which is exactly what these invariants must fail on — by
 * name, so the reader knows which row went back to `min-height: auto`.
 *
 * There is no render test that can catch this: jsdom performs no layout, so
 * nothing has a height, nothing overflows and nothing scrolls. A Playwright
 * test could assert the real property (`scrollHeight === clientHeight`, the
 * pane scrolls) but needs backend + frontend running, auth and a configured
 * LLM to reach /ai — too much standing infrastructure for one invariant. This
 * source walk pins the classes as a proxy for the behaviour, knowingly, the
 * same approach as `nginx-api-body-limit.test.ts` and `scroll-padding-mask.ts`
 * take to config and CSS they also cannot execute.
 */

const SRC = __dirname;

function read(relativePath: string): string {
  return readFileSync(resolve(SRC, relativePath), 'utf-8');
}

const APP_LAYOUT = 'shared/components/layout/AppLayout.tsx';
const PAGE_TRANSITION = 'shared/components/layout/PageTransition.tsx';
const AI_PAGE = 'features/ai/AiAssistantPage.tsx';

const appLayoutSource = read(APP_LAYOUT);
const pageTransitionSource = read(PAGE_TRANSITION);
const aiPageSource = read(AI_PAGE);

/**
 * AppLayout's main scroll container — the top of the chain, and the element
 * that scrolls when any row below it refuses to shrink.
 */
function scrollContainerClasses(): string {
  const match = appLayoutSource.match(/data-scroll-container[^>]*?className="([^"]+)"/);
  if (!match) throw new Error(`No data-scroll-container element found in ${APP_LAYOUT}`);
  return match[1]!;
}

/** PageTransition's pass-through wrapper, on the path of every route. */
function pageTransitionClasses(): string {
  const match = pageTransitionSource.match(/<div className="([^"]+)">\s*\{children\}\s*<\/div>/);
  if (!match) throw new Error(`No pass-through wrapper around {children} in ${PAGE_TRANSITION}`);
  return match[1]!;
}

/**
 * AppLayout's max-width wrapper, between PageTransition and the routed page.
 *
 * Only the unconditional first argument of its `cn(...)` is returned. The
 * second is the article-vs-rest max-width ternary, and a `min-h-0` hidden in
 * one of its branches would leave the other route's chain broken — so a
 * conditional placement has to read as a miss here, not as a pass.
 */
function maxWidthWrapperClasses(): string {
  const openAt = appLayoutSource.indexOf('<PageTransition>');
  if (openAt < 0) throw new Error(`No <PageTransition> element in ${APP_LAYOUT}`);
  const closeAt = appLayoutSource.indexOf('</PageTransition>', openAt);
  if (closeAt < 0) throw new Error(`<PageTransition> is never closed in ${APP_LAYOUT}`);

  const inner = appLayoutSource.slice(openAt, closeAt);
  const match = inner.match(/className=\{cn\(\s*'([^']+)'/);
  if (!match) throw new Error(`No cn()-composed wrapper inside <PageTransition> in ${APP_LAYOUT}`);
  if (!match[1]!.includes('mx-auto')) {
    throw new Error(`The first element inside <PageTransition> is not the max-width wrapper: ${match[1]}`);
  }
  if (!inner.includes('{children}')) {
    throw new Error(`The max-width wrapper no longer renders {children} in ${APP_LAYOUT}`);
  }
  return match[1]!;
}

/** AiAssistantPage's page root — the animated column holding both bars. */
function aiPageRootClasses(): string {
  const componentAt = aiPageSource.indexOf('export function AiAssistantPage()');
  if (componentAt < 0) throw new Error(`No AiAssistantPage component in ${AI_PAGE}`);

  // Attribute-position `//` comments are trivia, and this element carries one
  // that contains `>` characters — drop whole comment lines before looking for
  // the tag's own closing bracket.
  const body = aiPageSource.slice(componentAt).replace(/^\s*\/\/.*$/gm, '');
  const root = body.match(/return \(\s*<m\.div([\s\S]*?)>/);
  if (!root) throw new Error(`AiAssistantPage does not return an <m.div> root in ${AI_PAGE}`);

  const classes = root[1]!.match(/className="([^"]+)"/);
  if (!classes) throw new Error(`AiAssistantPage's root carries no static className in ${AI_PAGE}`);
  return classes[1]!;
}

/** The message pane — the end of the chain, and the scroller it exists to feed. */
function messagePaneClasses(): string {
  const match = aiPageSource.match(/<div className="([^"]+)"\s+data-testid="ai-message-pane"/);
  if (!match) throw new Error(`No ai-message-pane element found in ${AI_PAGE}`);
  return match[1]!;
}

/**
 * `min-h-0` unprefixed. A breakpoint or state variant (`sm:min-h-0`) is not a
 * link in this chain: it leaves `min-height: auto` standing below that
 * breakpoint, which is the whole bug at those sizes. The leading boundary is
 * whitespace or start-of-string, so `sm:min-h-0` reads as a miss.
 */
function declaresMinHeightZero(classes: string): boolean {
  return /(?:^|\s)min-h-0(?:\s|$)/.test(classes);
}

// The distinguishing words lead: a runner that truncates a long test title
// would otherwise print the two AppLayout rows identically, and "which row"
// is the whole point of naming them.
const CHAIN = [
  { name: `the scroll container (${APP_LAYOUT})`, classes: scrollContainerClasses },
  { name: `the PageTransition wrapper (${PAGE_TRANSITION})`, classes: pageTransitionClasses },
  { name: `the max-width wrapper (${APP_LAYOUT})`, classes: maxWidthWrapperClasses },
  { name: `the /ai page root (${AI_PAGE})`, classes: aiPageRootClasses },
  { name: `the /ai message pane (${AI_PAGE})`, classes: messagePaneClasses },
] as const;

describe('/ai scrolls its message pane, not the page (#1218)', () => {
  it.each(CHAIN)('$name carries min-h-0', ({ classes }) => {
    const value = classes();
    expect(
      declaresMinHeightZero(value),
      `this row of the /ai chain has min-height: auto, so nothing below it can shrink ` +
        `and AppLayout's scroll container scrolls instead of the message pane: ${value}`,
    ).toBe(true);
  });

  it.each(CHAIN)('$name stays a flex item that fills its parent', ({ name, classes }) => {
    // min-h-0 only means anything on a row that is also flex-1 in a flex
    // column: the height has to be handed down before it can be capped.
    const value = classes();
    expect(value, `${name} is no longer a flex-1 item: ${value}`).toMatch(/(?:^|\s)flex-1(?:\s|$)/);
  });

  it('every wrapper above the pane leaves the scrolling to it', () => {
    // A second scroller anywhere in the chain would clip the pane's own
    // scroller out of the layout it was given, and put a scrollbar on a
    // wrapper that has no business owning one.
    for (const link of CHAIN.slice(1, -1)) {
      const value = link.classes();
      expect(value, `${link.name} declares its own overflow: ${value}`).not.toMatch(
        /(?:^|\s)overflow-/,
      );
    }

    const pane = messagePaneClasses();
    expect(pane, `the message pane must own the scroller: ${pane}`).toMatch(
      /(?:^|\s)overflow-y-auto(?:\s|$)/,
    );
  });
});
