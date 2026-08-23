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

/**
 * Matches the named scale AND arbitrary values AND `drop-shadow`.
 *
 * The first version matched only `shadow-{sm,md,lg,xl,2xl,inner}`, which let
 * five shadows through: three coloured glows on ConfidenceBadge, a hardcoded
 * `#22d3ee` glow on StreamingCursor, a `drop-shadow` on the main nav's
 * *expanded* renderer (the rail copy had been cleaned, under a comment claiming
 * it was the last one), and — worst — an AiDockSheet shadow pointing at
 * `--nm-shadow-out-strong`, a retired token that now resolves to `transparent`,
 * so it rendered nothing while reading as live code. A guard whose pattern is
 * narrower than the rule it enforces certifies exactly the call sites nobody
 * would have written by accident.
 *
 * KNOWN GAP, unchanged by this file's history and deliberately not closed here:
 * this is still the pre-v4 named scale, so Tailwind 4's own spellings — `shadow-xs`,
 * `shadow-2xs`, a coloured `shadow-cyan-400/40`, the CSS-variable shorthand
 * `shadow-(--shadow-overlay)` — do not match at all. Widening it is not a
 * one-line edit: `shadow-xs` alone is live on four real call sites today
 * (`NotesInspectorPanel` ×3, `EditorSlashMenu` ×1), so the pattern and those
 * components have to move together, in a change that is about the components.
 */
const SHADOW_UTILITY = /\b(drop-)?shadow(-(sm|md|lg|xl|2xl|inner))?(-\[|(?=["'\s]|$))/;

/**
 * Tailwind utilities that carry no `-`, `:` or `/`, so token shape alone cannot
 * tell them from an English word. Everything in this tree's real class lists is
 * here (harvested from every `className` literal under `src/`), plus the rest of
 * the dash-free scale, plus this repo's own `skeleton` / `prose`.
 */
const BARE_UTILITIES = new Set([
  'absolute',
  'antialiased',
  'block',
  'blur',
  'border',
  'capitalize',
  'collapse',
  'columns',
  'container',
  'contents',
  'filter',
  'fixed',
  'flex',
  'grayscale',
  'grid',
  'group',
  'grow',
  'hidden',
  'inline',
  'invert',
  'invisible',
  'isolate',
  'italic',
  'lowercase',
  'ordinal',
  'outline',
  'overline',
  'peer',
  'prose',
  'relative',
  'resize',
  'ring',
  'rounded',
  'sepia',
  'shadow',
  'shrink',
  'skeleton',
  'static',
  'sticky',
  'table',
  'transform',
  'transition',
  'truncate',
  'underline',
  'uppercase',
  'visible',
]);

const CLASS_TOKEN = /^-?[a-z0-9][a-z0-9:_./%!@&<>~+*(),#-]*$/;

/**
 * True when the body is a run of Tailwind-shaped tokens rather than a sentence.
 *
 * This discriminates on TOKEN SHAPE, and that is the whole point. The first
 * version of this exemption tested the WHOLE STRING for sentence punctuation —
 * and Tailwind's fractional spacing scale (`p-1.5`, `gap-2.5`, `py-0.5`) puts a
 * `.` in roughly 900 of this tree's real class lists, so a bare `shadow` dropped
 * into any of them read as prose and walked straight through the sweep. Verified
 * by mutation before this rewrite: `p-1.5 shadow` on a live component left the
 * guard green.
 *
 * Arbitrary values (`shadow-[var(--shadow-overlay)]`, `[scrollbar-gutter:stable]`)
 * and `${}` placeholders collapse to a dashed stand-in first: their innards carry
 * capitals, dots and parens that say nothing about the enclosing token's shape.
 *
 * Tailwind-shaped = lowercase, drawn from the utility charset, and either
 * carrying a `-` / `:` / `/` or naming one of `BARE_UTILITIES`. The residual
 * trade-off is deliberate and one-directional: a dash-free utility missing from
 * that set makes its class list read as prose, which can only ever forgive a
 * bare `shadow` standing beside it. It can never red-light English — the failure
 * mode that gets a guard deleted.
 */
function isClassList(body: string): boolean {
  const tokens = body
    .replace(/\$\{[^{}]*\}/g, 'x-x')
    .replace(/\[[^\]]*\]/g, 'x-x')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return false;
  return tokens.every((t) => CLASS_TOKEN.test(t) && (/[-:/]/.test(t) || BARE_UTILITIES.has(t)));
}

/**
 * True when every shadow match in `body` is one the rule permits.
 *
 * `shadow` is a Tailwind utility AND an ordinary English word, and the pattern
 * has to match the bare token or `className="shadow"` walks straight through.
 * That is also how this guard came to fail on `EmbeddingShadowMigrationCard`'s
 * toast — "the shadow migration changed underneath it" — a user-facing sentence
 * naming a feature's own domain term, in a string that never reaches a class
 * attribute. A guard that red-lights English is a guard people delete.
 *
 * So the AMBIGUOUS bare form (`shadow` / `drop-shadow`, no suffix) is permitted
 * outside a class list, and only there. Every unambiguous spelling — `shadow-lg`,
 * `shadow-[…]`, `drop-shadow-md` — stays matched everywhere, prose included,
 * because none of those is a word anyone writes by accident.
 *
 * `shadow-[var(--shadow-overlay)]` is the system shadow spelled as an arbitrary
 * value, for the overlays that are not `nm-card-elevated` (two drawers, a round
 * floating button). Allowed by name, per occurrence — naming it once no longer
 * absolves the rest of the string.
 */
function shadowIsPermitted(body: string): boolean {
  const re = new RegExp(SHADOW_UTILITY.source, 'g');
  for (let m = re.exec(body); m; m = re.exec(body)) {
    const rest = body.slice(m.index);
    if (/^shadow-\[var\(--shadow-overlay\)\]/.test(rest)) continue;
    const bare = !m[2] && m[4] !== '-[';
    if (bare && !isClassList(body)) continue;
    return false;
  }
  return true;
}

describe('the component layer is as flat as the token layer', () => {
  it('the shadow guard reads class lists, not prose', () => {
    // Fixtures rather than sources: the matcher itself is what is under test,
    // and a sweep that finds nothing proves nothing about why it found nothing.
    const offends = (body: string) => !shadowIsPermitted(body);

    expect(offends('shadow')).toBe(true);
    expect(offends('flex shadow rounded-md')).toBe(true);
    // Tailwind's fractional scale puts a `.` in ~900 of this tree's class lists.
    // A discriminator that reads the string's punctuation instead of its tokens
    // hands every one of them the bare-`shadow` exemption; these pin that shut.
    expect(offends('flex rounded-md p-1.5 shadow')).toBe(true);
    expect(offends('mt-0.5 flex shadow')).toBe(true);
    expect(offends('rounded-full shadow bg-success/15 px-2 py-0.5 font-medium')).toBe(true);
    expect(offends('space-y-1.5 drop-shadow')).toBe(true);
    expect(offends('w-20 rounded-md border px-2 py-1.5 shadow text-sm')).toBe(true);
    // Capitals inside an arbitrary value are not a sentence either.
    expect(offends('shadow w-[calc(100%-1.5rem)] bg-[var(--Foo)]')).toBe(true);
    // `${}` spans are placeholders, not prose.
    expect(offends('flex ${tone} gap-1.5 shadow')).toBe(true);
    expect(offends('nm-card shadow-lg p-3')).toBe(true);
    expect(offends('hover:drop-shadow-md')).toBe(true);
    expect(offends('shadow-[0_0_8px_#22d3ee]')).toBe(true);
    expect(offends('rounded-full shadow-[var(--shadow-overlay)]')).toBe(false);

    // Prose naming this codebase's own domain term is not a call site.
    expect(
      offends('The comparison in progress ended — the shadow migration changed underneath it.'),
    ).toBe(false);
    expect(offends('Start a shadow migration first.')).toBe(false);
    // …and it stays prose with neither a capital nor a full stop to lean on:
    // the words themselves are not utility-shaped.
    expect(offends('the shadow migration changed underneath it')).toBe(false);

    // …but prose buys no exemption for an actual utility sitting in it.
    expect(offends('Applies the shadow-lg class. Do not.')).toBe(true);
  });

  it('no Tailwind shadow utility survives — the system has one shadow', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const hits = callsites(file, SHADOW_UTILITY, shadowIsPermitted);
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

  it('status colours are tokens, never a raw Tailwind palette shade', () => {
    // Tokens track the theme; the palette does not. Every one of these classes
    // had been picked to look right in Graphite, so the light theme inherited a
    // set of near-invisible status states — `text-emerald-300` on
    // `bg-emerald-500/10` over Paper's white card measured 1.52:1, and that was
    // the *success* state of the sync panel. `text-amber-100` measured 1.11:1.
    //
    // The same markup on tokens measures 4.75–6.31:1 in Paper and 5.57–8.69:1
    // in Graphite, computed over `bg-<role>/10` on the card.
    //
    // Two things the sweep had to preserve that a colour name alone does not
    // carry, and which are the reason this is a guard and not just a rename:
    //   - the SHADE encoded tint-vs-solid. `bg-yellow-50` is a pale panel fill
    //     and `bg-yellow-500` is a solid one; collapsing both to `bg-warning`
    //     turned three tinted badges into full-strength fills, one of which
    //     ended up painting `text-destructive` on `bg-destructive`.
    //   - a 2px streaming cursor and a score dot are solid MARKS, not panels,
    //     so the shade heuristic's tint was wrong for them specifically.
    const PALETTE =
      'red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone';
    const offenders: string[] = [];
    for (const file of FILES) {
      for (const hit of callsites(
        file,
        new RegExp(`\\b(text|bg|border|ring|from|to|via|divide|outline|decoration|fill|stroke)-(${PALETTE})-\\d{2,3}`),
      )) {
        offenders.push(`${file.path}: ${hit}`);
      }
    }
    expect(
      offenders,
      'use the semantic token (success / warning / destructive / info / ' +
        'status-*) — a raw palette shade is fixed to one theme, and every one ' +
        'of these was chosen against the dark one',
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
