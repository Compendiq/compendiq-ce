import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Regression tests for light-theme glass sidebar CSS variables.
 *
 * These tests verify that `--glass-sidebar-border` and `--glass-sidebar-shadow`
 * inside the shared `[data-theme-type="light"]` block have sufficient opacity
 * for visible contrast on light backgrounds (Polar Slate / Parchment Glow).
 *
 * Visual changes cannot be verified in jsdom (css: false in vitest config).
 * File-content assertions are the best available regression guard without a
 * screenshot testing framework — the same pattern used in build-config.test.ts.
 */

const cssPath = resolve(__dirname, 'index.css');
const cssSource = readFileSync(cssPath, 'utf-8');

/**
 * Extract the content of the first CSS rule block whose opening line matches
 * `openingLine` exactly (e.g. `[data-theme="polar-slate"] {`).
 * This avoids accidentally matching descendant-selector rules that share the
 * same prefix (e.g. `[data-theme-type="light"] * {`).
 */
function extractBlock(source: string, openingLine: string): string {
  const startIndex = source.indexOf(openingLine);
  if (startIndex === -1) return '';
  // Opening brace is the last char of openingLine (or find it from startIndex)
  const braceStart = source.indexOf('{', startIndex);
  if (braceStart === -1) return '';

  let depth = 0;
  let i = braceStart;
  while (i < source.length) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(braceStart, i + 1);
    }
    i++;
  }
  return '';
}

// The standalone shared light-theme override block starts with the bare selector
// followed immediately by ' {' — not '[data-theme-type="light"] * {' etc.
const lightThemeBlock = extractBlock(cssSource, '[data-theme-type="light"] {');
const polarSlateBlock = extractBlock(cssSource, '[data-theme="polar-slate"] {');
const parchmentGlowBlock = extractBlock(
  cssSource,
  '[data-theme="parchment-glow"] {',
);

describe('Light theme glass sidebar contrast', () => {
  describe('[data-theme-type="light"] shared block', () => {
    it('contains the shared light-theme block', () => {
      expect(lightThemeBlock).not.toBe('');
    });

    it('sets --glass-sidebar-border to at least 0.15 opacity (0.16)', () => {
      expect(lightThemeBlock).toContain(
        '--glass-sidebar-border: oklch(0 0 0 / 0.16)',
      );
    });

    it('does NOT contain the old under-contrast 0.10 border value', () => {
      expect(lightThemeBlock).not.toContain(
        '--glass-sidebar-border: oklch(0 0 0 / 0.10)',
      );
    });

    it('sets --glass-sidebar-shadow with increased 0.12 opacity', () => {
      expect(lightThemeBlock).toContain(
        '--glass-sidebar-shadow: 0 8px 32px oklch(0 0 0 / 0.12)',
      );
    });

    it('does NOT contain the old under-depth 0.08 shadow value', () => {
      expect(lightThemeBlock).not.toContain(
        '--glass-sidebar-shadow: 0 8px 32px oklch(0 0 0 / 0.08)',
      );
    });
  });

  describe('Per-theme blocks do not override shared sidebar variables', () => {
    it('polar-slate block does not override --glass-sidebar-border', () => {
      expect(polarSlateBlock).not.toContain('--glass-sidebar-border');
    });

    it('polar-slate block does not override --glass-sidebar-shadow', () => {
      expect(polarSlateBlock).not.toContain('--glass-sidebar-shadow');
    });

    it('parchment-glow block does not override --glass-sidebar-border', () => {
      expect(parchmentGlowBlock).not.toContain('--glass-sidebar-border');
    });

    it('parchment-glow block does not override --glass-sidebar-shadow', () => {
      expect(parchmentGlowBlock).not.toContain('--glass-sidebar-shadow');
    });
  });
});
