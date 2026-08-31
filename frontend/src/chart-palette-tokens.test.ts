import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Analytics and the graph view are the two surfaces that render colour rather
 * than merely style it: Recharts series, and a force-graph canvas. Both used
 * to carry their own palettes, hard-coded as Tailwind v3 defaults — one set of
 * hexes for both themes, tuned for neither. They followed no theme switch and
 * failed contrast on the light pane, where v3's emerald measured 2.54:1 on
 * white against `--color-status-connected`'s 5.43:1 and v3's amber 2.15:1
 * against `--color-status-syncing`'s 5.93:1.
 *
 * That defect is invisible in review — a hex in a chart prop looks like
 * configuration — and it comes back the moment someone adds a series. So it
 * is asserted mechanically: nothing in these directories may spell a colour.
 * Series colours resolve tokens through `useThemeColors`, chrome references
 * `var(--color-…)`, and the reasoning is written in prose without hexes so a
 * comment cannot smuggle one back in either.
 *
 * `features/setup/setup-status-tokens.test.ts` guards the setup wizard the
 * same way; `chart-theme-colors.test.tsx` proves the replacement actually
 * tracks the theme.
 */

const SRC = import.meta.dirname;
const SCANNED = ['features/admin/analytics', 'features/graph'];

/** Colour hexes in every CSS-legal width. */
const HEX = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;

/**
 * `#303`, `#1257` — issue references, which these files carry in quantity.
 * A leading zero rules the shorthand colours (`#000`, `#0f0`) back in.
 */
const ISSUE_REF = /^#[1-9][0-9]{2,3}$/;

/** Literal colour functions: `rgba(23, 24, 26, 0.85)`, `hsl(…)`. */
const COLOR_FUNCTION = /\b(?:rgb|rgba|hsl|hsla)\(\s*[\d.]/g;

/**
 * Literal Tailwind palette utilities: `text-amber-500`, `bg-blue-600/20`.
 * These are v3 shades on a v4 token palette — nothing remaps them per theme.
 */
const LITERAL_SHADE =
  /\b(?:bg|text|border|ring|fill|stroke|from|via|to|shadow|outline|decoration|accent|caret|divide)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/g;

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

interface Offence {
  where: string;
  literal: string;
  line: string;
}

function scan(pattern: RegExp, keep: (literal: string) => boolean = () => true): Offence[] {
  const offences: Offence[] = [];
  for (const root of SCANNED) {
    for (const file of sourceFiles(resolve(SRC, root))) {
      readFileSync(file, 'utf-8')
        .split('\n')
        .forEach((line, index) => {
          for (const [literal] of line.matchAll(pattern)) {
            if (!keep(literal)) continue;
            offences.push({
              where: `${file.slice(SRC.length + 1)}:${index + 1}`,
              literal,
              line: line.trim().slice(0, 90),
            });
          }
        });
    }
  }
  return offences;
}

function report(offences: Offence[]): string {
  return offences.map((o) => `  ${o.where}  ${o.literal}  —  ${o.line}`).join('\n');
}

describe('Charts and the graph canvas state colour in palette tokens', () => {
  it('spells no colour hex', () => {
    const offences = scan(HEX, (literal) => !ISSUE_REF.test(literal));

    expect(
      offences,
      'A hex here follows no theme and was measured failing contrast on Paper.\n' +
        'Resolve the token that owns the meaning instead — useThemeColors for a\n' +
        'value a renderer must read, var(--color-…) for chart chrome:\n' +
        report(offences),
    ).toEqual([]);
  });

  it('spells no literal rgb()/hsl() colour', () => {
    const offences = scan(COLOR_FUNCTION);

    expect(
      offences,
      'Derive alpha variants from a resolved token with withAlpha() rather than\n' +
        'writing the channels out — a copied channel triple is what went stale:\n' +
        report(offences),
    ).toEqual([]);
  });

  it('uses no literal Tailwind palette shade', () => {
    const offences = scan(LITERAL_SHADE);

    expect(
      offences,
      'Tailwind v3 shades are dark-theme tuned and are not remapped for Paper.\n' +
        'Use the semantic utilities (bg-success, text-status-ai, …):\n' +
        report(offences),
    ).toEqual([]);
  });
});
