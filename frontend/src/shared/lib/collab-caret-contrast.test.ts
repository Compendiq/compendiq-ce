import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { extractBlock } from '../../test-utils';
import { COLLAB_CARET_PALETTE } from './collab-colors';

/**
 * Remote caret chips must clear WCAG 1.4.11 (3:1) on both Graphite and Paper
 * panes. Steel and the reserved status hues are not a caret palette — they
 * already mean interaction, pipeline state, warning, and AI.
 *
 * Ratios are COMPUTED from tokens, same machinery as workspace-themes.test.ts.
 * Retuning a surface fails with the measured number rather than a hex diff.
 */

const cssPath = resolve(__dirname, '../../index.css');
const css = readFileSync(cssPath, 'utf-8');
const darkBlock = extractBlock(css, '@theme {');
const lightBlock = extractBlock(css, '[data-theme="paper"] {');

function token(block: string, name: string, depth = 0): string {
  if (depth > 4) throw new Error(`alias chain too deep resolving ${name}`);
  const m = new RegExp(`${name}:\\s*([^;]+);`).exec(block);
  if (!m) throw new Error(`token not declared: ${name}`);
  const value = m[1].trim();
  // Follow `var()` aliases rather than demanding a literal. `RESERVED` below
  // names ROLES, and one of them — `--color-status-embedding` — is now
  // declared as `var(--color-foreground)`: embedding left the hue vocabulary
  // because it had been byte-identical to `--color-primary`, and pipeline
  // telemetry was wearing the colour that means "you can act on this".
  // Resolving keeps this guard's original claim intact ("no caret colour
  // equals a reserved token") instead of hardcoding the ink token here, where
  // a later repoint of the alias would silently start checking the wrong hex.
  const ref = /^var\((--[\w-]+)\)$/.exec(value);
  if (ref) return token(block, ref[1], depth + 1);
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) {
    throw new Error(`token is neither a 6-digit hex nor a var() reference: ${name}: ${value}`);
  }
  return value.toLowerCase();
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function expectContrast(label: string, fg: string, bg: string, floor: number) {
  const ratio = contrast(fg, bg);
  expect(
    ratio,
    `${label}: ${fg} on ${bg} measured ${ratio.toFixed(2)}:1, need ≥${floor}:1`,
  ).toBeGreaterThanOrEqual(floor);
}

const RESERVED = {
  steelGraphite: token(darkBlock, '--color-primary'),
  steelPaper: token(lightBlock, '--color-primary'),
  connected: token(darkBlock, '--color-status-connected'),
  syncing: token(darkBlock, '--color-status-syncing'),
  embedding: token(darkBlock, '--color-status-embedding'),
  ai: token(darkBlock, '--color-status-ai'),
  disconnected: token(darkBlock, '--color-status-disconnected'),
  info: token(darkBlock, '--color-info'),
};

describe('collab caret contrast (WCAG 1.4.11)', () => {
  const graphiteCard = token(darkBlock, '--color-card');
  const paperCard = token(lightBlock, '--color-card');

  it('ships 8–12 palette colours', () => {
    expect(COLLAB_CARET_PALETTE.length).toBeGreaterThanOrEqual(8);
    expect(COLLAB_CARET_PALETTE.length).toBeLessThanOrEqual(12);
  });

  it('every caret colour clears 3:1 on Graphite and Paper --surface-card', () => {
    for (const color of COLLAB_CARET_PALETTE) {
      expectContrast(`Graphite ${color}`, color, graphiteCard, 3);
      expectContrast(`Paper ${color}`, color, paperCard, 3);
    }
  });

  it('does not reuse Steel or reserved status/AI/info hues', () => {
    const palette = new Set(COLLAB_CARET_PALETTE.map((c) => c.toLowerCase()));
    for (const [name, hex] of Object.entries(RESERVED)) {
      expect(palette.has(hex.toLowerCase()), `${name} ${hex} must not be a caret colour`).toBe(false);
    }
  });
});
