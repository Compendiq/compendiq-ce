/**
 * Shared test-only helpers. Not imported by application code.
 */

import { vi } from 'vitest';

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
