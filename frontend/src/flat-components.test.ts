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
 * removed. A continuation line inside a block comment need not start with an
 * asterisk, so the naive test reads the rationale as a callsite and the sweep
 * fails on its own documentation.
 *
 * It must also be QUOTE-AWARE. A regex `//` strip blanks the rest of the line
 * from inside `href="https://…"` — and there are ~18 such lines in this tree —
 * so a class sitting after a URL on the same line became invisible to the whole
 * sweep. That is a silent hole in a guard, which is worse than no guard.
 *
 * Known limitation: a regex literal containing a quote (`/["']/`) can desync the
 * scanner. Accepted — it costs at most a spurious finding, never a missed one,
 * and a missed one is the failure mode that matters here.
 */
function stripComments(text: string): string {
  let out = '';
  let quote: string | null = null;
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    const n = text[i + 1];
    if (quote) {
      if (c === '\\') {
        out += c + (text[i + 1] ?? '');
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      out += c;
      i += 1;
      continue;
    }
    if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (c === '/' && n === '*') {
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        out += text[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += '  ';
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    out += c;
    i += 1;
  }
  return out;
}

/**
 * Every string and template-literal body in the file.
 *
 * Classes only ever live inside one, so this is what the sweep should look at.
 * The previous version filtered LINES that contained a quote character, which
 * silently skipped any class on its own line inside a multi-line template —
 * a second way to evade the guard without trying. Scanning literal bodies
 * closes that and drops the false positives from bare identifiers at once.
 */
function stringBodies(text: string): string[] {
  const out: string[] = [];
  let quote: string | null = null;
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (quote) {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === quote) {
        out.push(text.slice(start, i));
        quote = null;
      }
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      start = i + 1;
    }
    i += 1;
  }
  return out;
}

const FILES = sources(SRC).map((f) => {
  const stripped = stripComments(readFileSync(f, 'utf8'));
  return { path: relative(SRC, f), text: stripped, strings: stringBodies(stripped) };
});

/**
 * Matches inside string/template bodies only — never bare identifiers.
 *
 * `allow` is applied to the FULL body, before truncation. Applying an allowance
 * to the shortened display string is a live bug I shipped for one commit: a
 * legitimate `shadow-[var(--shadow-overlay)]` sitting past column 100 of a long
 * class list got cut off, the allowance stopped matching, and the guard failed
 * on the exact call sites it was written to permit.
 */
function callsites(
  file: { strings: string[] },
  pattern: RegExp,
  allow?: (body: string) => boolean,
): string[] {
  return file.strings
    .filter((s) => pattern.test(s) && !(allow?.(s) ?? false))
    .map((s) => s.replace(/\s+/g, ' ').trim().slice(0, 100));
}

describe('the component layer is as flat as the token layer', () => {
  it('no Tailwind shadow utility survives — the system has one shadow', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      // Matches the named scale AND arbitrary values AND `drop-shadow`.
      //
      // The first version matched only `shadow-{sm,md,lg,xl,2xl,inner}`, which
      // let five shadows through: three coloured glows on ConfidenceBadge, a
      // hardcoded `#22d3ee` glow on StreamingCursor, a `drop-shadow` on the
      // main nav's *expanded* renderer (the rail copy had been cleaned, under a
      // comment claiming it was the last one), and — worst — an AiDockSheet
      // shadow pointing at `--nm-shadow-out-strong`, a retired token that now
      // resolves to `transparent`, so it rendered nothing while reading as live
      // code. A guard whose pattern is narrower than the rule it enforces
      // certifies exactly the call sites nobody would have written by accident.
      //
      // `shadow-[var(--shadow-overlay)]` is the system shadow spelled as an
      // arbitrary value, for the overlays that are not `nm-card-elevated`
      // (two drawers, a round floating button). Allowed by name.
      const hits = callsites(
        file,
        /\b(drop-)?shadow(-(sm|md|lg|xl|2xl|inner))?(-\[|(?=["'\s]|$))/,
        (body) => /\bshadow-\[var\(--shadow-overlay\)\]/.test(body),
      );
      for (const hit of hits) offenders.push(`${file.path}: ${hit}`);
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
    for (const file of FILES) {
      for (const hit of callsites(file, /\bbg-gradient-to-[a-z]+/)) offenders.push(`${file.path}: ${hit}`);
    }
    expect(offenders, 'surfaces are flat values in this system, not gradients').toEqual([]);
  });

  it('no hover lift or press scale', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      for (const hit of callsites(file, /\b(hover|active|group-hover):(scale-|-?translate-y-)/))
        offenders.push(`${file.path}: ${hit}`);
    }
    expect(offenders, 'hover and press are background/border changes, not motion').toEqual([]);
  });

  it('no lift or scale via Framer props either', () => {
    // The class rule above cannot see `whileHover={{ scale: 1.02 }}` — it is a
    // JS prop, not a string. The setup wizard was doing exactly that, so "no
    // lift, no scale" held everywhere the guard could look and nowhere else.
    // Scanned over raw text rather than string bodies, since these are objects.
    const offenders: string[] = [];
    for (const { path, text } of FILES) {
      const re = /\bwhile(Hover|Tap|Focus)\s*=\s*\{\{[^}]*\b(scale|y)\s*:/g;
      for (const m of text.matchAll(re)) {
        offenders.push(`${path}: ${m[0].replace(/\s+/g, ' ').slice(0, 70)}`);
      }
    }
    expect(
      offenders,
      'hover and press are background/border changes — that rule is about the ' +
        'gesture, not about which API expresses it',
    ).toEqual([]);
  });

  it('borders come from tokens, not literal white', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      for (const hit of callsites(file, /\bborder-white\//)) {
        // The draw.io overlay is a deliberate black panel, not a themed surface;
        // a white hairline is the coherent choice there and tracks nothing.
        if (file.path.includes('DrawioEditor')) continue;
        offenders.push(`${file.path}: ${hit}`);
      }
    }
    expect(
      offenders,
      '`border-white/N` does not track the theme — on Paper it is white on a white card',
    ).toEqual([]);
  });

  it('the AI signal is the token, never a raw purple', () => {
    // `--color-status-ai` is #c084fc dark / #7041a8 light, so it tracks the
    // theme. Tailwind's palette does not: `text-purple-300` on Paper's white
    // card measures 1.77:1, and on the `bg-purple-500/10` tint it was paired
    // with, 1.56:1 — invisible. The same markup measured 6.00:1 once it moved
    // to the token, with no regression in Graphite (5.78:1).
    //
    // Scoped to purple deliberately. The wider problem is real and much larger
    // — ~345 raw palette classes remain, mostly amber/emerald/red status
    // colours with the same light-theme failure — but that is its own change
    // with its own testing, not a rider on this one.
    const offenders: string[] = [];
    for (const file of FILES) {
      for (const hit of callsites(file, /\b(text|bg|border|ring)-purple-\d{3}/)) {
        offenders.push(`${file.path}: ${hit}`);
      }
    }
    expect(
      offenders,
      'use `status-ai` — a raw purple does not track the theme and is unreadable on Paper',
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
