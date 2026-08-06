import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * `workspace-themes.test.ts` computes its verdicts from `index.css`, which is
 * the right place for the token ladder — but it means the COMPONENT layer was
 * never swept. That gap was not theoretical: after the flat conversion shipped,
 * 37 Tailwind `shadow-*` utilities were still live across 32 `.tsx` files, in
 * four different sizes, for a system whose ADR says exactly one shadow exists.
 * `PresenceAvatarStack` still painted a gradient and a hardcoded `border-white/10`
 * that Paper rendered as white-on-white, and the pinned article cards still
 * rotated in 3D under the cursor. Every one of those passed a green CSS suite.
 *
 * So this file sweeps the sources. The rules it enforces are ADR-010 v0.6's:
 *
 *   - Depth is a value step plus a 1px hairline. The single overlay shadow is
 *     `--shadow-overlay`, carried by `nm-card-elevated`. Tailwind's shadow scale
 *     is not part of the system.
 *   - No lift, no scale, no glass. `backdrop-blur` survives ONLY on a modal
 *     scrim, where it is a specific effect rather than decoration standing in
 *     for hierarchy.
 *   - Surfaces are flat colours, not gradients.
 *   - Borders come from tokens, so they track the theme. A literal `border-white/N`
 *     is invisible on Paper's white card.
 */

const SRC = __dirname;

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sources(full, out);
    else if (/\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Comments are stripped before anything is scanned, and it has to be a real
 * strip rather than a per-line `^\s*(\*|//)` test: several of these files
 * explain at length why an effect was removed, quoting the class name that was
 * removed. A continuation line inside a `/* … *\/` block need not start with an
 * asterisk, so the naive test reads the rationale as a callsite and the sweep
 * fails on its own documentation. Blank the comment spans, keep the line count.
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

const FILES = sources(SRC).map((f) => ({
  path: relative(SRC, f),
  text: stripComments(readFileSync(f, 'utf8')),
}));

/** Class utilities only — the text is already comment-free. */
function callsites(text: string, pattern: RegExp): string[] {
  return text
    .split('\n')
    .filter((line) => pattern.test(line) && /["'`]/.test(line))
    .map((l) => l.trim().slice(0, 100));
}

describe('the component layer is as flat as the token layer', () => {
  it('no Tailwind shadow utility survives — the system has one shadow', () => {
    const offenders: string[] = [];
    for (const { path, text } of FILES) {
      // `shadow-[var(--shadow-overlay)]` is the system shadow spelled as an
      // arbitrary value, for the two overlays that are not `nm-card-elevated`
      // (a drawer on `nm-sidebar`, a round floating button). Allowed by name.
      for (const hit of callsites(text, /\bshadow(-(sm|md|lg|xl|2xl|inner))?(?=["'\s])/)) {
        if (hit.includes('shadow-[var(--shadow-overlay)]')) continue;
        offenders.push(`${path}: ${hit}`);
      }
    }
    expect(
      offenders,
      `Tailwind's shadow scale is not part of this system. An overlay (popover, ` +
        `dropdown, dialog, palette, toast) uses \`nm-card-elevated\`; an in-page ` +
        `pane earns emphasis from position, spacing and heading weight.`,
    ).toEqual([]);
  });

  it('backdrop-blur appears only on full-viewport modal scrims', () => {
    const offenders: string[] = [];
    for (const { path, text } of FILES) {
      for (const line of text.split('\n')) {
        if (!/backdrop-blur/.test(line.replace(/\/\/.*$/, ''))) continue;
        // A scrim covers the viewport and tints it. Anything else using blur is
        // decoration standing in for hierarchy.
        if (/fixed\s+inset-0/.test(line) && /bg-(black|background)\//.test(line)) continue;
        offenders.push(`${path}: ${line.trim().slice(0, 100)}`);
      }
    }
    expect(
      offenders,
      'blur survives only on `fixed inset-0` modal scrims, never on an in-flow pane',
    ).toEqual([]);
  });

  it('no gradient is used as a surface', () => {
    const offenders: string[] = [];
    for (const { path, text } of FILES) {
      for (const hit of callsites(text, /\bbg-gradient-to-[a-z]+/)) offenders.push(`${path}: ${hit}`);
    }
    expect(offenders, 'surfaces are flat values in this system, not gradients').toEqual([]);
  });

  it('no hover lift or press scale', () => {
    const offenders: string[] = [];
    for (const { path, text } of FILES) {
      for (const hit of callsites(text, /\b(hover|active|group-hover):(scale-|-?translate-y-)/))
        offenders.push(`${path}: ${hit}`);
    }
    expect(offenders, 'hover and press are background/border changes, not motion').toEqual([]);
  });

  it('borders come from tokens, not literal white', () => {
    const offenders: string[] = [];
    for (const { path, text } of FILES) {
      for (const hit of callsites(text, /\bborder-white\//)) {
        // The draw.io overlay is a deliberate black panel, not a themed surface;
        // a white hairline is the coherent choice there and tracks nothing.
        if (path.includes('DrawioEditor')) continue;
        offenders.push(`${path}: ${hit}`);
      }
    }
    expect(
      offenders,
      '`border-white/N` does not track the theme — on Paper it is white on a white card',
    ).toEqual([]);
  });

  it('the sweep is looking at the real sources', () => {
    // Anti-vacuity: if the walk or the extension filter breaks, every rule above
    // passes on an empty set and the file becomes decoration.
    expect(FILES.length, 'no .tsx sources found — this sweep is stale').toBeGreaterThan(150);
    expect(
      FILES.some((f) => /\bnm-card-elevated\b/.test(f.text)),
      'no nm-card-elevated callsite found — the overlay convention moved',
    ).toBe(true);
  });
});
