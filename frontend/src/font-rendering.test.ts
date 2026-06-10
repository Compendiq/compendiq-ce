import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { extractBlock } from './test-utils';

/**
 * Regression tests for stable text weight during async font load (#767).
 *
 * The brand fonts are self-hosted variable fonts loaded async via @fontsource
 * (font-display: swap). During the swap window the browser renders system
 * fallbacks and — unless told otherwise — may synthesize a faux-bold, which
 * made random sidebar tree titles flash heavier between loads.
 *
 * `font-synthesis: style` on body disables weight (and small-caps) synthesis
 * app-wide while keeping style synthesis: the app uses the `italic` utility
 * and the editor's Italic mark, but ships no italic cut of IBM Plex Sans, so
 * italics depend on oblique synthesis. Full `font-synthesis: none` would
 * silently un-italicize them — guard against that too.
 */

const css = readFileSync(resolve(__dirname, 'index.css'), 'utf-8');

describe('font-synthesis guard against faux-bold during font swap (#767)', () => {
  const bodyBlock = extractBlock(css, '\nbody {');

  it('body disables weight synthesis via the font-synthesis shorthand', () => {
    expect(bodyBlock).toContain('font-synthesis: style;');
  });

  it('does not fully disable synthesis (italics rely on oblique synthesis)', () => {
    expect(css).not.toContain('font-synthesis: none');
    expect(css).not.toContain('font-synthesis-style: none');
  });
});
