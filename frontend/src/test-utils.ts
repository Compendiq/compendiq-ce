/**
 * Shared test-only helpers. Not imported by application code.
 */

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
