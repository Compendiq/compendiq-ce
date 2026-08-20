import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * A focus indicator has to be VISIBLE, and in this system it is the only thing
 * marking the focused control — the flat conversion removed the shadows that
 * used to help, and `forced-colors` discards shadow anyway.
 *
 * WCAG 1.4.11 puts the floor at 3:1 against adjacent colour. Tailwind's
 * `ring-<colour>/<n>` composites the ring against whatever is behind it, so the
 * opacity comes straight off the ratio:
 *
 *   ring-ring        #3f627c on #ffffff  ->  6.46:1   PASS
 *   ring-ring/50     #9fb0bd on #ffffff  ->  2.23:1   FAIL
 *
 * 76 focus rings across 38 files were fractional, so roughly half the app's
 * focus indicators failed in Paper — including the default `ring-ring/50` used
 * by 57 of them. Dark theme mostly passed, which is why it was never noticed:
 * the ratio is computed against a near-black ground there.
 *
 * This guard does two things a hex-pinning test could not. It COMPUTES the
 * composite ratio from the tokens in `index.css`, so retuning the accent fails
 * here with a measured number rather than silently degrading the focus ring;
 * and it forbids fractional opacity on a focus ring outright, because the
 * composite depends on the ground and a ring that passes on the card can still
 * fail on a tinted row.
 */

const SRC = __dirname;
const css = readFileSync(join(SRC, 'index.css'), 'utf8');

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sources(full, out);
    else if (/\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Light-theme block starts at `[data-theme="paper"]`; dark is everything before. */
function token(name: string, theme: 'dark' | 'light'): string {
  const at = css.indexOf('[data-theme="paper"]');
  const block = theme === 'dark' ? css.slice(0, at) : css.slice(at);
  const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block);
  if (!m) throw new Error(`${name} not found in the ${theme} block — this guard is stale`);
  return m[1]!.toLowerCase();
}

const rgb = (hex: string) =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

const luminance = (c: [number, number, number]) => {
  const [r, g, b] = c.map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(rgb(a)), luminance(rgb(b))].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

describe('focus indicators clear WCAG 1.4.11', () => {
  it('the ring token measures ≥3:1 on every ground a focused control sits on', () => {
    for (const theme of ['dark', 'light'] as const) {
      const ring = token('--color-ring', theme);
      const grounds = {
        background: token('--color-background', theme),
        card: token('--color-card', theme),
        elevated: token('--color-card-elevated', theme),
        accent: token('--color-accent', theme),
        muted: token('--color-muted', theme),
      };
      for (const [name, ground] of Object.entries(grounds)) {
        const r = contrast(ring, ground);
        expect(
          r,
          `${theme}: focus ring ${ring} on ${name} ${ground} measured ${r.toFixed(2)}:1, need ≥3:1`,
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('no focus ring uses fractional opacity', () => {
    // Not a style rule. `ring-ring/50` composites below 3:1 on Paper's card —
    // the alpha comes directly off the ratio, and because the composite depends
    // on the ground, a value that squeaks past on one surface fails on a tinted
    // row. Full opacity is the only spelling that holds everywhere.
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/focus(-visible)?:ring-[a-z-]+\/\d+/g)) {
        offenders.push(`${relative(SRC, file)}: ${m[0]}`);
      }
    }
    expect(
      offenders,
      'a focus ring is the only thing marking the focused control in this ' +
        'system — it does not get to be translucent',
    ).toEqual([]);
  });

  it('the sweep is looking at the real sources', () => {
    const files = sources(SRC);
    expect(files.length, 'no .tsx sources found — this guard is stale').toBeGreaterThan(150);
    expect(
      files.some((f) => /focus-visible:ring-ring\b/.test(readFileSync(f, 'utf8'))),
      'no full-opacity focus ring found — the convention moved and this guard did not',
    ).toBe(true);
  });
});

/**
 * A `Dialog.Close` is the one control every keyboard user hits to leave a
 * modal. Seven of the eight in this app carried no focus-visible ring at all
 * — the browser's default outline instead of `--color-ring` — which the
 * fractional-opacity check above cannot see: a class that is simply ABSENT
 * matches no regex looking for a wrong value. Fixed by moving them onto the
 * shared `nm-icon-button` utility (already correct in RelocateDialog, whose
 * own focus-visible outline is defined once in index.css rather than per
 * callsite). This guard is what stops the next one from being hand-rolled
 * back into ringlessness — it inspects the actual JSX near every
 * `Dialog.Close` in the tree, not a fixed list of files, so a new dialog
 * added later is covered automatically.
 */
describe('Dialog.Close controls carry a real focus ring', () => {
  it('every Dialog.Close (or its asChild button) uses a ring-bearing class', () => {
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/<Dialog\.Close\b/g)) {
        // Look at the JSX immediately following the tag — either
        // `<Dialog.Close className="...">` directly, or
        // `<Dialog.Close asChild><button className="...">`. A fixed
        // character window is a pragmatic stand-in for a real JSX parse,
        // matching this file's own style of scanning source text rather
        // than an AST; 400 chars comfortably spans both patterns as
        // written throughout this codebase without reaching the next,
        // unrelated element.
        const window = text.slice(m.index, m.index + 400);
        const classNameMatch = /className=(?:"([^"]*)"|\{`([^`]*)`\})/.exec(window);
        const className = classNameMatch?.[1] ?? classNameMatch?.[2] ?? '';
        // Any of the shared `nm-*` control recipes carry their own
        // `:focus-visible { outline-color: var(--color-ring) }` in
        // index.css — an icon-only close (nm-icon-button) or a labelled one
        // (Cancel-style, nm-button-*) are both legitimate shapes here.
        const hasRing =
          /\bnm-(icon-button|button-primary|button-ghost|button-destructive|action-destructive)\b/.test(className) ||
          /focus-visible:ring-/.test(className);
        if (!hasRing) {
          const line = text.slice(0, m.index).split('\n').length;
          offenders.push(`${relative(SRC, file)}:${line} (className: ${JSON.stringify(className)})`);
        }
      }
    }
    expect(
      offenders,
      'a Dialog.Close (or its asChild control) rendered no ring-bearing class — ' +
        'use nm-icon-button/nm-button-*, or an explicit focus-visible:ring- class',
    ).toEqual([]);
  });

  it('the sweep is looking at real Dialog.Close usages', () => {
    const files = sources(SRC);
    const found = files.some((f) => /<Dialog\.Close\b/.test(readFileSync(f, 'utf8')));
    expect(found, 'no Dialog.Close usage found anywhere — this guard is stale').toBe(true);
  });
});
