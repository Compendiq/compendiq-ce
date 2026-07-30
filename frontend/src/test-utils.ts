/**
 * Shared test-only helpers. Not imported by application code.
 */

import { expect, vi } from 'vitest';

/**
 * `vi.mock` factory body for `shared/lib/api` that replaces `apiFetch` with a
 * test-controlled mock while keeping every OTHER export real — most
 * importantly the `ApiError` class, which `runStream` branches on
 * (`err instanceof ApiError`) for 403 handling. A bare `{ apiFetch }` factory
 * leaves `ApiError` undefined on the mock, making `instanceof` throw the
 * moment a test exercises a stream-error path.
 *
 * `vi.mock` factories are hoisted above the test file's body, so the file's
 * `apiFetchMock` const is still in its temporal dead zone when the factory
 * runs — pass a lazy getter and the mock is only dereferenced at call time.
 *
 * Usage (path segments relative to the test file):
 *
 *   const apiFetchMock = vi.fn();
 *   vi.mock('../../../shared/lib/api', async () =>
 *     (await import('../../../test-utils')).apiModuleMock(() => apiFetchMock));
 */
export async function apiModuleMock(
  getApiFetchMock: () => (...args: unknown[]) => unknown,
) {
  const actual = await vi.importActual<typeof import('./shared/lib/api')>('./shared/lib/api');
  return {
    ...actual,
    apiFetch: (...args: unknown[]) => getApiFetchMock()(...args),
  };
}

/**
 * Extract a balanced `{ ... }` block from `source`, starting at the first
 * occurrence of `openingLine` (e.g. `'@theme {'` or `'\nbody {'`).
 *
 * Throws when the anchor (or its opening brace) is missing so anchor drift
 * in index.css fails loudly instead of silently matching an empty string.
 * Returns `''` only for an unterminated (unbalanced) block.
 */
export function extractBlock(source: string, openingLine: string): string {
  const startIndex = source.indexOf(openingLine);
  if (startIndex === -1) {
    throw new Error(`extractBlock: anchor not found: ${JSON.stringify(openingLine)}`);
  }
  const braceStart = source.indexOf('{', startIndex);
  if (braceStart === -1) {
    throw new Error(
      `extractBlock: no opening brace after anchor: ${JSON.stringify(openingLine)}`,
    );
  }
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(braceStart, i + 1);
    }
  }
  return '';
}

/**
 * #1154: assert an AI composer's controls are reachable in reading order
 * (WCAG 2.4.3).
 *
 * Sequential focus navigation follows **document order**; it ignores `order`,
 * and `display: contents` does not escape it either. So the property worth
 * pinning is that each zone's card sits immediately before that zone's own
 * trigger in the markup, which is what the per-zone row structure buys.
 *
 * **Both halves are load-bearing, and the second is the one that bites.** jsdom
 * performs no layout, so a DOM sequence alone cannot tell a correct composer
 * from the pre-#1154 one — the markup order was already this; it was `order-*`
 * that moved the boxes away from it. Asserting that no child carries an
 * `order-*` is therefore what makes the sequence *mean* the visual order: with
 * no reordering in play, document order is the rendered order. Drop that half
 * and this test would pass on the very defect it exists to catch.
 *
 * Controls are compared whether or not they are `disabled` — a disabled control
 * is skipped by Tab but does not change the order of the rest, and which
 * controls are disabled varies with vision capability and prompt emptiness.
 *
 * The convention holds on all three composer surfaces (the dock, `/ai` Generate,
 * `/ai` Improve), so the guard lives here rather than in one of the three
 * suites: a fourth surface should not be able to reintroduce the defect just by
 * being tested elsewhere.
 *
 * @param box       the `.nm-composer` element itself
 * @param expected  every control the composer contains, in the order it should
 *                  be reached. Each entry is a `data-testid`, or a bare tag name
 *                  (`'textarea'`, `'button'`) for the controls that carry no
 *                  testid — Generate's field and send button.
 */
export function expectComposerFocusOrder(box: HTMLElement, expected: string[]): void {
  const FOCUSABLE = 'button, textarea, input, select, a[href], [tabindex]';

  const controls = Array.from(box.querySelectorAll<HTMLElement>(FOCUSABLE))
    // Hidden file inputs are `display: none` — not focusable, and no part of
    // the tab sequence. jsdom computes no styles from Tailwind classes, so the
    // class is the only signal available here.
    .filter((el) => !el.classList.contains('hidden'))
    .filter((el) => el.getAttribute('tabindex') !== '-1');

  expect(controls.length, 'composer rendered no focusable controls').toBeGreaterThan(0);
  expect(
    controls.map((el) => el.getAttribute('data-testid') ?? el.tagName.toLowerCase()),
    'composer controls in document order, i.e. the order Tab reaches them',
  ).toEqual(expected);

  // `className` on an SVG element is an SVGAnimatedString, not a string, and
  // lucide renders SVGs throughout — read the attribute instead.
  const reordered = [box, ...box.querySelectorAll<HTMLElement>('*')].filter((el) =>
    /(?:^|\s)order-(?:\d+|first|last|none)(?:\s|$)/.test(el.getAttribute('class') ?? ''),
  );
  expect(
    reordered.map((el) => `<${el.tagName.toLowerCase()} class="${el.getAttribute('class')}">`),
    'no composer element may carry order-*: it moves boxes without moving the ' +
      'tab sequence, which is the WCAG 2.4.3 defect #1154 removed',
  ).toEqual([]);
}
