import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { extractBlock, composite } from '../../test-utils';

/**
 * The setup wizard states its connection results in colour, so those colours
 * are load-bearing rather than decorative — and the wizard is the one surface
 * an admin cannot skip.
 *
 * Two guards, because the defect in #1168 needed both to be caught:
 *
 * 1. No literal Tailwind status shade in `features/setup/`. Those shades are
 *    dark-theme tuned, and the light-theme remap block in `index.css` covers
 *    only amber/yellow — emerald and red pass through unmodified onto Frost
 *    Steel, where the LlmStep banner measured 1.33:1.
 *
 * 2. The tokens that replace them still clear their floor *as rendered* — ink
 *    on a 10%-tinted fill over the wizard's `nm-card`, not on the bare
 *    background. `neumorphic-themes.test.ts` already measures every status
 *    token against `--color-background` and `--color-card`; it cannot see the
 *    tint the banner actually paints, which costs roughly a further 0.9:1.
 *
 * Deliberately scoped to this directory. The same literals appear ~52 times
 * across ~30 files elsewhere in the app; that is real debt, but it is not this
 * test's job and a repo-wide assertion here would red the suite on it.
 */

const SETUP_DIR = import.meta.dirname;
const cssPath = resolve(SETUP_DIR, '../../index.css');
const css = readFileSync(cssPath, 'utf-8');

// Status tokens and the card surface both live in the per-theme blocks. The
// card was a gradient under the retired system, so this file used to measure
// every colour stop; it is one flat value now, which means one measurement per
// theme instead of a worst-stop search.
const darkBlock = extractBlock(css, '@theme {');
const lightBlock = extractBlock(css, '[data-theme="paper"] {');

/** Literal Tailwind status-colour utilities: `bg-emerald-500/10`, `text-red-300`, … */
const LITERAL_SHADE = /\b(?:bg|text|border|ring|fill|stroke|from|via|to)-(?:emerald|green|red|rose|lime)-\d{2,3}\b/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

/** Read a `--token: #rrggbb;` declaration out of a CSS block. */
function token(block: string, name: string): string {
  const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})\\b`).exec(block);
  if (!m) throw new Error(`token not found (or not a 6-digit hex): ${name}`);
  return m[1].toLowerCase();
}

// --- WCAG 2.1 relative luminance / contrast (SC 1.4.3, 1.4.11) ---
// Same math as workspace-themes.test.ts, kept local so this file stands alone;
// the alpha-composite helper is the exception and is shared from test-utils.ts,
// because a second local copy once shipped with the signature reversed.
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

describe('Setup wizard states status in semantic tokens', () => {
  it('uses no literal Tailwind status shade', () => {
    const offences: string[] = [];

    for (const file of sourceFiles(SETUP_DIR)) {
      readFileSync(file, 'utf-8').split('\n').forEach((line, i) => {
        const hit = LITERAL_SHADE.exec(line);
        if (hit) {
          offences.push(
            `  ${file.slice(SETUP_DIR.length + 1)}:${i + 1}  ${hit[0]}  —  ${line.trim().slice(0, 80)}`,
          );
        }
      });
    }

    expect(
      offences,
      'Literal Tailwind status shades are dark-theme tuned and are NOT remapped\n' +
      'for Paper (index.css remaps amber/yellow only). Use the semantic\n' +
      '--color-status-* tokens instead:\n' + offences.join('\n'),
    ).toEqual([]);
  });
});

describe('Measured contrast — status ink on the wizard banner', () => {
  const themes = [
    { name: 'Graphite', block: darkBlock },
    { name: 'Paper', block: lightBlock },
  ];

  // Two tint strengths are in use on the wizard's `nm-card`: LlmStep's banner
  // fills at /10 and inks text on it (AA 4.5:1), and CompleteStep's disc fills
  // at /20 behind a checkmark glyph (1.4.11's 3:1 non-text floor). Both roles
  // are measured at both strengths so either can move to either callsite.
  const surfaces = [
    { label: '10% tint (LlmStep banner)', alpha: 0.1, floor: 4.5 },
    { label: '20% tint (CompleteStep disc)', alpha: 0.2, floor: 3 },
  ];

  for (const { name, block } of themes) {
    for (const role of ['connected', 'disconnected'] as const) {
      const ink = token(block, `--color-status-${role}`);
      const cardSurface = token(block, '--color-card');

      for (const { label, alpha, floor } of surfaces) {
        it(`${name}: status-${role} clears ${floor}:1 on the ${label}`, () => {
          const tinted = composite(ink, alpha, cardSurface);
          const ratio = contrast(ink, tinted);
          expect(
            ratio,
            `status-${role} (${ink}) on ${tinted} — its own ${alpha * 100}% tint over ` +
            `the card surface ${cardSurface} — measured ${ratio.toFixed(2)}:1, need ≥${floor}:1`,
          ).toBeGreaterThanOrEqual(floor);
        });
      }
    }
  }
});
