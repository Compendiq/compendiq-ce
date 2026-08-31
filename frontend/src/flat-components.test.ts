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

/**
 * The same scan, RESYNCHRONISED at each newline and flushed at EOF — the scanner
 * the SECOND shadow cell's segmenter runs on, and the only consumer it has.
 *
 * A `'` or `"` literal cannot contain a raw newline, so a scanner that is still
 * "inside" one when it reaches end of line has DESYNCED — on an apostrophe in
 * JSX copy, almost always. `stringBodies` above carries that state forward, and
 * measured at this head by running the two side by side, that swallows 160 live
 * class lists across 7 files (ComplianceReportsTab, OidcSettingsPage,
 * ScimSettingsPage, DiagramMode, PagesPage, MermaidDiagram,
 * KeyboardShortcutsModal) into a body they do not own, and leaves six files
 * ending inside an unclosed quote, whose tails are dropped from the sweep
 * entirely.
 *
 * For the FIRST cell that is harmless in exactly the way its own comment claims:
 * a merged body costs at most a spurious finding, because that cell's single
 * exemption names a token nobody writes by accident. It is NOT harmless for a
 * rule that has to tell a class list from English — and the second cell has to,
 * or it flags prose — because a merged body lets one prose sentence exempt every
 * class list merged in beside it. So the second cell gets a scanner that resyncs
 * and a segmenter on top of it, and the first cell keeps its own scanner
 * untouched.
 *
 * The resync has one cost: a static `className="…"` attribute wrapped across
 * lines — legal JSX, and absent from this tree today — is cut at the newline,
 * and its closing `"` then reads as an OPENER, so the continuation lines never
 * become a segment from here. The alternative, carrying the quote across the
 * newline, is the swallow-the-file bug above, and a scanner cannot tell a
 * wrapped attribute from an apostrophe in copy. So the shape is recovered
 * OUTSIDE the scanner instead, by `attributeSegments`, which needs no scanner
 * state: a double-quoted attribute value cannot contain a `"`.
 */
function resyncedBodies(text: string): string[] {
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
 * class lists before any rule ran, and `resyncedBodies` never recovered them,
 * because a `'` inside a backtick body is plain content. Delete the recursive
 * descent below and 21 live class lists across 8 files go invisible that way, and
 * the pattern this rule replaces saw every one of them (as part of the merged
 * backtick body), so discarding made the guard strictly WEAKER than its
 * predecessor. An
 * interpolation is CODE: it is scanned as code, and the string literals inside
 * it are class lists in their own right.
 *
 * `'` is deliberately NOT a cut: it is legal inside a class list, in
 * `before:content-['']`, and cutting there splits a real attribute in half.
 * `"` IS a cut, because that is what puts a desynced body back into its parts —
 * but only outside a balanced `[…]` or `(…)` group. A `"` inside an arbitrary
 * value is content: `bg-[url("/x.png")]` and `shadow-[var(--x,"fallback")]` are
 * legal Tailwind 4, and cutting there split the list into `bg-[url(` and
 * `)] shadow-lg`. Neither half is a token shape — one opens on a closer — so
 * both read as prose and every shadow in the list was exempt, silently.
 *
 * An interpolation inside a balanced group is not a cut either, for the same
 * reason and with the same consequences. `` `w-[${w}px] p-1.5 shadow-lg` `` is
 * how this codebase — and every React codebase — spells a dynamic arbitrary
 * value, and cutting at the `${…}` split it into `w-[` and `px] p-1.5
 * shadow-lg`: one half opens a bracket it never closes, the other opens on a
 * closer, so neither is a token shape, both read as prose, and every shadow in
 * the list was exempt. The pattern this rule replaces caught all of them. So a
 * PROTECTED interpolation — one standing inside a balanced `[…]` or `(…)` — is
 * replaced by a placeholder that keeps the group balanced instead of ending the
 * segment; it is still descended into, because the code inside it may hold class
 * lists of its own. An interpolation OUTSIDE any group stays a cut: there
 * `` `p-2 ${size} shadow-lg` `` really is a class list with a hole in it.
 */
function classSegments(text: string): string[] {
  const out: string[] = [];
  collectSegments(text, out);
  // Plus the one shape the quote scanner cannot keep: see `attributeSegments`.
  out.push(...attributeSegments(text));
  // Plus, for a segment that is a FRAGMENT of a class list, its interior: see
  // `fragmentInterior`. Read off `out` after both producers have run, so a
  // recovered attribute value gets the same treatment as a scanned body.
  for (const segment of [...out]) {
    const interior = fragmentInterior(segment);
    if (interior !== null) out.push(interior);
  }
  return out;
}

/**
 * A protected interpolation reduced to one character, so the arbitrary value it
 * sits in still balances and the token it belongs to still has a shape. It is
 * deliberately NOT a legal `TOKEN_PART` character on its own: if a placeholder
 * ever escapes its group the token is rejected and the segment reads as prose,
 * which is exactly what the cut it replaces produced — so the substitution can
 * only ever add catches, never remove one.
 */
const INTERP_MARK = '\u0002';

function collectSegments(code: string, out: string[]): void {
  for (const body of resyncedBodies(code)) {
    const spans = interpolations(body);
    // Group structure is read off the body with the interpolations BLANKED, not
    // off the raw body: `${cn({ a: ']' })}` carries brackets of its own, and
    // counting those decides protection by the contents of the hole rather than
    // by the class list around it. The blank is index-aligned so the positions
    // still address `body`.
    const inGroup = groupInterior(blankSpans(body, spans));
    let held = '';
    let cut = 0;
    for (const { start, end } of spans) {
      if (inGroup[start]) {
        held += body.slice(cut, start) + INTERP_MARK;
      } else {
        pushChunks(held + body.slice(cut, start), out);
        held = '';
      }
      collectSegments(body.slice(start + 2, end - 1), out);
      cut = end;
    }
    pushChunks(held + body.slice(cut), out);
  }
}

/** `body` with every span replaced by the same NUMBER of placeholder characters. */
function blankSpans(body: string, spans: { start: number; end: number }[]): string {
  let out = '';
  let at = 0;
  for (const { start, end } of spans) {
    out += body.slice(at, start) + INTERP_MARK.repeat(end - start);
    at = end;
  }
  return out + body.slice(at);
}

/**
 * The positions of a chunk that sit inside a BALANCED `[…]` or `(…)` group.
 *
 * Balanced is the operative word: an unbalanced `[` — prose, or a bracket that
 * really does span the boundary — protects nothing, so a stray opener can never
 * swallow the rest of the chunk and merge unrelated class lists into one
 * segment. Openers are matched against the nearest opener of their OWN kind, so
 * `[a)b]` still masks as one group, the same rule `maskGroups` uses on a token.
 */
function groupInterior(chunk: string): boolean[] {
  const inside = new Array<boolean>(chunk.length).fill(false);
  const open: { close: string; at: number }[] = [];
  for (let i = 0; i < chunk.length; i += 1) {
    const c = chunk[i]!;
    if (c === '[' || c === '(') {
      open.push({ close: c === '[' ? ']' : ')', at: i });
      continue;
    }
    if (c !== ']' && c !== ')') continue;
    for (let k = open.length - 1; k >= 0; k -= 1) {
      if (open[k]!.close !== c) continue;
      for (let j = open[k]!.at; j <= i; j += 1) inside[j] = true;
      open.length = k;
      break;
    }
  }
  return inside;
}

function pushChunks(chunk: string, out: string[]): void {
  const inside = groupInterior(chunk);
  let start = 0;
  for (let i = 0; i < chunk.length; i += 1) {
    const c = chunk[i]!;
    if (c !== '\n' && c !== '"' && c !== '`') continue;
    if (inside[i]) continue;
    out.push(chunk.slice(start, i));
    start = i + 1;
  }
  out.push(chunk.slice(start));
}

/**
 * The value of every static `name="…"` attribute that spans more than one line.
 *
 * A JSX attribute value is not a JS string literal: it MAY carry a raw newline,
 * and `className="flex p-1.5\n  shadow-lg"` is legal, prettier-produced JSX.
 * `resyncedBodies` has to resync at every newline inside a `"` body — that is what
 * stops one apostrophe in JSX copy swallowing the rest of the file — so it cuts
 * such an attribute in half and reads its closing quote as an OPENER, losing the
 * continuation lines. The pattern this rule replaces carried the quote across
 * the newline and saw the whole value, so losing it is a regression.
 *
 * Recovering it needs no scanner state, because a double-quoted attribute value
 * cannot contain a `"`: the value is whatever stands between the `="` and the
 * next `"`. This is deliberately ADDITIVE — an extra segment beside the ones
 * `classSegments` produces, restricted to the multi-line shape that is the only
 * one the resync loses. A spurious match (an `=` inside a string, say) can only
 * ADD a segment, and an added segment is judged on its own like every other, so
 * the worst case is a finding to look at rather than one to miss.
 */
function attributeSegments(text: string): string[] {
  const out: string[] = [];
  for (const attr of text.matchAll(/[A-Za-z_$][\w$]*\s*=\s*"([^"]*)"/g)) {
    if (attr[1]!.includes('\n')) out.push(attr[1]!);
  }
  return out;
}

/**
 * A segment stripped of the two edge tokens that a CUT through the middle of a
 * class list leaves behind — or `null` when it has neither.
 *
 * A class list can be assembled by string surgery straight through an arbitrary
 * value, and then no scanner sees it whole. Both halves of
 * `` `w-[${'8px] shadow-lg bg-['}] p-1.5` `` are real: at runtime that renders
 * `w-[8px] shadow-lg bg-[] p-1.5`, a class list carrying a live `shadow-lg`. The
 * inner literal reaches the grammar as `8px] shadow-lg bg-[`, whose first token
 * OPENS on a closer and whose last token never closes its opener, so
 * `maskGroups` rejects both, one rejected token makes the segment prose, and
 * every shadow in it was exempt. `const a = 'grid-cols-['; const b = '1fr]
 * shadow-lg';` is the same shape with no interpolation anywhere, so this is a
 * property of cutting rather than of `INTERP_MARK`. The pattern this rule
 * replaces caught both, which made them the last two shapes on which this rule
 * was weaker than its predecessor.
 *
 * Only the FIRST and LAST tokens are dropped, and only when the brackets in
 * them do not balance: those are exactly the tokens a cut can bisect, and an
 * interior token is whole by construction. Trimming cannot manufacture a class
 * list out of prose, because prose is rejected by `PROSE_WORD` on the function
 * words in its MIDDLE, which trimming never touches — `the shadow (see below)
 * under the card` keeps `shadow`, `under` and `the` and stays prose.
 *
 * Like `attributeSegments` this is ADDITIVE: the interior is an extra segment
 * beside the untrimmed one, never a replacement, so no existing verdict moves
 * and the worst case is a finding to look at rather than one to miss. Measured
 * over this tree it adds 63 segments to 20137 (0.3%), two of which read as class
 * lists (`current` and `proposed`, single tokens from an apostrophe desync) and
 * neither carries a shadow — so the recovery is free here and the tree's offender
 * set is unchanged at the six registered `shadow-xs` call sites.
 */
function fragmentInterior(segment: string): string | null {
  const tokens = segment.split(/\s+/).filter((t) => t !== '');
  let lo = 0;
  let hi = tokens.length;
  if (hi > 1 && maskGroups(tokens[0]!) === null) lo += 1;
  if (hi > 1 && maskGroups(tokens[hi - 1]!) === null) hi -= 1;
  if (lo === 0 && hi === tokens.length) return null;
  if (hi <= lo) return null;
  return tokens.slice(lo, hi).join(' ');
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

/**
 * The `!` important marker may open ANY part of a token, not just the whole
 * token. Tailwind 3 spelled it after the variants and before the utility —
 * `hover:!shadow-md`, `sm:!-mt-1` — and tailwindcss 4.3 still compiles that
 * form alongside v4's own trailing `hover:shadow-md!`. A grammar that allowed
 * `!` only at the token edges rejected the post-variant spelling, and a
 * rejected token makes its whole class list prose: one `hover:!bg-card`
 * anywhere in an attribute exempted every shadow standing beside it, and the
 * shadow token itself (`hover:!shadow-md`) was never recognised either. The
 * pattern this rule replaces caught all of them through its `\b`.
 */
const TOKEN_PART = String.raw`(?:!?-{0,2}(?:[A-Za-z0-9_]+(?:\.[a-z0-9]+)?|\*{1,2}|${GROUP_MARK}))`;
const TAILWIND_TOKEN = new RegExp(`^!?@?${TOKEN_PART}(?:[-:/]{1,2}${TOKEN_PART})*!?$`);

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
 * as well — BulkActionBar, LibraryFilterDropdown and TrashPage use that
 * spelling, and the three overlays that are not `nm-card-elevated` use the
 * arbitrary-value form (AiDockSheet and CommentsSidebar are drawers,
 * TableOfContents a round floating button). Allowed by name, per token:
 * allowing a whole BODY because one legitimate overlay shadow appears in it,
 * which is what this cell used to do, exempts every other shadow standing next
 * to it.
 *
 * `--shadow-overlay-sm` is allowed with it in the two spellings the pattern this
 * rule replaces never matched — `shadow-overlay-sm` and
 * `shadow-(--shadow-overlay-sm)`, both of which that pattern's
 * `(-\[|(?=["'\s]|$))` tail rejects outright. It is the same `@theme` block's
 * shallow sibling (index.css, under "The one shadow family in the system"),
 * documented there as the Library search surface's exception, so a call site
 * spelling it is using the system shadow rather than reaching past it.
 *
 * `shadow-[var(--shadow-overlay-sm)]` is NOT allowed, and the asymmetry is
 * deliberate: the pattern this replaces DID catch that spelling — its allowance
 * named `--shadow-overlay` only, and `shadow-[` matches — so exempting it would
 * be the one case in this file where the new rule is weaker than the old one,
 * and "weaker on any case" is what the three earlier attempts died of. Nothing
 * in the tree spells `--shadow-overlay-sm` at all (`grep -rn 'shadow-overlay-sm'
 * frontend/src --include=*.tsx` is empty), so the narrow reading costs nothing
 * today and the `@theme`-backed spellings above stay available.
 */
const SYSTEM_SHADOW =
  /^shadow-(?:overlay(?:-sm)?|\[var\(--shadow-overlay\)\]|\(--shadow-overlay(?:-sm)?\))$/;

/**
 * The shadow spellings that can stand in an English sentence: the family prefix
 * and nothing after it. `shadow` is a word, and `box-shadow` / `text-shadow` are
 * CSS property names, so a string that documents one — `'transition: box-shadow
 * 200ms'` — is prose rather than a call site.
 *
 * Every other spelling `SHADOW_UTILITY` matches carries a scale, an arbitrary
 * value, a custom property, a palette shade or an alpha, and no sentence spells
 * any of those. Gating them on the prose verdict was a hole in exactly the
 * capability this rule ADDS: one `PROSE_WORD` token beside a v4-only spelling —
 * `` `tag ${x} none shadow-xs` `` — made the segment prose, and since the pre-v4
 * pattern cannot see `shadow-xs` at all, the token escaped BOTH assertions.
 * Measured on this tree, 5274 segments are judged prose and NONE of them carries
 * any shadow token, so deciding the suffixed forms without the gate costs
 * nothing today and closes that hole by construction.
 *
 * The bare forms lose nothing by staying gated: assertion 1 has no prose
 * exemption at all, and its leading `\b` catches every one of them in every body
 * it sweeps.
 */
const BARE_SHADOW = new RegExp(`^${SHADOW_FAMILY}shadow$`);

/**
 * The utility a token names, with its variants removed.
 *
 * The split has to happen at the last colon that is OUTSIDE brackets and
 * parentheses. A colon is legal inside an arbitrary value — `shadow-[color:…]`,
 * `shadow-[shadow:…]`, and v4's `shadow-(color:--x)` shorthand — and cutting at
 * the last colon in the whole token throws the utility away and keeps the tail
 * of the value, which is not a shadow by any pattern. The pre-v4 rule caught
 * those on `shadow-[`, so cutting naively is a hole rather than a cosmetic
 * detail.
 *
 * "Outside" is decided by `groupInterior` — the same OWN-KIND scan `maskGroups`
 * and `collectSegments` use — and never by one undifferentiated depth counter.
 * A counter that increments on `[` and `(` alike and decrements on `]` and `)`
 * alike goes NEGATIVE on the mismatched closer that is legal inside an
 * arbitrary value: `[&[data-x=")"]]:shadow-lg` is a legal Tailwind 4 variant,
 * the stray `)` drove the depth below zero, so no colon was ever seen at depth
 * 0, no variant was stripped, and the anchored shadow pattern never saw a
 * shadow. `isClassList` — which already used the own-kind scan — called that
 * segment a class list, so no exemption was involved and no prose tradeoff:
 * the token was simply not recognised, and the pattern this rule replaces
 * caught it through its `\b`. Three functions reading the same brackets three
 * different ways is the whole shape of that bug.
 */
function utilityOf(token: string): string {
  const inside = groupInterior(token);
  let cut = -1;
  for (let i = 0; i < token.length; i += 1) {
    if (token[i] === ':' && !inside[i]) cut = i;
  }
  return token.slice(cut + 1);
}

function shadowUtilities(segment: string): string[] {
  const out: string[] = [];
  for (const raw of segment.split(/\s+/)) {
    if (raw === '') continue;
    const token = raw.replace(/!+$/, '');
    // Variants decide WHEN a utility paints, never whether it is a shadow. The
    // `!` marker is stripped AFTER them, because Tailwind 3 spelled it between
    // the two — `hover:!shadow-md` — so stripping only at the token edges left
    // a leading `!` on the utility and no shadow pattern matched it.
    const utility = utilityOf(token).replace(/^!+/, '');
    if (!SHADOW_UTILITY.test(utility) || SYSTEM_SHADOW.test(utility)) continue;
    out.push(utility);
  }
  return out;
}

/**
 * Every banned shadow in every segment, with the segment quoted for the failure
 * message.
 *
 * The prose verdict gates the AMBIGUOUS spellings only — see `BARE_SHADOW`. It
 * used to gate the whole segment, and that made the exemption cover the one
 * thing this rule exists to add: `shadow-xs` beside a single English word was
 * exempt here and invisible to assertion 1, so it escaped the guard entirely.
 *
 * The `.slice(0, 100)` is DISPLAY only, and the allowance is decided per token
 * above it. Judging an allowance on the shortened string is a live bug this
 * file shipped for one commit: a legitimate `shadow-[var(--shadow-overlay)]`
 * sitting past column 100 of a long class list got cut off, the allowance
 * stopped matching, and the guard failed on the exact call sites it was
 * written to permit.
 */
function shadowOffenders(segments: string[]): { token: string; segment: string }[] {
  const out: { token: string; segment: string }[] = [];
  for (const segment of segments) {
    const classList = isClassList(segment);
    for (const token of shadowUtilities(segment)) {
      if (!classList && BARE_SHADOW.test(token)) continue;
      out.push({ token, segment: segment.replace(/\s+/g, ' ').trim().slice(0, 100) });
    }
  }
  return out;
}

const FILES = sources(SRC).map((f) => {
  const stripped = stripComments(readFileSync(f, 'utf8'));
  return {
    path: relative(SRC, f),
    text: stripped,
    strings: stringBodies(stripped),
    segments: classSegments(stripped),
  };
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
 * The rule this file carried before Tailwind 4, VERBATIM: the pattern and the
 * allowance from `origin/dev`, hoisted out of the cell below only so the guard's
 * own suite can compare against the same object rather than against a copy of it
 * that can drift.
 *
 * It stays, unchanged and unconditional, as the first of two shadow assertions.
 * Three attempts to REPLACE it with a token-shape rule each closed the hole the
 * issue named and opened a new one somewhere else, because a hand-narrowed
 * replacement regex is not provably at least as strong as the incumbent. Two
 * assertions cannot have that failure mode: the guard's catch set is the UNION of
 * the two, which is a superset of this rule's by construction.
 */
const PRE_V4_PATTERN = /\b(drop-)?shadow(-(sm|md|lg|xl|2xl|inner))?(-\[|(?=["'\s]|$))/;
const preV4Allowance = (body: string): boolean =>
  /\bshadow-\[var\(--shadow-overlay\)\]/.test(body);

/**
 * Dev's rule, EVALUATED over the files handed in — pattern, allowance and
 * scanner together. Assertion 1's cell is one call to this, and the self-test
 * below calls the same function over planted fixtures, so the union property has
 * an executable pin instead of a pinned constant.
 *
 * Pinning the pattern LITERAL, which is all the previous version did, pins a
 * `const` and not the thing that reads the tree. Five ways of quietly degrading
 * assertion 1 left the suite green at 42/42 — narrowing the pattern AT THE CALL
 * SITE, widening the allowance by eight characters, lending it assertion 2's
 * prose exemption, skipping files assertion 2 already reported, and deleting the
 * loop — and the third of those silenced an offender dev's rule catches, making
 * the union strictly weaker than dev with nothing red anywhere.
 *
 * The parameter is `{ path, strings }` and nothing else on purpose, and the
 * self-test's fixture carries exactly those two fields: a degradation that wants
 * another field of `FILES` — the segments, to defer to assertion 2 — throws on
 * the fixture and reds there. (`frontend/tsconfig.json` excludes `*.test.ts`, so
 * the narrow type is documentation and the fixture is the enforcement; that
 * asymmetry was checked, not assumed — the mutation typechecks clean and reds
 * under vitest.)
 */
function preV4Offenders(files: readonly { path: string; strings: string[] }[]): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    for (const hit of callsites(file, PRE_V4_PATTERN, preV4Allowance)) {
      offenders.push(`${file.path}: ${hit}`);
    }
  }
  return offenders;
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
    // ASSERTION 1 OF 2, and it is `origin/dev`'s rule unchanged. See
    // `PRE_V4_PATTERN`: this cell is deliberately NOT narrowed, scoped or
    // rewritten, because the guard's total catch set has to be a superset of it
    // and the cheapest way to guarantee that is to keep running it.
    //
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
    // `shadow-[var(--shadow-overlay)]` is the system shadow spelled as an
    // arbitrary value, for the overlays that are not `nm-card-elevated`
    // (two drawers, a round floating button). Allowed by name.
    //
    // The body is one call on purpose: `preV4Offenders` is the whole pipeline,
    // the self-test pins its verdict on planted fixtures, and there is nothing
    // left in here that can be narrowed, scoped or short-circuited without the
    // deletion being visible in the diff.
    expect(
      preV4Offenders(FILES),
      `Tailwind's shadow scale is not part of this system. An overlay (popover, ` +
        `dropdown, dialog, palette, toast) uses \`nm-card-elevated\`; an in-page ` +
        `pane earns emphasis from position, spacing and heading weight.`,
    ).toEqual([]);
  });

  it('no Tailwind 4 shadow spelling survives either — by token shape, per segment', () => {
    // ASSERTION 2 OF 2, and it only ever ADDS offenders: the cell above keeps
    // running whatever this one decides, so nothing here can exempt anything
    // there. That is the whole design. It is why this rule is allowed to reason
    // about prose at all — a rule that EXEMPTS is a rule that can be talked out
    // of a finding, and three earlier attempts to make the single old cell
    // exempt-and-extend each shipped a new hole doing it.
    //
    // What it adds: the rule above is a v3 pattern on a v4 repo. `shadow-xs` —
    // which is what Tailwind 4 renamed `shadow-sm` TO, so it is the spelling the
    // upgrade itself produced — never matched it, and neither did `shadow-2xs`,
    // a coloured `shadow-` utility on `cyan-400/40`, the `shadow-(--custom)`
    // variable shorthand, or `shadow-overlay-sm`. This cell reads every token
    // of every class-list SEGMENT (never the whole body: see `classSegments`)
    // and decides per token, so a legitimate overlay shadow no longer exempts
    // the shadows standing beside it either.
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
      `Tailwind's shadow scale is not part of this system, in v4's spellings as ` +
        `much as v3's. An overlay (popover, dropdown, dialog, palette, toast) ` +
        `uses \`nm-card-elevated\`; an in-page pane earns emphasis from position, ` +
        `spacing and heading weight.`,
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
    // set of near-invisible status states — a `text-` utility on `emerald-300`
    // over a `bg-` utility on `emerald-500/10` measured 1.52:1 on Paper's white
    // card, and that was the *success* state of the sync panel. `amber-100` ink
    // measured 1.11:1.
    //
    // The same markup on tokens measures 4.75–6.31:1 in Paper and 5.57–8.69:1
    // in Graphite, computed over `bg-<role>/10` on the card.
    //
    // Prefix and shade are written apart throughout this comment, the way the
    // role is elided in `bg-<role>/10` just above. Tailwind 4 scans comments
    // for class candidates, so a whole utility spelled here compiles a rule —
    // and its `--color-*` theme variable — into the shipped stylesheet, which
    // is the very debt this cell exists to keep out of the tree. A bare shade
    // matches nothing: Tailwind registers no utility under a colour name on
    // its own.
    //
    // Two things the sweep had to preserve that a colour name alone does not
    // carry, and which are the reason this is a guard and not just a rename:
    //   - the SHADE encoded tint-vs-solid. On a `bg-` utility, `yellow-50` is a
    //     pale panel fill and `yellow-500` is a solid one; collapsing both to
    //     `bg-warning` turned three tinted badges into full-strength fills, one
    //     of which ended up painting `text-destructive` on `bg-destructive`.
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
   * The pre-v4 shadow cell's whole verdict on a source snippet — the SHIPPED
   * one, first cell included: its pattern, its allowance and its scanner, all
   * three read straight off the module above rather than copied here.
   *
   * The cells below compare the second cell against this pipeline, and a copy of
   * it would only prove the second cell is a superset of a fixture that has
   * drifted. It cannot drift now: the first assertion calls the same three names.
   */
  const preV4Catches = (source: string): boolean =>
    stringBodies(stripComments(source)).some(
      (body) => PRE_V4_PATTERN.test(body) && !preV4Allowance(body),
    );

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

  it("the first assertion is still dev's rule, spelled the way dev spells it", () => {
    // The guard is the UNION of two assertions, and the union is a superset of
    // dev's catch set only while the first assertion IS dev's rule. Hoisting the
    // literal into a const (so this suite compares against the same object
    // instead of a copy) is the one liberty taken with it, so the literal is
    // pinned here: change it and this cell reds with the diff in the message.
    expect(PRE_V4_PATTERN.source).toBe(
      String.raw`\b(drop-)?shadow(-(sm|md|lg|xl|2xl|inner))?(-\[|(?=["'\s]|$))`,
    );
    expect(PRE_V4_PATTERN.flags).toBe('');
    expect(preV4Allowance('flex shadow-[var(--shadow-overlay)] p-2')).toBe(true);
    expect(preV4Allowance('flex shadow-lg p-2')).toBe(false);
    // The allowance had no falsifying probe on the side that matters. Widening it
    // by eight characters — `--shadow-overlay(?:-sm)?` — left the whole suite
    // green while exempting a body dev's rule flags, i.e. while making the union
    // strictly weaker than dev. The second probe closes the wider widening, to
    // any `shadow-[var(…)]`, which would have exempted the retired
    // `--nm-shadow-out-strong` token this cell's own history calls the worst
    // thing the guard ever let through.
    expect(preV4Allowance('flex shadow-[var(--shadow-overlay-sm)] p-2')).toBe(false);
    expect(preV4Allowance('flex shadow-[var(--nm-shadow-out-strong)] p-2')).toBe(false);
  });

  it("the first assertion EVALUATES dev's rule, not just a copy of its literal", () => {
    // The cell above pins a `const`; this one pins the pipeline that reads the
    // tree, which is a different thing and the one the union rests on. Without
    // it, five degradations of assertion 1 passed 42/42: narrowing the pattern at
    // the CALL SITE, widening the allowance, lending assertion 1 assertion 2's
    // prose exemption, skipping files assertion 2 reported, and deleting the loop
    // outright — and the prose-exemption one silenced `'transition: box-shadow
    // 200ms'`, an offender the shipped guard catches.
    //
    // The fixtures are chosen so the expectation dies in every direction: narrow
    // the pattern and `p-1.5 shadow-lg` drops out, give assertion 1 a prose
    // exemption and the CSS-property body and `PROSE` drop out, widen the
    // allowance and the `--shadow-overlay-sm` body drops out, delete the loop and
    // all four do. The fourth body pins that dev's real allowance still fires.
    const planted = [
      {
        path: 'x.tsx',
        strings: stringBodies(
          "const a = 'transition: box-shadow 200ms';\n" +
            "const b = 'p-1.5 shadow-lg';\n" +
            `const c = '${PROSE}';\n` +
            "const d = 'flex shadow-[var(--shadow-overlay)] p-2';\n" +
            "const e = 'flex shadow-[var(--shadow-overlay-sm)] p-2';",
        ),
      },
    ];
    expect(planted[0]!.strings).toHaveLength(5);
    expect(preV4Offenders(planted)).toEqual([
      'x.tsx: transition: box-shadow 200ms',
      'x.tsx: p-1.5 shadow-lg',
      `x.tsx: ${PROSE}`,
      'x.tsx: flex shadow-[var(--shadow-overlay-sm)] p-2',
    ]);
    // No tree call here: the shipped cell is the tree call, and repeating it
    // would only make one real offender red two cells while adding no mutation
    // coverage — `preV4Offenders(FILES.filter(…))` is empty either way.
  });

  it('the two assertions read the tree through their own scanners', () => {
    // `stringBodies` is dev's scanner, byte for byte: no newline resync, no EOF
    // flush, so one apostrophe swallows everything after it. That is harmless
    // for a rule with no prose exemption and fatal for one with, which is why
    // the second assertion gets `resyncedBodies` and the first keeps this.
    // Give the first assertion the resynced scanner and it stops being dev's
    // rule; give the second assertion this one and its exemption becomes unsafe.
    const fixture = `<p>doesn't tilt</p>\n<div className="p-1.5 shadow" />`;
    expect(stringBodies(fixture)).toEqual([]);
    expect(resyncedBodies(fixture)).toEqual(["t tilt</p>", 'p-1.5 shadow']);
    // And the first assertion is not decoration: it fires on a planted shadow,
    // and the bodies it sweeps are the tree's.
    const planted = { strings: stringBodies('const cls = "p-1.5 shadow-lg";') };
    expect(callsites(planted, PRE_V4_PATTERN, preV4Allowance)).toEqual(['p-1.5 shadow-lg']);
    expect(FILES.reduce((n, f) => n + f.strings.length, 0)).toBeGreaterThan(10000);
    // Body for body and file for file, what `FILES` hands the first assertion is
    // what dev's scanner produces. Wire `strings` to `resyncedBodies` — strictly
    // the better scanner, and still not the one dev's rule is — and this reds.
    const flat = (perFile: string[][]): string =>
      perFile.map((bodies) => bodies.join('\u0000')).join('\u0001');
    expect(flat(FILES.map((f) => f.strings))).toBe(flat(FILES.map((f) => stringBodies(f.text))));
    expect(flat(FILES.map((f) => f.segments))).toBe(flat(FILES.map((f) => classSegments(f.text))));
  });

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

  it('flags a Tailwind 4 shadow even where the segment reads as prose', () => {
    // The hole the prose exemption opened in the capability this rule ADDS, and
    // the shape the orchestrator warned about: closed the stated hole, opened a
    // new one. `none` is a `PROSE_WORD`, so the segment is not a class list and
    // the exemption used to skip the whole thing before any shadow was looked
    // at; the pre-v4 pattern cannot see `shadow-xs` at all, so assertion 1 was
    // silent too and the token escaped the entire guard.
    expect(isClassList('tag none shadow-xs')).toBe(false);
    expect(PRE_V4_PATTERN.test('tag none shadow-xs')).toBe(false);
    expect(flagged('const CLS = "tag none shadow-xs";')).toEqual(['shadow-xs']);
    expect(flagged('const CLS = `tag ${x} none shadow-xs`;')).toEqual(['shadow-xs']);
    // Every v4-only spelling, in a segment one English word makes prose.
    const ungated = ['shadow-2xs', 'shadow-(--shadow-glow)', 'shadow-cyan-400/40', 'shadow-primary'];
    expect(ungated.filter((form) => flagged(`const CLS = 'tag none ${form}';`).length === 0)).toEqual(
      [],
    );
    // The bare word stays gated, and that costs the union nothing: assertion 1
    // has no prose exemption, so it catches the bare forms in every body.
    expect(BARE_SHADOW.test('shadow')).toBe(true);
    expect(BARE_SHADOW.test('box-shadow')).toBe(true);
    expect(BARE_SHADOW.test('shadow-xs')).toBe(false);
    expect(flagged(`const note = '${PROSE}';`)).toEqual([]);
    expect(preV4Catches(`const note = '${PROSE}';`)).toBe(true);
    expect(preV4Catches(`const note = 'transition: box-shadow 200ms';`)).toBe(true);
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
    // region: 1156 of this tree's 4864 static `className` attributes are short
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

  /**
   * The class lists of a file drawn from its RAW TEXT: every static
   * `className="…"` attribute and every `` className={`…`} `` template body.
   *
   * Selecting the superset sample from `file.segments` is the same circularity
   * the oracle above fixes one layer up, just one layer down: `file.segments`
   * is the output of the scanner under test, so a class list the scanner SPLITS
   * or drops is never in the sample, and the `isClassList || looksLikeClassList`
   * filter then removes the grammar-rejected ones as well. Two shapes that made
   * this rule weaker than the pattern it replaces lived in exactly that blind
   * spot — a `"` inside an arbitrary value, cut into unbalanced halves, and a
   * `!` important marker after a variant, which the grammar rejected and so
   * turned its whole list into prose — and every tree-derived cell stayed green
   * with a live `shadow-lg` planted beside either of them.
   */
  const rawClassLists = (file: { text: string }): string[] => {
    const out: string[] = [];
    for (const attr of file.text.matchAll(/className="([^"]*)"/g)) out.push(attr[1]!);
    for (const attr of file.text.matchAll(/className=\{`([^`]*)`\}/g)) out.push(attr[1]!);
    return out.filter((value) => value.trim() !== '');
  };

  /**
   * A class list put back into source form, so the SHIPPED scanner runs on it.
   * A backtick body rather than a `"` attribute, because the shapes this guard
   * gets wrong are the ones carrying a `"` — which cannot be written inside a
   * double-quoted attribute at all, and so would be untestable in that form.
   */
  const asSource = (classList: string): string => `const cls = \`${classList}\`;`;

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

  it('is a superset of the pre-v4 pattern on every class list in the raw source text', () => {
    // The same comparison, on a sample the scanner cannot edit. The cell above
    // asks "of the segments the scanner produced, is any weaker than before?";
    // this one asks the question the scanner cannot dodge — for every class
    // list that is written in the tree, does the SHIPPED pipeline still fire
    // where the pattern this replaces fired? A class list the scanner splits or
    // loses fails here and cannot fail above.
    const missed: string[] = [];
    let checked = 0;
    for (const file of FILES) {
      for (const classList of rawClassLists(file)) {
        for (const form of CAUGHT_BEFORE) {
          const mutated = `${classList} ${form}`;
          if (!PRE_V4_PATTERN.test(mutated)) continue;
          checked += 1;
          if (flagged(asSource(mutated)).length > 0) continue;
          missed.push(`${file.path}: ${form} in "${classList.replace(/\s+/g, ' ').trim().slice(0, 70)}"`);
        }
      }
    }
    expect(checked, 'nothing was compared — the attribute enumeration broke').toBeGreaterThan(10000);
    expect(
      missed.slice(0, 12),
      'the new rule is weaker than the one it replaced on a class list that is ' +
        'written in this tree — the scanner lost it or the grammar refused it',
    ).toEqual([]);
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
      // A `"` inside the arbitrary value. Legal CSS — a custom-property
      // fallback is a string — and the shape that showed the segment cut was
      // wrong: cutting a body at every `"` split the class list into two
      // unbalanced halves, both of which read as prose.
      '-[var(--x,"fallback")]',
      '-(--shadow-glow)',
      '-cyan-400',
      '-black',
    ];
    const ALPHA = ['', '/40'];
    // `!` is Tailwind 3's important marker, still compiled by Tailwind 4.3
    // alongside v4's own trailing `!`. It may open the whole token or sit
    // between the variants and the utility, and the second position is the one
    // a grammar written for the first silently rejects — which made the token
    // unrecognisable, its whole class list prose, and every shadow in that list
    // exempt.
    // The last variant carries a mismatched closer inside its arbitrary
    // selector — legal, and the shape that separates `utilityOf`'s own-kind scan
    // from one undifferentiated depth counter. The counter goes NEGATIVE on that
    // `)`, so a colon INSIDE the arbitrary value that follows reads as being at
    // depth 0: the cut lands there, the utility is thrown away, and the tail
    // (`0_0_8px_#22d3ee]`) is not a shadow by any pattern. The pre-v4 pattern
    // caught every one of these through its `\b`.
    const VARIANT = [
      '',
      'hover:',
      'md:',
      'group-hover:',
      'dark:md:',
      '!',
      'hover:!',
      'dark:md:!',
      '[&[data-x=")"]]:',
    ];

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
            if (flagged(asSource(segment)).length > 0) continue;
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
      // The same shorthand with a TYPE hint, which is where v4 puts a colon
      // outside an arbitrary value. `utilityOf` has to treat that colon as
      // content: count only `[…]` for the variant split and the cut lands
      // inside the parens, throwing the utility away and keeping `--x)`, which
      // is not a shadow by any pattern. The pre-v4 pattern could not see this
      // spelling at all, so it is a v4 form rather than a superset case.
      'shadow-(color:--shadow-glow)',
      'shadow-cyan-400/40',
      'shadow-black/20',
      // A theme shadow by ROLE rather than by palette shade. `--shadow-primary`
      // is a legal `@theme` key, so this is a live spelling; collapse
      // `SHADOW_ROLE` to its palette-ish head and it stops being recognised.
      'shadow-primary',
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
      'shadow-(--shadow-overlay)',
      'shadow-(--shadow-overlay-sm)',
      'shadow-overlay',
      'shadow-overlay-sm',
    ];
    const rejected = SYSTEM.filter(
      (form) => flagged(`<div className="${THEME_SWATCH} ${form}" />`).length > 0,
    );
    expect(rejected, '`--shadow-overlay` IS the system shadow — ADR-010 v0.6').toEqual([]);
    // And the one spelling the allowance deliberately does NOT cover, because the
    // pattern this rule replaces caught it: its allowance named `--shadow-overlay`
    // alone, and `shadow-[` matches. Exempting it would make this rule weaker
    // than the one it replaces on exactly one token, which is the failure the
    // revert clause exists for. Nothing in the tree spells it.
    const shallowArbitrary = 'shadow-[var(--shadow-overlay-sm)]';
    expect(PRE_V4_PATTERN.test(shallowArbitrary)).toBe(true);
    expect(flagged(`<div className="${THEME_SWATCH} ${shallowArbitrary}" />`)).toEqual([
      shallowArbitrary,
    ]);
  });

  it('sees every class list in the tree as its own segment', () => {
    // The scanner half. A prose exemption is only safe if a real class list is
    // never merged into a body that has prose in it: one merged body lets a
    // single prose sentence exempt every class list beside it. Delete the newline
    // resync in `resyncedBodies` and this cell reports 160 across 7 files.
    //
    // The sample has to come from the RAW FILE TEXT, and the version before this
    // one drew half of it from `className="…"` attributes alone. That is the one
    // shape the scanner cannot lose, so the cell was structurally incapable of
    // failing on the scanner's actual live failure mode: a class list inside a
    // `${…}` interpolation is not an attribute, so when `classSegments` was
    // discarding interpolations, 21 real class lists across 8 files vanished
    // from the segment stream and this cell stayed green with `invisible === 0`.
    // The oracle-filtered quoted literals below are drawn from the text with no
    // reference to `resyncedBodies` or `classSegments`, so a segment the scanner
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
        if (segments.has(candidate)) continue;
        // The shadows standing in the lost class list, named in the message. An
        // invisible segment is only a problem because of what it hides, and the
        // operator reading a failure here needs to know whether a banned utility
        // went with it or the sweep merely lost a harmless list.
        const hiding = shadowUtilities(candidate);
        invisible.push(
          `${file.path}: ${candidate.replace(/\s+/g, ' ').slice(0, 70)}` +
            (hiding.length > 0 ? `  <-- HIDES ${hiding.join(' ')}` : ''),
        );
      }
    }
    expect(checked, 'the sample is empty — the enumeration broke').toBeGreaterThan(4000);
    expect(
      invisible.length,
      `${invisible.length} class lists are invisible to the sweep as their own ` +
        `segment, so a prose exemption beside them exempts them too.\n` +
        `\`resyncedBodies\` resyncs at every newline inside a "/' body — which is ` +
        `what stops one apostrophe in JSX copy swallowing the rest of the file — ` +
        `so a static className="…" wrapped across lines is cut there and its ` +
        `closing quote reads as an OPENER. \`attributeSegments\` is what puts ` +
        `that shape back; if a wrapped attribute is listed below, that recovery ` +
        `stopped matching it.\n` +
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

  it('reads group structure off the body with its interpolation holes blanked', () => {
    // Whether an interpolation is a CUT or a protected placeholder is decided by
    // the brackets of the class list around it, never by the brackets the hole
    // happens to carry, and the blank that hides the hole has to be
    // INDEX-ALIGNED — one placeholder character per source character — because
    // the positions it produces are used to address the RAW body.
    //
    // Both halves of that are catch-neutral once `fragmentInterior` is in
    // place: a cut through an arbitrary value leaves the shadow in a fragment
    // whose bad edges get trimmed, so the token is still flagged either way.
    // What breaks is the SEGMENT — the class list stops being visible as itself,
    // which is the invariant a prose exemption rests on and the one the
    // tree-wide `sees every class list … as its own segment` cell enforces. So
    // this cell asserts the segment, not the verdict.
    const whole = (source: string): string[] =>
      classSegments(source).filter((s) => s.includes('w-[') && s.includes('shadow-lg'));
    // Collapse the blank to a single character and every position after the
    // first hole is shifted, so `inGroup[start]` reads a character that is not
    // the one the span begins at: the arbitrary value's own interpolation stops
    // being protected and the list is cut in half.
    const shifted = 'const cls = `${variantClasses} w-[${w}px] p-1.5 shadow-lg`;';
    expect(whole(shifted)).toHaveLength(1);
    expect(flagged(shifted)).toEqual(['shadow-lg']);
    // And the hole's OWN brackets decide nothing: read the raw body instead of
    // the blanked one and the `[`/`]` assembled inside these holes look like a
    // group around the class list, so neither interpolation is a cut and the
    // shadow lands in a segment beginning mid-token.
    const carried = "const cls = `${'['}p-1.5${']'} shadow-lg`;";
    expect(classSegments(carried)).toContain(' shadow-lg');
    expect(flagged(carried)).toEqual(['shadow-lg']);
  });

  it('cuts an interpolation at its own closing brace, not at the first one', () => {
    // `\$\{[^{}]*\}` stops at the first `}`, so an interpolation carrying an
    // object literal is mis-cut and its tail — `)} shadow-lg` — is left inline
    // in the class-list text, where it is neither a class list nor prose, and
    // so exempt.
    //
    // The shadow has to sit AFTER the mis-cut for this to measure the cut. The
    // fixture below it puts the shadow inside the interpolation's own string
    // literal, and the recursive descent recovers that one whether the brace
    // scan is balanced or not — so it guards the descent, not the cut, and the
    // balanced scan was shipped with no cell that could fail on it.
    expect(flagged('const cls = `p-2 ${cn({ a: 1 })} shadow-lg`;')).toEqual(['shadow-lg']);
    expect(flagged('const cls = `p-2 ${a ? cn({ b: 1 }) : c} shadow-xs`;')).toEqual(['shadow-xs']);
    const nested = "const cls = `p-2 ${cn({ 'shadow-lg': on })} rounded-md`;";
    expect(flagged(nested)).toEqual(['shadow-lg']);
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

  it('reads a mismatched closer inside an arbitrary value as content, not as structure', () => {
    // `[a)b]` is legal inside an arbitrary value, and three separate functions
    // in this file have to agree about it: `maskGroups` on a token,
    // `groupInterior` on a chunk, and `utilityOf` on the variant split. Two of
    // them matched each closer against an opener of its OWN kind and the third
    // counted `[`, `]`, `(` and `)` in one undifferentiated depth — so the stray
    // `)` below drove that depth negative, no colon was ever seen at depth 0,
    // the variant was never stripped, and the anchored shadow pattern never saw
    // the shadow. `isClassList` called the segment a class list all the while,
    // so no exemption and no prose tradeoff was involved: the token was simply
    // unrecognised, and the pattern this rule replaces caught it.
    const variant = '[&[data-x=")"]]:p-4';
    expect(isTailwindToken(variant)).toBe(true);
    expect(utilityOf('[&[data-x=")"]]:shadow-lg')).toBe('shadow-lg');
    // And with a colon INSIDE the utility's own arbitrary value as well, which is
    // where one undifferentiated depth counter actually loses: the stray `)`
    // drives it to -1, the `[` of the arbitrary value only brings it back to 0,
    // so `shadow:` reads as a variant boundary and the cut throws the utility
    // away. The own-kind scan sees the `[shadow:…]` group and cuts at the
    // variant colon instead.
    expect(utilityOf('[&[data-x=")"]]:shadow-[shadow:0_0_8px_#22d3ee]')).toBe(
      'shadow-[shadow:0_0_8px_#22d3ee]',
    );
    expect(isClassList('p-1.5 [&[data-x=")"]]:shadow-lg')).toBe(true);
    expect(flagged(asSource('p-1.5 [&[data-x=")"]]:shadow-lg'))).toEqual(['shadow-lg']);
    // And the SEGMENT stays whole, which is the same claim one layer out: both
    // `"` characters below sit inside a balanced `[…]`, so the `"` cut must not
    // fire between them. Match the stray closer to the nearest opener of any
    // kind and the group ends early, the second `"` becomes a boundary, and the
    // list is cut in half.
    const list = 'p-1.5 content-[")"] shadow-lg';
    expect(classSegments(asSource(list))).toContain(list);
    expect(flagged(asSource(list))).toEqual(['shadow-lg']);
    // Non-vacuity: the pattern this replaces caught both through its `\b`.
    expect(PRE_V4_PATTERN.test('[&[data-x=")"]]:shadow-lg')).toBe(true);
    expect(PRE_V4_PATTERN.test(list)).toBe(true);
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

  /**
   * Legal Tailwind 4 shapes this tree does not happen to spell today.
   *
   * Every sample in this file that comes from the tree can only be as strong as
   * the tree, and the two shapes that made this rule weaker than the pattern it
   * replaces are both absent from it: `grep -rn 'bg-\[url(' frontend/src` and
   * `grep -rn ':![a-z]' frontend/src` are each empty, so both holes sat under a
   * fully green suite with a live `shadow-lg` planted beside them. A guard for
   * a grammar needs fixtures the grammar allows, not only the ones already
   * written down.
   */
  const LATENT_SHAPES = [
    // A `"` inside an arbitrary value: `bg-[url("…")]`, and `content-["…"]` for
    // any punctuation that would need escaping in a single-quoted CSS string.
    // Cutting a body at every `"` split lists like these into unbalanced halves
    // — `bg-[url(` and `)] shadow-lg` — and a half that opens on a closer is
    // not a token shape, so both halves read as prose.
    'bg-[url("/x.png")]',
    'after:content-["\\2014"]',
    // Tailwind 3's important marker in its post-variant position. Tailwind 4.3
    // still compiles `hover:!shadow-md` (and v4's own `hover:shadow-md!`), and
    // a grammar that allows `!` only at the token edges rejects the token, which
    // makes the whole class list prose.
    'hover:!bg-card',
    'dark:md:!text-sm',
    'focus-visible:!ring-2',
    'sm:!-mt-1',
  ];

  it('recognises legal Tailwind 4 shapes this tree does not happen to use yet', () => {
    const rejected = LATENT_SHAPES.filter((token) => !isTailwindToken(token));
    expect(
      rejected,
      'a token the grammar refuses turns its whole class list into prose, and ' +
        'prose exempts every banned utility standing in it',
    ).toEqual([]);
  });

  it('does not let a latent shape exempt the shadow standing beside it', () => {
    const escaped: string[] = [];
    for (const shape of LATENT_SHAPES) {
      for (const form of CAUGHT_BEFORE) {
        const segment = `${THEME_SWATCH} ${shape} ${form}`;
        if (!PRE_V4_PATTERN.test(segment)) continue;
        if (flagged(asSource(segment)).length > 0) continue;
        escaped.push(`${form} beside ${shape}`);
      }
    }
    expect(escaped, 'the pre-v4 pattern caught every one of these').toEqual([]);
  });

  it('flags a shadow that carries the important marker after its variants', () => {
    // The marker says how hard the declaration wins, never whether it paints a
    // shadow. All three spellings compile under tailwindcss 4.3.
    expect(flagged(`<div className="${THEME_SWATCH} hover:!shadow-md" />`)).toEqual(['shadow-md']);
    expect(flagged(`<div className="${THEME_SWATCH} md:!drop-shadow-lg" />`)).toEqual([
      'drop-shadow-lg',
    ]);
    expect(flagged(`<div className="${THEME_SWATCH} hover:shadow-md!" />`)).toEqual(['shadow-md']);
    expect(flagged(`<div className="${THEME_SWATCH} !shadow-lg" />`)).toEqual(['shadow-lg']);
    // And the marker on an unrelated utility must not exempt an ordinary shadow
    // standing beside it — the way a rejected token actually escapes.
    expect(flagged(`<div className="${THEME_SWATCH} hover:!text-red-500 shadow-lg" />`)).toEqual([
      'shadow-lg',
    ]);
  });

  it('does not cut a class list at a `"` that is inside an arbitrary value', () => {
    // `"` has to stay a cut — a `'`-opened body that ran past a `className="…"`
    // is put back into its parts by exactly that cut — but a `"` inside a
    // balanced `[…]` or `(…)` group is content, not a boundary.
    const list = 'flex p-1.5 bg-[url("/x.png")] shadow-lg';
    expect(classSegments(asSource(list))).toContain(list);
    expect(flagged(asSource(list))).toEqual(['shadow-lg']);
    expect(flagged(asSource('p-1.5 shadow-[var(--x,"fallback")]'))).toEqual([
      'shadow-[var(--x,"fallback")]',
    ]);
    // The cut itself is still there: an unbalanced `"` splits as before, which
    // is what recovers a class list from a desynced body.
    expect(classSegments('doesn\'t tilt <div className="p-1.5 shadow" />')).toContain(
      'p-1.5 shadow',
    );
  });

  /**
   * Legal source SHAPES this tree does not happen to spell today.
   *
   * `LATENT_SHAPES` above is a token table, and a token table can only test the
   * grammar. Every hole that made a version of this rule weaker than the pattern
   * it replaces was in the two parts BEFORE the grammar — the quote scanner and
   * the segmenter — and those are decided by the shape of the SOURCE, not by the
   * spelling of a class. So the fixtures below are source snippets, they are all
   * absent from the tree (`grep -rn '\[\${' frontend/src --include=*.tsx` is
   * empty, no static `className="…"` in the tree is wrapped across lines, and no
   * class list here is assembled by cutting a literal across a bracket: the same
   * grep covers the interpolated form, and of the three literals in the tree
   * that end on an opener or begin on a closer, all three are apostrophe-desync
   * fragments of English prose — `…'s post-save \`invalidateQueries([` and its
   * two siblings — not class lists), and the cell under them checks each is a
   * case the PIPELINE this rule replaces caught — otherwise the table proves
   * nothing.
   */
  const LATENT_SOURCES: { name: string; source: string; token: string }[] = [
    // A `${…}` inside an arbitrary value — how React spells a dynamic length.
    // `collectSegments` used to cut at every interpolation, which split
    // `h-[${h}px]` into `h-[` and `px]`: one half never closes its bracket, the
    // other opens on a closer, so both read as prose and the shadow was exempt.
    // Delete the `inGroup[start]` branch in `collectSegments` and these red.
    {
      name: 'a dynamic length in an arbitrary value',
      source: 'const cls = `h-[${h}px] p-1.5 shadow-lg`;',
      token: 'shadow-lg',
    },
    {
      name: 'a dynamic percentage in an arbitrary value',
      source: 'const cls = `w-[${pct}%] p-1.5 shadow-lg`;',
      token: 'shadow-lg',
    },
    // The hole is two groups deep, so the protection cannot be a `[…]` special
    // case: `groupInterior` has to be the same balanced scan the rest uses.
    {
      name: 'a dynamic count inside a nested group',
      source: 'const cls = `grid-cols-[repeat(${n},1fr)] p-1.5 shadow-lg`;',
      token: 'shadow-lg',
    },
    {
      name: 'a dynamic custom property name',
      source: 'const cls = `bg-[var(--${role})] p-1.5 shadow-lg`;',
      token: 'shadow-lg',
    },
    // An interpolation AND a `"` in the same arbitrary value: the two cuts that
    // have to agree about what a balanced group is.
    {
      name: 'a dynamic url with a quote around it',
      source: 'const cls = `p-1.5 bg-[url("${u}")] shadow-lg`;',
      token: 'shadow-lg',
    },
    // Group structure has to be read off the body with the interpolations
    // BLANKED, and the blank has to be INDEX-ALIGNED — `blankSpans`. Read the
    // raw body instead and the brackets a hole carries decide protection: the
    // second fixture's holes hold `[` and `]` of their own, so the raw body
    // looks balanced around a class list that is not in a group at all, the
    // interpolations stop being cuts, and the shadow lands in a segment nobody
    // judges. Collapse the blank to ONE character instead of `end - start` of
    // them and the positions no longer address `body`, so `inGroup[start]` reads
    // the wrong index: the first fixture's leading hole shifts every later one.
    // Both are cases the pipeline this rule replaces caught.
    {
      name: 'an interpolation standing before the one inside an arbitrary value',
      source: 'const cls = `${variantClasses} w-[${w}px] p-1.5 shadow-lg`;',
      token: 'shadow-lg',
    },
    {
      name: 'brackets that live inside the interpolation, not around it',
      source: "const cls = `${'['}p-1.5${']'} shadow-lg`;",
      token: 'shadow-lg',
    },
    {
      name: 'a bracket assembled inside the hole of an arbitrary value',
      source: "const cls = `w-[${'['}] shadow-md p-1.5`;",
      token: 'shadow-md',
    },
    // A class list assembled by string surgery straight THROUGH an arbitrary
    // value. At runtime the first renders `w-[8px] shadow-lg bg-[] p-1.5`, a
    // real class list with a real shadow in it; the second is the same shape
    // with no interpolation anywhere, which is what shows this is a property of
    // cutting rather than of `INTERP_MARK`. Both reach the grammar as a fragment
    // whose first token opens on a closer and whose last never closes its
    // opener, so `maskGroups` rejects both edges, one rejected token makes the
    // segment prose, and every shadow in it was exempt. `fragmentInterior` is
    // what recovers them; delete its call in `classSegments` and these red.
    {
      name: 'a class list assembled by string surgery across an arbitrary value',
      source: "const a = <div className={`w-[${'8px] shadow-lg bg-['}] p-1.5`} />;",
      token: 'shadow-lg',
    },
    {
      name: 'a class list fragment assembled in two separate literals',
      source: "const a = 'grid-cols-['; const b = '1fr] shadow-lg';",
      token: 'shadow-lg',
    },
    // Not an attribute at all. Every tree-derived sample in this file is drawn
    // from `className` attributes or oracle-recognised literals, so a class list
    // returned by a helper is in none of them.
    {
      name: 'a class list built by a helper rather than written as an attribute',
      source: 'const swatch = (w: number) => `flex w-[${w}px] shadow-md`;',
      token: 'shadow-md',
    },
    // A multi-line backtick body whose prose and class list are separate LINES,
    // with no interpolation and no `"` anywhere — so the newline cut in
    // `pushChunks` is the only thing that keeps the prose line from making the
    // class-list line prose too. Remove `c !== '\n'` from that cut and this reds;
    // every other fixture in the file survives it, which is why it is here.
    {
      name: 'a prose line above a class-list line in one backtick body',
      source: [
        'const help = `',
        '  Compendiq does not tilt cards under the cursor',
        '  flex p-1.5 shadow-lg',
        '`;',
      ].join('\n'),
      token: 'shadow-lg',
    },
    // A static `className="…"` wrapped across lines: legal, prettier-produced
    // JSX that `resyncedBodies` must cut at the newline and `attributeSegments`
    // therefore has to recover. Delete the `attributeSegments` call in
    // `classSegments` and this reds.
    {
      name: 'a static className attribute wrapped across lines',
      source: '<div className="flex w-12 shrink-0 flex-col gap-1\n  rounded-md p-1.5 shadow" />',
      token: 'shadow',
    },
  ];

  it('catches a shadow in every source shape this tree does not spell yet', () => {
    const escaped = LATENT_SOURCES.filter(({ source, token }) => !flagged(source).includes(token));
    expect(
      escaped.map((fixture) => fixture.name),
      'the scanner or the segmenter lost the class list, so the shadow standing ' +
        'in it was never handed to any rule',
    ).toEqual([]);
  });

  it('every latent source fixture is a case the pre-v4 PIPELINE caught', () => {
    // Non-vacuity, and the whole superset argument for the cell above: a fixture
    // the rule this replaces did not catch either proves nothing about being a
    // superset of it. The comparison is against the pipeline — its scanner and
    // its allowance, not just its pattern — because every shape in the table is
    // a scanner or segmenter case and a pattern-only comparison cannot see one.
    const vacuous = LATENT_SOURCES.filter(({ source }) => !preV4Catches(source));
    expect(
      vacuous.map((fixture) => fixture.name),
      'this fixture is not a regression against anything — either fix it or drop it',
    ).toEqual([]);
  });
});
