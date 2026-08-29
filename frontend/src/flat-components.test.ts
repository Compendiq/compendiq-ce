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
 * Every string and template-literal body in the file, RESYNCHRONISED at each
 * newline.
 *
 * Classes only ever live inside one, so this is what the sweep should look at.
 * The version before this one filtered LINES that contained a quote character,
 * which silently skipped any class on its own line inside a multi-line template.
 * Scanning literal bodies closes that and drops the false positives from bare
 * identifiers at once.
 *
 * The resync is the fix for the second half of that story. A `'` or `"` literal
 * cannot contain a raw newline, so a scanner that is still "inside" one when it
 * reaches end of line has DESYNCED — on an apostrophe in JSX copy, almost
 * always. Carrying that state forward swallowed the rest of the file into one
 * enormous body: measured on this tree, 152 live class lists across 8 files
 * (ScimSettingsPage, OidcSettingsPage, ComplianceReportsTab, MermaidDiagram,
 * DiagramMode, EmbeddingShadowCompareSection, PagesPage, KeyboardShortcutsModal)
 * were not visible as their own body, and six files ended inside an unclosed
 * quote, which dropped their tails from the sweep entirely — 75 class lists that
 * could carry any banned utility without the guard ever seeing it.
 *
 * The old comment here called a desync harmless: "it costs at most a spurious
 * finding, never a missed one". That was true only while every rule was a naked
 * pattern test. The moment a rule EXEMPTS anything — and the shadow rule below
 * has to, or it flags English — a merged body is a hole: one prose sentence
 * exempts every class list merged in beside it.
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
      if (c === '\n' && quote !== '`') {
        out.push(text.slice(start, i));
        quote = null;
        i += 1;
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
  // A body still open at EOF is content the sweep must see, not content to drop.
  if (quote !== null) out.push(text.slice(start));
  return out;
}

/**
 * The `${…}` regions of a template body, as index pairs, with BALANCED braces.
 *
 * A regex cannot do this: `\$\{[^{}]*\}` stops at the first `}`, so any
 * interpolation holding an object literal, a nested template or a second
 * interpolation is mis-cut and its tail is left inline in the class-list text,
 * where it reads as neither a class list nor prose.
 */
function interpolations(body: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (let i = 0; i < body.length - 1; i += 1) {
    if (body[i] !== '$' || body[i + 1] !== '{') continue;
    let depth = 0;
    for (let j = i + 1; j < body.length; j += 1) {
      const c = body[j]!;
      if (c === '{') depth += 1;
      else if (c === '}') {
        depth -= 1;
        if (depth === 0) {
          out.push({ start: i, end: j + 1 });
          i = j;
          break;
        }
      }
    }
  }
  return out;
}

/**
 * The candidate CLASS LISTS in a file: a quoted body cut at every `${…}`
 * interpolation, every newline, and every `"` or backtick inside it — plus, for
 * each interpolation, the class lists nested INSIDE it.
 *
 * A rule that exempts has to judge the SEGMENT its match sits in, never the
 * whole body — `clsx` calls, template literals and any residual desync put
 * several unrelated strings in one body, and judging the body means one
 * fragment's verdict decides all of them. So a `'`-opened body that ran past a
 * `className="…"` gets cut back into its parts, and the class list is judged on
 * its own. Cutting at interpolations matters for the opposite reason:
 * `` `p-2 ${size} shadow-lg` `` is a class list with a hole in the middle, and
 * the hole is not a Tailwind token.
 *
 * Cutting is not DISCARDING, and the version before this one discarded: `${…}`
 * was a split DELIMITER, so
 * `` className={`px-3 ${on ? 'bg-action shadow-lg' : 'text-muted'}`} `` — the
 * dominant shape for a conditional class in this tree — lost both of its nested
 * class lists before any rule ran, and `stringBodies` never recovered them,
 * because a `'` inside a backtick body is plain content. Measured on this tree,
 * 27 live class lists across 12 files were invisible that way, and the pattern
 * this rule replaces saw every one of them (as part of the merged backtick
 * body), so discarding made the guard strictly WEAKER than its predecessor. An
 * interpolation is CODE: it is scanned as code, and the string literals inside
 * it are class lists in their own right.
 *
 * `'` is deliberately NOT a cut: it is legal inside a class list, in
 * `before:content-['']`, and cutting there splits a real attribute in half.
 */
function classSegments(text: string): string[] {
  const out: string[] = [];
  collectSegments(text, out);
  return out;
}

function collectSegments(code: string, out: string[]): void {
  for (const body of stringBodies(code)) {
    let cut = 0;
    for (const { start, end } of interpolations(body)) {
      pushChunks(body.slice(cut, start), out);
      collectSegments(body.slice(start + 2, end - 1), out);
      cut = end;
    }
    pushChunks(body.slice(cut), out);
  }
}

function pushChunks(chunk: string, out: string[]): void {
  for (const piece of chunk.split(/[\n"`]/)) out.push(piece);
}

const PALETTE =
  'red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone';

/**
 * Tailwind token grammar: variants, negatives, the `!` important marker, decimal
 * spacing steps (`p-1.5`), fractions (`w-1/2`), opacity (`bg-card/80`), arbitrary
 * values and selectors (`text-[#22d3ee]`, `[&>svg]:size-4`), Tailwind 4's CSS
 * variable shorthand (`shadow-(--shadow-overlay)`), container queries (`@md:flex`),
 * child variants (`*:mt-0`) and the BEM-ish project classes that live in the same
 * attributes (`drawio-nodeview__btn--edit`).
 *
 * Three cases to keep in mind when touching this, all of which turn a real class
 * list into "prose" and so exempt every banned utility standing in it:
 *   - `p-1.5` carries a `.`, so the obvious "letters, digits and hyphens" token
 *     test rejects it and a bare `shadow` in that same list walks out through
 *     the exemption. Three narrowing attempts died on exactly that.
 *   - arbitrary selectors NEST their brackets. `[&_pre:not([data-title])]:p-4`
 *     (Editor.tsx) and `[&_ul[data-type=taskList]_li]:flex` (ArticleViewer.tsx)
 *     are live class lists here, and a `\[[^\]]*\]` bracket stops at the first
 *     inner `]`. Both lists were being read as prose, which exempted all twelve
 *     shadow spellings the pre-v4 pattern caught in them.
 *   - third-party classes are not all lowercase. `ProseMirror` (tiptap),
 *     `Toastify__toast` and `mermaid` render targets sit in the same attributes
 *     as utilities, and a lowercase-only bare token rejected them — so
 *     `"ProseMirror p-1.5 shadow-lg"` was prose and the `shadow-lg` was exempt.
 *     `PROSE_WORD` is matched case-insensitively for exactly this reason, so a
 *     capitalised sentence keeps the verdict it had when capitals were rejected
 *     outright — accepting capitals only ever ADDS class lists, never prose.
 *
 * Bracket and paren groups are MASKED by a balanced scan rather than spelled out
 * as a fixed-depth regex sub-grammar. JS regexes have no recursion, so the
 * version before this one enumerated three levels — and a fourth-level nest
 * (`[&_pre:not([data-x[y[z]]])]:p-4` is legal Tailwind) fell off the end and
 * silently made the whole list prose. A scan has no depth to run out of.
 */
const GROUP_MARK = '\u0001';

/**
 * Every balanced `[…]` / `(…)` group in a token replaced by one placeholder, so
 * the shape test below can be a flat regex at any nesting depth. `null` when the
 * brackets do not balance: an unbalanced bracket is not a token shape, and it is
 * part of what tells prose (`the shadow (see below)`) from a class list.
 *
 * Each opener counts only its OWN kind, so an unbalanced paren inside an
 * arbitrary value — legal, `[a)b]` — still masks as one group.
 */
function maskGroups(token: string): string | null {
  let out = '';
  let i = 0;
  while (i < token.length) {
    const c = token[i]!;
    if (c === ']' || c === ')') return null;
    if (c !== '[' && c !== '(') {
      out += c;
      i += 1;
      continue;
    }
    const close = c === '[' ? ']' : ')';
    let depth = 0;
    let j = i;
    for (; j < token.length; j += 1) {
      const d = token[j]!;
      if (d === c) depth += 1;
      else if (d === close) {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (j === token.length) return null;
    out += GROUP_MARK;
    i = j + 1;
  }
  return out;
}

const TOKEN_PART = String.raw`(?:[A-Za-z0-9_]+(?:\.[a-z0-9]+)?|\*{1,2}|${GROUP_MARK})`;
const TAILWIND_TOKEN = new RegExp(`^!?@?-{0,2}${TOKEN_PART}(?:[-:/]{1,2}${TOKEN_PART})*!?$`);

/**
 * English function words. Nothing else separates a class list from a sentence:
 * `shadow`, `border`, `grid`, `table` and `block` are all real utilities AND real
 * words, and a bare lowercase word is a perfectly good Tailwind token — so the
 * shape test alone reads "the shadow migration changed underneath it" as five
 * utilities. No Tailwind utility spells any word below; every utility that comes
 * close (`from-*`, `to-*`, `via-*`, `not-italic`, `after:`, `has-[…]`) carries a
 * hyphen, a colon or a bracket and so is never tested against this list.
 */
const PROSE_WORD =
  /^(?:a|an|the|and|or|but|nor|so|yet|if|then|else|than|that|this|these|those|it|its|they|them|their|we|our|us|you|your|he|she|his|her|i|me|my|is|are|was|were|be|been|being|am|has|have|had|having|do|does|did|done|will|would|shall|should|can|could|may|might|must|ought|of|to|in|into|on|onto|at|by|for|with|without|within|from|as|about|above|below|under|underneath|over|across|through|during|before|after|since|until|unless|while|when|where|which|who|whom|whose|what|why|how|because|although|though|however|therefore|thus|hence|instead|due|via|per|versus|vs|plus|minus|not|no|never|always|still|already|again|also|just|only|even|ever|too|very|more|most|less|least|many|much|few|several|some|any|all|each|every|both|either|neither|none|one|two|three|other|others|another|same|such|own|here|there|now|once|yes|ok|okay|change|changes|changed|means|meant)$/i;

function isTailwindToken(token: string): boolean {
  const masked = maskGroups(token);
  if (masked === null || !TAILWIND_TOKEN.test(masked)) return false;
  return !PROSE_WORD.test(token);
}

/**
 * A segment is a class list when EVERY whitespace-separated token in it is
 * Tailwind-shaped. One English word is enough to make it prose, which is the
 * asymmetry that keeps the exemption cheap: prose has function words in it and
 * class lists do not.
 */
function isClassList(segment: string): boolean {
  const tokens = segment.split(/\s+/).filter((t) => t !== '');
  return tokens.length > 0 && tokens.every(isTailwindToken);
}

/**
 * Every way Tailwind 4 spells a shadow: the FAMILY prefix, the scale (`2xs` and
 * `xs` are v4's, and v4 RENAMED the old `sm` to `xs` — so a pattern written for
 * v3 certifies the spelling the upgrade produced), arbitrary values, the
 * `(--custom-prop)` shorthand, a theme shadow by name, and coloured shadows with
 * or without an alpha. `shadow-none` is deliberately absent: it paints nothing.
 *
 * There are more than two families. The range this repo pins — `tailwindcss
 * ^4.2.1`, 4.3.0 resolved — ships `--text-shadow-*` (v4.1) and `--inset-shadow-*`
 * (v4.0) theme keys alongside `--shadow-*` and `--drop-shadow-*`,
 * so `text-shadow-lg` and `inset-shadow-sm` are live spellings of the thing this
 * rule bans. The pre-v4 pattern caught both of them incidentally, through its
 * leading `\b`; an anchored `^(?:drop-)?shadow` does not, and dropping them
 * would have made this rule WEAKER than the one it replaces on 26 token shapes.
 *
 * That `\b` in fact accepts ANY hyphenated prefix, so the enumerated list was
 * still 532 token shapes short — every `box-shadow…` and `ring-shadow…`
 * spelling, including the raw CSS property `box-shadow` that ADR-010 bans by the
 * same clause. The prefix is therefore open: any hyphen-separated head, which is
 * exactly what the pattern this replaces matched. No Tailwind utility and no
 * project class in this tree ends in `-shadow` for another reason, and the
 * enumerated families stay in the comment above because they are the ones with
 * theme keys behind them.
 *
 * Arbitrary values are matched to the LAST bracket rather than by a depth-limited
 * sub-grammar, for the same reason the token shape is masked by a scan: the
 * pattern this replaces caught `shadow-[` at any nesting depth, so anything
 * bounded is a regression.
 */
const SHADOW_FAMILY = String.raw`(?:[A-Za-z0-9]+-)*`;
const SHADOW_ROLE =
  'black|white|current|transparent|inherit|primary|secondary|accent|muted|card|popover|border|input|ring|foreground|background|destructive|success|warning|info|action';
const ARBITRARY = String.raw`\[\S*\]`;
const SHADOW_UTILITY = new RegExp(
  `^${SHADOW_FAMILY}shadow(?:-(?:2xs|xs|sm|md|lg|xl|2xl|inner)|-${ARBITRARY}|-\\([^\\s]*\\)` +
    `|-(?:${PALETTE})-\\d{2,3}|-(?:${SHADOW_ROLE})|-overlay(?:-sm)?)?` +
    `(?:\\/(?:${ARBITRARY}|\\d{1,3}(?:\\.\\d+)?))?$`,
);

/**
 * The system shadow, in every spelling that resolves to it. `--shadow-overlay`
 * lives in the `@theme` block, so Tailwind 4 generates `shadow-overlay` from it
 * as well — three call sites already use that spelling, and the arbitrary-value
 * form is what the overlays that are not `nm-card-elevated` use (two drawers, a
 * round floating button, a dropdown). Allowed by name, per token: allowing a
 * whole BODY because one legitimate overlay shadow appears in it, which is what
 * this cell used to do, exempts every other shadow standing next to it.
 */
const SYSTEM_SHADOW =
  /^shadow-(?:overlay(?:-sm)?|\[var\(--shadow-overlay(?:-sm)?\)\]|\(--shadow-overlay(?:-sm)?\))$/;

/**
 * The utility a token names, with its variants removed.
 *
 * The split has to happen at the last colon that is OUTSIDE brackets and
 * parentheses. A colon is legal inside an arbitrary value — `shadow-[color:…]`,
 * `shadow-[shadow:…]` — and cutting at the last colon in the whole token throws
 * the utility away and keeps the tail of the value, which is not a shadow by any
 * pattern. The pre-v4 rule caught those on `shadow-[`, so cutting naively is a
 * hole rather than a cosmetic detail.
 */
function utilityOf(token: string): string {
  let depth = 0;
  let cut = -1;
  for (let i = 0; i < token.length; i += 1) {
    const c = token[i]!;
    if (c === '[' || c === '(') depth += 1;
    else if (c === ']' || c === ')') depth -= 1;
    else if (c === ':' && depth === 0) cut = i;
  }
  return token.slice(cut + 1);
}

function shadowUtilities(segment: string): string[] {
  const out: string[] = [];
  for (const raw of segment.split(/\s+/)) {
    if (raw === '') continue;
    const token = raw.replace(/^!+/, '').replace(/!+$/, '');
    // Variants decide WHEN a utility paints, never whether it is a shadow.
    const utility = utilityOf(token);
    if (!SHADOW_UTILITY.test(utility) || SYSTEM_SHADOW.test(utility)) continue;
    out.push(utility);
  }
  return out;
}

function shadowOffenders(segments: string[]): { token: string; segment: string }[] {
  const out: { token: string; segment: string }[] = [];
  for (const segment of segments) {
    if (!isClassList(segment)) continue;
    for (const token of shadowUtilities(segment)) {
      out.push({ token, segment: segment.replace(/\s+/g, ' ').trim().slice(0, 100) });
    }
  }
  return out;
}

const FILES = sources(SRC).map((f) => {
  const stripped = stripComments(readFileSync(f, 'utf8'));
  return { path: relative(SRC, f), text: stripped, segments: classSegments(stripped) };
});

/**
 * Matches inside class-list segments only — never bare identifiers.
 *
 * `allow` is applied to the FULL segment, before truncation. Applying an
 * allowance to the shortened display string is a live bug I shipped for one
 * commit: a legitimate `shadow-[var(--shadow-overlay)]` sitting past column 100
 * of a long class list got cut off, the allowance stopped matching, and the guard
 * failed on the exact call sites it was written to permit.
 */
function callsites(
  file: { segments: string[] },
  pattern: RegExp,
  allow?: (body: string) => boolean,
): string[] {
  return file.segments
    .filter((s) => pattern.test(s) && !(allow?.(s) ?? false))
    .map((s) => s.replace(/\s+/g, ' ').trim().slice(0, 100));
}

/**
 * The `shadow-xs` call sites Tailwind 4's rename left standing while the guard
 * was still written for v3. They are REGISTERED, not exempted: the cell below
 * requires the register to be exact, so removing one of these classes fails the
 * suite until the entry goes too, and a seventh shadow anywhere — including a
 * second one in the same file — fails immediately. Cleaning up the components is
 * a component change and belongs to whoever owns them; this file owns the guard.
 */
const V4_SHADOW_DEBT: { path: string; token: string; count: number }[] = [
  { path: 'features/pages/PagesPage.tsx', token: 'shadow-xs', count: 1 },
  { path: 'features/pages/notion-import/NotionImportDialog.tsx', token: 'shadow-xs', count: 1 },
  { path: 'shared/components/article/EditorSlashMenu.tsx', token: 'shadow-xs', count: 1 },
  { path: 'shared/components/article/NotesInspectorPanel.tsx', token: 'shadow-xs', count: 3 },
];

function liveShadowTally(): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const file of FILES) {
    for (const hit of shadowOffenders(file.segments)) {
      const key = `${file.path} ${hit.token}`;
      tally[key] = (tally[key] ?? 0) + 1;
    }
  }
  return tally;
}

describe('the component layer is as flat as the token layer', () => {
  it('no Tailwind shadow utility survives — the system has one shadow', () => {
    // A guard whose pattern is narrower than the rule it enforces certifies
    // exactly the call sites nobody would have written by accident. The first
    // version matched only `shadow-{sm,md,lg,xl,2xl,inner}` and let five
    // shadows through: three coloured glows on ConfidenceBadge, a hardcoded
    // `#22d3ee` glow on StreamingCursor, a `drop-shadow` on the main nav's
    // *expanded* renderer (the rail copy had been cleaned, under a comment
    // claiming it was the last one), and — worst — an AiDockSheet shadow
    // pointing at `--nm-shadow-out-strong`, a retired token that now resolves to
    // `transparent`, so it rendered nothing while reading as live code.
    //
    // The second version matched arbitrary values and `drop-shadow` too, and was
    // still a v3 pattern on a v4 repo: `shadow-xs` — which is what v4 renamed
    // `shadow-sm` TO — never matched it, and neither did `shadow-2xs`, a
    // coloured `shadow-cyan-400/40`, or the `shadow-(--custom)` shorthand.
    const budget: Record<string, number> = {};
    for (const debt of V4_SHADOW_DEBT) budget[`${debt.path} ${debt.token}`] = debt.count;
    const offenders: string[] = [];
    for (const file of FILES) {
      for (const hit of shadowOffenders(file.segments)) {
        const key = `${file.path} ${hit.token}`;
        if ((budget[key] ?? 0) > 0) {
          budget[key] -= 1;
          continue;
        }
        offenders.push(`${file.path}: [${hit.token}] ${hit.segment}`);
      }
    }
    expect(
      offenders,
      `Tailwind's shadow scale is not part of this system. An overlay (popover, ` +
        `dropdown, dialog, palette, toast) uses \`nm-card-elevated\`; an in-page ` +
        `pane earns emphasis from position, spacing and heading weight.`,
    ).toEqual([]);
  });

  it('the Tailwind 4 shadow register is exact — no entry outlives its callsite', () => {
    const tally = liveShadowTally();
    const stale = V4_SHADOW_DEBT.filter(
      (debt) => (tally[`${debt.path} ${debt.token}`] ?? 0) !== debt.count,
    ).map(
      (debt) =>
        `${debt.path} ${debt.token}: registered ${debt.count}, live ` +
        `${tally[`${debt.path} ${debt.token}`] ?? 0}`,
    );
    expect(
      stale,
      'a registered shadow that no longer exists is an allowance nobody is ' +
        'watching — delete the entry with the class',
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

/**
 * The guard above is the production artefact of this file, so it gets a suite of
 * its own. Every cell here is a case the sweep must decide correctly; the fixtures
 * are real class lists lifted verbatim from the components named beside them.
 */
describe('the shadow guard is itself under test', () => {
  /**
   * The pattern the shadow cell used before Tailwind 4. Kept as a fixture so the
   * non-regression cell can prove the replacement is a SUPERSET rather than a
   * differently-shaped guard: three earlier narrowing attempts each closed the
   * stated hole and opened a new one.
   */
  const PRE_V4_PATTERN = /\b(drop-)?shadow(-(sm|md|lg|xl|2xl|inner))?(-\[|(?=["'\s]|$))/;

  const flagged = (text: string): string[] =>
    shadowOffenders(classSegments(text)).map((hit) => hit.token);

  // ThemeTab.tsx's theme swatch, verbatim. `p-1.5` is the trap: it carries a
  // `.`, so a token-shape test that forgets decimals reads the whole list as
  // prose and a bare `shadow` walks straight through the exemption.
  const THEME_SWATCH = 'flex w-12 shrink-0 flex-col gap-1 rounded-md p-1.5';
  // The sentence an adversarial reviewer used to trip the old cell.
  const PROSE = 'the shadow migration changed underneath it';
  /** Every shape the pre-v4 pattern caught, so "superset" can be checked, not asserted. */
  const CAUGHT_BEFORE = [
    'shadow',
    'shadow-sm',
    'shadow-md',
    'shadow-lg',
    'shadow-xl',
    'shadow-2xl',
    'shadow-inner',
    'drop-shadow',
    'drop-shadow-lg',
    'shadow-[0_0_8px_#22d3ee]',
    'shadow-[var(--nm-shadow-out-strong)]',
    'hover:shadow-lg',
  ];

  /**
   * An INDEPENDENT class-list oracle, written from a closed list of unambiguous
   * utility prefixes rather than from the token grammar under test.
   *
   * The tree-wide superset cell below used to pick its sample with `isClassList`
   * itself, and that is circular: a real class list the predicate refuses to
   * recognise is dropped from the sample, so the one failure mode a token-shape
   * rule actually has is the one the cell cannot see. Measured on this tree, the
   * circular version passed green while `Editor.tsx`'s nested-bracket variant
   * list — `[&_pre:not([data-title])]:p-4 [&_pre[data-title]]:px-4` — was being
   * read as PROSE, which exempted every shadow spelling in it, all twelve of
   * which the pre-v4 pattern caught.
   *
   * Two independently-recognised utilities is the bar: high enough that no
   * English sentence clears it, low enough that every class list does.
   */
  const ORACLE_BARE =
    /^(?:flex|grid|hidden|block|inline-flex|inline-block|absolute|relative|fixed|sticky|truncate|grow|italic|uppercase|underline)$/;
  const ORACLE_PREFIXED =
    /^(?:items|justify|gap|p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|w|h|min-w|max-w|text|bg|border|rounded|font|leading|tracking|opacity|z|overflow|cursor|transition|size|shrink|space-x|space-y|whitespace|select|pointer-events)-\S+$/;
  const looksLikeClassList = (segment: string): boolean =>
    segment.split(/\s+/).filter((token) => {
      const utility = token.slice(token.lastIndexOf(':') + 1);
      return ORACLE_BARE.test(utility) || ORACLE_PREFIXED.test(utility);
    }).length >= 2;

  it('flags a bare `shadow` added to a real class list that also contains `p-1.5`', () => {
    expect(flagged(`<div className="${THEME_SWATCH} shadow" />`)).toEqual(['shadow']);
  });

  it('treats `p-1.5` as Tailwind-shaped — the trap that killed three narrowings', () => {
    // Reject the decimal and the whole swatch reads as prose, which exempts the
    // bare `shadow` in the cell above. Delete the `(?:\.[a-z0-9]+)?` from
    // TOKEN_PART and this cell and that one both go red together.
    expect(isTailwindToken('p-1.5')).toBe(true);
    expect(isClassList(`${THEME_SWATCH} shadow`)).toBe(true);
  });

  it('reads prose as prose', () => {
    expect(flagged(`const note = '${PROSE}';`)).toEqual([]);
    // Non-vacuity: the pattern this replaced flagged that sentence as a utility.
    expect(PRE_V4_PATTERN.test(PROSE)).toBe(true);
  });

  it('reads prose as prose even when it is spelled with a real utility name', () => {
    // `border`, `grid`, `table`, `block` and `shadow` are all utilities AND
    // English words, so shape alone cannot separate them; function words can.
    expect(flagged(`const note = 'a shadow under every card';`)).toEqual([]);
    expect(isClassList('a shadow under every card')).toBe(false);
  });

  it('catches every form the pre-v4 pattern caught', () => {
    const missed = CAUGHT_BEFORE.filter(
      (form) => flagged(`<div className="${THEME_SWATCH} ${form}" />`).length === 0,
    );
    expect(missed, 'the replacement must be a superset of the pattern it replaces').toEqual([]);
  });

  it('recognises every class list the independent oracle can see', () => {
    // The premise the two superset cells rest on. A real class list read as
    // prose is exempt from every rule in this file, so this has to be measured
    // against something other than the predicate under test.
    //
    // The oracle's bar — two independently-recognised utilities — leaves a blind
    // region: 1157 of this tree's 4865 static `className` attributes are short
    // enough that the oracle cannot see them either, and a grammar misjudgement
    // inside one of them would be silent here. So the second half of this cell
    // drops the oracle entirely: a static `className="…"` attribute IS a class
    // list, by definition, whatever it contains. That sample needs no predicate
    // and no scanner, and it is what makes `ProseMirror`-style capitals and
    // fourth-level bracket nests loud instead of latent.
    const misjudged: string[] = [];
    let seen = 0;
    for (const file of FILES) {
      for (const segment of file.segments) {
        if (!looksLikeClassList(segment)) continue;
        seen += 1;
        if (!isClassList(segment)) misjudged.push(`${file.path}: ${segment.trim().slice(0, 90)}`);
      }
    }
    let attributes = 0;
    for (const file of FILES) {
      for (const attr of file.text.matchAll(/className="([^"]*)"/g)) {
        const value = attr[1]!.trim();
        if (value === '') continue;
        attributes += 1;
        if (!isClassList(value)) misjudged.push(`${file.path}: attr "${value.slice(0, 90)}"`);
      }
    }
    expect(seen, 'the oracle matched nothing — the sweep or the oracle is broken').toBeGreaterThan(2000);
    expect(attributes, 'no static className attributes found — the walk broke').toBeGreaterThan(4000);
    expect(
      misjudged.slice(0, 12),
      'these are class lists by any reading, and the token grammar calls them ' +
        'prose — every banned utility in them is exempt',
    ).toEqual([]);
  });

  it('is a superset of the pre-v4 pattern on every real class list in the tree', () => {
    // The fixture table above proves the shapes; this proves the SCOPE. Every
    // class list the sweep can see, mutated with every shape the old pattern
    // caught: wherever the old pattern fires, the new rule has to fire too.
    // A token-shape rule can only lose ground here — one token it refuses to
    // recognise turns a real class list into prose and exempts the lot — so the
    // check is run over the tree rather than over a handful of examples.
    //
    // The sample is the UNION of what the grammar accepts and what the oracle
    // recognises, never the grammar alone: selecting with `isClassList` hides
    // exactly the segments the grammar gets wrong.
    const missed: string[] = [];
    let checked = 0;
    for (const file of FILES) {
      for (const segment of file.segments) {
        if (!isClassList(segment) && !looksLikeClassList(segment)) continue;
        for (const form of CAUGHT_BEFORE) {
          const mutated = `${segment} ${form}`;
          if (!PRE_V4_PATTERN.test(mutated)) continue;
          checked += 1;
          if (shadowUtilities(mutated).length > 0 && isClassList(mutated)) continue;
          missed.push(`${file.path}: ${form} in "${segment.trim().slice(0, 70)}"`);
        }
      }
    }
    expect(checked, 'nothing was compared — the sweep or the mutation broke').toBeGreaterThan(10000);
    expect(missed.slice(0, 12), 'the new rule is weaker than the one it replaced').toEqual([]);
  });

  it('is a superset of the pre-v4 pattern across the whole shadow token grammar', () => {
    // The fixture tables enumerate the spellings someone thought of. This
    // enumerates the grammar: every prefix × scale × arbitrary value × alpha ×
    // variant combination, compared token by token against the pattern this
    // replaces. It is how `text-shadow-lg` and `inset-shadow-sm` were found —
    // both are live Tailwind 4 families (`--text-shadow-*` and
    // `--inset-shadow-*` are theme keys in tailwindcss 4.3), the pre-v4 pattern
    // caught both through its `\b`, and a `^(?:drop-)?shadow` rule silently did
    // not. Twenty-six token shapes, every one of them a real regression.
    const PREFIX = ['', 'drop-', 'text-', 'inset-'];
    const SCALE = [
      '',
      '-2xs',
      '-xs',
      '-sm',
      '-md',
      '-lg',
      '-xl',
      '-2xl',
      '-inner',
      '-[0_0_8px_#22d3ee]',
      '-[var(--nm-shadow-out-strong)]',
      // A colon INSIDE the arbitrary value. Stripping variants at the last
      // colon in the token — rather than at the last one outside brackets and
      // parens — throws the utility away and keeps the tail of the value, which
      // is not a shadow. The pre-v4 pattern caught this on `shadow-[`.
      '-[color:var(--nm-shadow-out-strong)]',
      '-[shadow:0_0_8px_#22d3ee]',
      '-(--shadow-glow)',
      '-cyan-400',
      '-black',
    ];
    const ALPHA = ['', '/40'];
    const VARIANT = ['', 'hover:', 'md:', 'group-hover:', 'dark:md:'];

    const missed: string[] = [];
    let compared = 0;
    for (const variant of VARIANT) {
      for (const prefix of PREFIX) {
        for (const scale of SCALE) {
          for (const alpha of ALPHA) {
            const token = `${variant}${prefix}shadow${scale}${alpha}`;
            const segment = `${THEME_SWATCH} ${token}`;
            if (!PRE_V4_PATTERN.test(segment)) continue;
            compared += 1;
            if (flagged(`<div className="${segment}" />`).length > 0) continue;
            missed.push(token);
          }
        }
      }
    }
    expect(compared, 'nothing was compared — the generator broke').toBeGreaterThan(100);
    expect(missed, 'the new rule is weaker than the one it replaces').toEqual([]);
  });

  it('catches the Tailwind 4 forms the pre-v4 pattern could not see', () => {
    const V4_FORMS = [
      'shadow-2xs',
      'shadow-xs',
      'drop-shadow-xs',
      'shadow-(--shadow-glow)',
      'shadow-cyan-400/40',
      'shadow-black/20',
      'md:shadow-xs',
      'group-hover:drop-shadow-xs',
    ];
    const missed = V4_FORMS.filter(
      (form) => flagged(`<div className="${THEME_SWATCH} ${form}" />`).length === 0,
    );
    expect(missed, 'this repo is on tailwindcss ^4.2.1 — these are live spellings').toEqual([]);
  });

  it('leaves the system shadow alone, in every spelling Tailwind 4 allows', () => {
    const SYSTEM = [
      'shadow-[var(--shadow-overlay)]',
      'shadow-[var(--shadow-overlay-sm)]',
      'shadow-(--shadow-overlay)',
      'shadow-overlay',
      'shadow-overlay-sm',
    ];
    const rejected = SYSTEM.filter(
      (form) => flagged(`<div className="${THEME_SWATCH} ${form}" />`).length > 0,
    );
    expect(rejected, '`--shadow-overlay` IS the system shadow — ADR-010 v0.6').toEqual([]);
  });

  it('sees every class list in the tree as its own segment', () => {
    // The scanner half. A prose exemption is only safe if a real class list is
    // never merged into a body that has prose in it: one merged body lets a
    // single prose sentence exempt every class list beside it. Before the
    // newline resync this cell reported 152 across 8 files.
    //
    // The sample has to come from the RAW FILE TEXT, and the version before this
    // one drew half of it from `className="…"` attributes alone. That is the one
    // shape the scanner cannot lose, so the cell was structurally incapable of
    // failing on the scanner's actual live failure mode: a class list inside a
    // `${…}` interpolation is not an attribute, so when `classSegments` was
    // discarding interpolations, 27 real class lists across 12 files vanished
    // from the segment stream and this cell stayed green with `invisible === 0`.
    // The oracle-filtered quoted literals below are drawn from the text with no
    // reference to `stringBodies` or `classSegments`, so a segment the scanner
    // never emits is still in the sample.
    const invisible: string[] = [];
    let checked = 0;
    for (const file of FILES) {
      const segments = new Set(file.segments);
      const candidates: string[] = [];
      for (const attr of file.text.matchAll(/className="([^"]*)"/g)) candidates.push(attr[1]!);
      for (const literal of file.text.matchAll(/(['"])([^'"\n\\]*)\1/g)) {
        if (looksLikeClassList(literal[2]!)) candidates.push(literal[2]!);
      }
      for (const candidate of candidates) {
        checked += 1;
        if (!segments.has(candidate)) invisible.push(`${file.path}: ${candidate.slice(0, 70)}`);
      }
    }
    expect(checked, 'the sample is empty — the enumeration broke').toBeGreaterThan(4000);
    expect(
      invisible.length,
      `${invisible.length} class lists are invisible to the sweep as their own ` +
        `segment, so a prose exemption beside them exempts them too:\n` +
        invisible.slice(0, 12).join('\n'),
    ).toBe(0);
  });

  it('an apostrophe in JSX copy does not swallow the class list under it', () => {
    // The desync, minimised. One apostrophe used to open a string that ran to
    // the next one — dozens of lines later — merging the copy and every class
    // list between them into a single body.
    const desync = [
      `      <p>Compendiq doesn't rotate cards under the cursor.</p>`,
      `      <div className="${THEME_SWATCH} shadow-xs" />`,
    ].join('\n');
    expect(classSegments(desync)).toContain(`${THEME_SWATCH} shadow-xs`);
    expect(flagged(desync)).toEqual(['shadow-xs']);
  });

  it('does not drop a body that is still open at end of file', () => {
    // Six files used to end inside an unclosed quote, and everything after the
    // quote that opened it — 75 class lists — was never handed to any rule. The
    // resync fixed the `'`/`"` case by construction; a template literal can
    // legally span lines, so the tail still has to be flushed explicitly.
    expect(flagged('const cls = `p-2 shadow-lg')).toEqual(['shadow-lg']);
  });

  it('judges the segment the match sits in, not the body it was merged into', () => {
    // Copy and a class list on the SAME line: the apostrophe opens a body that
    // runs to end of line, so the resync cannot separate them and the body holds
    // both. Judge the body and the JSX around the copy makes it prose, which
    // exempts the class list merged in beside it — the exact hole a prose
    // exemption opens if it is applied at body granularity.
    const merged = `<p>Compendiq doesn't tilt cards.</p> <div className="${THEME_SWATCH} shadow" />`;
    expect(classSegments(merged)).toContain(`${THEME_SWATCH} shadow`);
    expect(flagged(merged)).toEqual(['shadow']);
  });

  it('sees a class list that has an interpolation in the middle of it', () => {
    // The fixture is a single-quoted string on purpose: the `${…}` is the hole.
    expect(flagged('const cls = `p-2 ${size} shadow-lg`;')).toEqual(['shadow-lg']);
  });

  it('sees the class lists INSIDE an interpolation, not just the text around it', () => {
    // The dominant shape for a conditional class in this tree, and the hole that
    // made the first version of this rule strictly weaker than the pattern it
    // replaces: `${…}` was a split DELIMITER, so both branches of the ternary
    // were deleted before any rule ran. Verbatim from CustomRoleEditor.tsx, with
    // a shadow added to the active branch.
    const conditional = [
      '                className={`rounded-md px-3 py-1.5 text-sm transition-colors ${',
      "                  activeSection === 'edit'",
      "                    ? 'bg-action/15 text-action font-medium shadow-lg'",
      "                    : 'text-muted-foreground hover:bg-foreground/5'",
      '                }`}',
    ].join('\n');
    expect(classSegments(conditional)).toContain('bg-action/15 text-action font-medium shadow-lg');
    expect(flagged(conditional)).toEqual(['shadow-lg']);
  });

  it('cuts an interpolation at its own closing brace, not at the first one', () => {
    // `\$\{[^{}]*\}` stops at the first `}`, so an interpolation carrying an
    // object literal was mis-cut and its tail was left inline in the class-list
    // text — where it is neither a class list nor prose, and so exempt.
    const braced = "const cls = `p-2 ${cn({ 'shadow-lg': on })} rounded-md`;";
    expect(flagged(braced)).toEqual(['shadow-lg']);
  });

  it('reads an uppercase third-party class as a class, not as prose', () => {
    // tiptap renders into `.ProseMirror`, react-toastify into `.Toastify__toast`,
    // and both spellings share attributes with utilities. A lowercase-only bare
    // token made `"ProseMirror p-1.5 shadow-lg"` prose, which exempted the
    // shadow — the same hole as `p-1.5`, one case class further out.
    expect(isTailwindToken('ProseMirror')).toBe(true);
    expect(flagged(`<div className="ProseMirror ${THEME_SWATCH} shadow-lg" />`)).toEqual([
      'shadow-lg',
    ]);
    // And prose stays prose when it is capitalised, which is what `PROSE_WORD`'s
    // case-insensitivity buys: accepting capitals must only ever ADD class lists,
    // so a token that used to be prose BECAUSE capitals were rejected has to
    // still be prose now that they are accepted. `Every` is the whole fixture:
    // it is a function word and nothing else in the fragment is one.
    expect(isClassList('The shadow migration changed underneath it')).toBe(false);
    expect(isClassList('Every Shadow Removed')).toBe(false);
  });

  it('reads an arbitrary selector nested past three brackets as a class', () => {
    // The bracket sub-grammar used to be spelled out to a fixed depth, and a
    // legal fourth level fell off the end and made the whole list prose.
    const deep = '[&_pre:not([data-x[y[z]]])]:p-4';
    expect(isTailwindToken(deep)).toBe(true);
    expect(flagged(`<div className="${deep} p-1.5 shadow-lg" />`)).toEqual(['shadow-lg']);
    // Unbalanced brackets are still not a token shape — that is what keeps
    // `the shadow (see below)` prose.
    expect(isTailwindToken('(see')).toBe(false);
    expect(isClassList('a shadow (see below) under the card')).toBe(false);
  });

  it('catches the raw `box-shadow` property, which the pre-v4 pattern also caught', () => {
    // The pre-v4 pattern's `\b` accepted ANY hyphenated prefix, so an enumerated
    // family list was 532 token shapes short. `box-shadow` is not a Tailwind
    // utility — it is the CSS property ADR-010 bans by the same clause — and
    // dropping it would have been a regression against the rule this replaces.
    for (const form of ['box-shadow', 'ring-shadow-lg', 'inset-shadow-sm', 'text-shadow-lg']) {
      expect(PRE_V4_PATTERN.test(form), `${form} was caught before`).toBe(true);
      expect(flagged(`<div className="${THEME_SWATCH} ${form}" />`), form).toEqual([form]);
    }
  });

  it('flags an arbitrary shadow value nested past three brackets', () => {
    // The pre-v4 pattern caught `shadow-[` at any depth; a depth-limited
    // sub-grammar in the shadow pattern itself would have been the same
    // regression one layer down.
    const form = 'shadow-[0_0_8px_var(--x,rgb(0_0_0/[0.3]))]';
    expect(PRE_V4_PATTERN.test(form)).toBe(true);
    expect(flagged(`<div className="${THEME_SWATCH} ${form}" />`)).toEqual([form]);
  });
});
