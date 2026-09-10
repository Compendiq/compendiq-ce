import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The brand mark is the one part of the UI a token sweep cannot reach.
 *
 * Its colours are hard-coded hex literals, and they have to be: the same
 * geometry is mirrored into four static SVGs — favicon, logo, maskable logo and
 * the horizontal lockup — which render with no CSS custom properties available
 * (a favicon has no document, a maskable icon is rasterised by the OS). So the
 * literals cannot be `var(--color-*)`, and nothing in a palette change touches
 * them.
 *
 * The result is that the mark has now lagged the palette by a full release
 * twice: honey survived into the steel system, and steel survived into
 * Graphite/Paper — shipping a steel-blue magnifier on a teal product, in the
 * most visible element on the page, across five files.
 *
 * This test closes that. It reads the literals back out of all five files and
 * ties them to the palette they are supposed to track, so retinting the accent
 * without retinting the mark fails by name.
 *
 * Deliberately anchored to the DARK theme's tokens: the mark does not invert
 * (it is an identity, not a control), and Graphite is what it is drawn on.
 */

const SRC = __dirname;
const read = (p: string) => readFileSync(resolve(SRC, p), 'utf8');

/**
 * The icon block: tile, glyph, accent stroke. Three colours, no wordmark.
 * `Logo.tsx` belongs here because its wordmark is `currentColor` — it inherits
 * the host's text colour so it stays readable in both themes.
 */
const ICON_FILES = [
  'shared/components/Logo.tsx',
  '../public/favicon.svg',
  '../public/logo.svg',
  '../public/logo-maskable.svg',
] as const;

/**
 * The horizontal lockup carries the same icon PLUS the wordmark, and a static
 * file cannot use `currentColor` meaningfully — there is no host to inherit
 * from — so it bakes an ink literal. Four colours, not three; asserting three
 * here is what first flagged that its wordmark was still the steel era's navy
 * `#171c2c` rather than the current hueless ink.
 */
const LOCKUP = '../public/compendiq-lockup-horizontal.svg';

const MARK_FILES = [...ICON_FILES, LOCKUP] as const;

/** Pulled from `index.css` rather than typed here, so the tie is to the source. */
function darkToken(name: string): string {
  const css = read('index.css');
  // The dark block is the bare `:root`-level `@theme` — the light theme lives
  // under `[data-theme="paper"]`, which appears later in the file.
  const paperAt = css.indexOf('[data-theme="paper"]');
  const darkOnly = paperAt === -1 ? css : css.slice(0, paperAt);
  const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{3,8})\\s*;`).exec(darkOnly);
  if (!m) throw new Error(`${name} not found in the dark theme block of index.css`);
  return m[1]!.toLowerCase();
}

/** Every 6-digit hex literal in a file, lowercased. */
function hexesIn(file: string): string[] {
  return (read(file).match(/#[0-9a-fA-F]{6}\b/g) ?? []).map((h) => h.toLowerCase());
}

describe('the brand mark tracks the palette', () => {
  it('every mirror of the mark uses the same three colours', () => {
    // Logo.tsx's doc comment records the two retired palettes by hex on
    // purpose, so read only the rendered literals from it.
    const rendered = (file: string) =>
      file.endsWith('.tsx')
        ? (read(file)
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .match(/(?:fill|stroke)="(#[0-9a-fA-F]{6})"/g) ?? []
          ).map((m) => m.slice(-8, -1).toLowerCase())
        : hexesIn(file);

    const perFile = ICON_FILES.map((f) => ({ file: f, colors: [...new Set(rendered(f))].sort() }));

    for (const { file, colors } of perFile) {
      expect(colors.length, `${file}: expected exactly 3 icon colours, got ${colors.join(', ')}`).toBe(
        3,
      );
    }

    const [first, ...rest] = perFile;
    for (const other of rest) {
      expect(
        other.colors,
        `${other.file} has drifted from ${first!.file}. Every copy of the mark ` +
          `must be retinted together — a favicon left on the old accent is the ` +
          `version most users see first.`,
      ).toEqual(first!.colors);
    }

    // The lockup is the icon plus a baked wordmark ink.
    const lockup = [...new Set(hexesIn(LOCKUP))].sort();
    expect(
      lockup.filter((c) => first!.colors.includes(c)).sort(),
      `${LOCKUP} must contain the whole icon palette; it is the design source of ` +
        `truth the other four are cut from.`,
    ).toEqual(first!.colors);
    expect(lockup.length, `${LOCKUP}: icon palette + exactly one wordmark ink`).toBe(4);
  });

  it('those three colours are the palette, not a look-alike', () => {
    const tile = darkToken('--color-card');
    const glyph = darkToken('--color-foreground');
    const accent = darkToken('--color-primary');

    const colors = [...new Set(hexesIn('../public/logo.svg'))].sort();

    expect(
      colors,
      `The mark's literals must equal the Graphite tokens it is drawn from: ` +
        `tile --color-card (${tile}), glyph --color-foreground (${glyph}), ` +
        `strokes --color-primary (${accent}). This is the check that catches an ` +
        `accent change that never reached the logo — which has now happened twice.`,
    ).toEqual([tile, glyph, accent].sort());
  });

  it('no retired brand colour survives in any mirror', () => {
    const RETIRED = [
      '#f9c74f', '#fff8e9', '#1a1a1a', // honey
      '#6ea8ff', '#e8ecf5', '#151b2c', '#171c2c', // steel
    ];
    for (const file of MARK_FILES) {
      // Logo.tsx names the retired values in prose; strip comments first.
      const body = file.endsWith('.tsx')
        ? read(file).replace(/\/\*[\s\S]*?\*\//g, '')
        : read(file);
      for (const hex of RETIRED) {
        expect(
          body.toLowerCase(),
          `${file} still paints the retired ${hex}`,
        ).not.toContain(hex);
      }
    }
  });
});
