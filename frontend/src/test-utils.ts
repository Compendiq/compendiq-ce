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
 * #1154: assert an AI composer orders **every** flex child explicitly.
 *
 * `DocumentUploadZone` (composer variant) and `ImageAttachZone` each emit a
 * full-width card and a small trigger as one fragment, so in document order a
 * card lands between the two triggers and strands one alone on a wrap line.
 * Explicit `order-*` on every child is what prevents that — and a child added
 * later without one defaults to `order: 0` and jumps ahead of the cards.
 *
 * The convention is load-bearing on all three composer surfaces (the dock,
 * `/ai` Generate, `/ai` Improve), so the guard lives here rather than in one
 * of the three suites: a fourth surface, or a fourth child on an existing one,
 * should not be able to reintroduce the defect just by being tested elsewhere.
 *
 * @param box       the `.nm-composer` element itself
 * @param expected  `data-testid` → the `order-N` that testid must carry.
 *                  Children with no testid (Generate's textarea and send
 *                  button) are still covered by the every-child sweep.
 */
export function expectExplicitComposerOrder(
  box: HTMLElement,
  expected: Record<string, number>,
): void {
  const orderClass = /(?:^|\s)order-(\d+)(?:\s|$)/;

  // Hidden file inputs are `display: none`, so they are not flex items and
  // carry no order of their own.
  const children = Array.from(box.children).filter((el) => !el.classList.contains('hidden'));
  expect(children.length, 'composer rendered no visible flex children').toBeGreaterThan(0);
  for (const el of children) {
    expect(
      el.className,
      `composer child <${el.tagName.toLowerCase()}> has no order-* class: "${el.className}"`,
    ).toMatch(orderClass);
  }

  for (const [testId, order] of Object.entries(expected)) {
    const el = box.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    expect(el, `expected [data-testid="${testId}"] among the composer's children`).not.toBeNull();
    const match = orderClass.exec(el!.className);
    expect(match, `expected an order-* class on ${testId}, got "${el!.className}"`).not.toBeNull();
    expect(Number(match![1]), `order of ${testId}`).toBe(order);
  }
}
