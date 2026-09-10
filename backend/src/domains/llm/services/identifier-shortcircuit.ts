/**
 * #1107 — the pure DETECTION half of the exact-identifier short-circuit.
 * Semantic + FTS never reliably hit a literal identifier (a page id, an
 * INC-2203-style key, a space key, a quoted title): the vector averages it
 * away and FTS dilutes it. This module recognises Compendiq's identifier
 * shapes in a query, under guards that make the false-positive risk — the
 * issue's own stated core risk — structural rather than probabilistic:
 *
 * - Every shape is either the WHOLE query, QUOTED, or adjacent to a CUE
 *   word; bare tokens in natural language never fire (space keys like DEV/
 *   IT/OPS/HR appear constantly in ordinary questions).
 * - Detection only fires on SHORT queries: MAX_CUED_QUERY_TOKENS gates
 *   every shape. There is deliberately no second, tighter bound. One
 *   existed (MAX_BARE_QUERY_TOKENS = 4) and gated nothing reachable: every
 *   uncued shape is anchored to the WHOLE query, so its token count is 1
 *   and a 4-token ceiling can never bind. A future uncued shape that is
 *   not whole-query-anchored would need its own bound — reintroduce one
 *   then, live, rather than carrying an inert constant the docs describe
 *   as a guard.
 * - Case is a signal: issue keys and space keys match case-sensitively.
 * - At most two identifiers are returned, strongest kind first
 *   (pageId > issueKey > title > spaceKey by ambiguity).
 *
 * Detection is necessary, never sufficient: the caller VERIFIES every
 * detection with a cheap indexed lookup before pinning anything (the
 * rag-service pin stage), so a false positive costs one fast query, not a
 * wrong answer. This module is dependency-free and pure.
 */

export const MAX_CUED_QUERY_TOKENS = 6;

export type IdentifierKind = 'pageId' | 'issueKey' | 'spaceKey' | 'title';

export interface DetectedIdentifier {
  kind: IdentifierKind;
  value: string;
}

const KIND_STRENGTH: Record<IdentifierKind, number> = {
  pageId: 0,
  issueKey: 1,
  title: 2,
  spaceKey: 3,
};

// Multi-segment keys (CVE-YYYY-NNNN, Jira sub-task ids, versioned keys)
// must verify WHOLE or not at all, and that takes both halves. The
// optional segment stops `CVE-2024-1234` detecting as `CVE-2024` (#1273
// fork F7). The trailing (?!-?\d) is what makes the rule true rather than
// aspirational: with a bare \b the engine simply DROPS the optional group
// and stops at the hyphen when the last run is too long, so
// `CVE-2024-1234567` still became `CVE-2024` — a key that title-matches a
// different CVE, which is the failure the optional group was added to
// prevent. Refusing beats truncating: an over-long token is not a key
// shape, and a miss costs one indexed probe.
const ISSUE_KEY = /\b[A-Z][A-Z0-9]{1,9}-\d{1,6}(?:-\d{1,6})?(?!-?\d)/g;
const WHOLE_NUMERIC = /^\d{1,10}$/;
// >=5 digits for the CUED shape (#1273 review B1): pages.id is a dense
// SERIAL, so "page 2" / "see page 12 above" would verify against SOME row
// on every instance — the verification step is a structural no-op for
// small integers. Five digits keeps deliberate id references (Confluence
// ids are large; deep internal ids too) while prose page references never
// fire. The WHOLE-QUERY shape stays any length: pasting a bare number is
// deliberate intent, and the verifier prefers the confluence_id namespace.
const CUED_NUMERIC = /\b(?:page|id)\s*#?\s*(\d{5,10})\b/i;
const WHOLE_SPACE_KEY = /^[A-Z]{2,10}$/;
// Straight AND typographic quotes (#1273 fork F14): macOS and iOS
// substitute curly quotes by default, so an ASCII-only pattern left the
// feature's primary gesture silently dead for those users — and a miss
// here is invisible, since the query just falls through to normal
// retrieval. The class is deliberately permissive about pairing.
const SMART_QUOTES = '"“”„«»';
const QUOTED = new RegExp(`[${SMART_QUOTES}]([^${SMART_QUOTES}]{2,120})[${SMART_QUOTES}]`);
const CUED_SPACE_KEY = /\b(?:space|key|in)\s+([A-Z]{2,10})\b/;
// Greedy to end-of-query by design; trailing qualifiers ("page called X
// in DEV space") widen the captured title and fall under the pin's
// similarity floor — a silent miss, never a wrong pin (#1273 review M9).
// The issueKey shape also admits RFC-2119/ISO-9001/SHA-256-style tokens;
// post-fork-F1 they verify against a page TITLE only, so an ordinary
// "SHA-256 vs MD5" question costs one indexed probe and pins nothing.
const CALLED_CUE = /\bpage\s+(?:called|named)\s+(.{2,120})$/i;
// Punctuation is stripped to NORMALISE, not to fix matching. Measured on
// Postgres 17 / pg_trgm 1.6: punctuation and quotes are separators, so
// show_trgm('FAQ?') and show_trgm('"FAQ') both equal show_trgm('FAQ') and
// similarity() is 1.0 — the probe already matched. An earlier version of
// this comment claimed similarity('FAQ','FAQ?') = 0.286 and it was wrong:
// 0.2857 is the TRAILING-PROSE case, similarity('FAQ','FAQ right now'),
// which really does fall under the 0.3 threshold and which stripping
// deliberately does NOT address — trimming words would guess at where the
// title ends, and a silent miss beats a confident wrong pin.
//
// What stripping buys is that the quoted and called-cue paths land on the
// SAME string, so one gesture yields one detection rather than two (`add`
// de-dupes on kind+value). Two detections of one page is not a cosmetic
// problem — see the no-substitute rule in the rag-service pin stage.
const TRAILING_PUNCT = /[\s"“”„«»'’?.!,;:]+$/;
// And the LEADING half. `page called "X"` reaches here rather than through
// QUOTED, whose inner class needs two characters — so without this the
// capture kept its opening quote and the trigram probe searched for `"X`.
const LEADING_PUNCT = /^[\s"“”„«»'’]+/;

export function detectIdentifiers(query: string): DetectedIdentifier[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];
  const tokens = trimmed.split(/\s+/);
  const cuedOk = tokens.length <= MAX_CUED_QUERY_TOKENS;
  if (!cuedOk) return [];

  const found: DetectedIdentifier[] = [];
  const add = (kind: IdentifierKind, value: string) => {
    if (!found.some((f) => f.kind === kind && f.value === value)) found.push({ kind, value });
  };

  // Numeric page id: whole query, or cued.
  if (WHOLE_NUMERIC.test(trimmed)) {
    add('pageId', trimmed);
  } else {
    const cued = CUED_NUMERIC.exec(trimmed);
    if (cued) add('pageId', cued[1]!);
  }

  // Issue-style key: its shape IS the cue (distinctive enough at the cued
  // token limit), case-sensitive.
  for (const m of trimmed.matchAll(ISSUE_KEY)) {
    add('issueKey', m[0]);
  }

  // Quoted title, or the "page called/named X" cue.
  const quoted = QUOTED.exec(trimmed);
  if (quoted) {
    // A quoted string is ALWAYS a title (#1273 fork F10). Reclassifying a
    // short all-caps one as a space key made pages genuinely titled 'FAQ',
    // 'SLA', 'API' or 'OKR' unpinnable through the quoted path, because
    // space-key detections verify nothing — and deliberately quoting a
    // short title is precisely the gesture the trgm title lookup exists
    // for. The bare-token space key below is unaffected.
    add('title', quoted[1]!.trim());
  }
  // The called-cue is skipped when the query already carries QUOTES,
  // because the two describe ONE gesture and the cue's greedy capture
  // describes it worse: `page called "FAQ" in DEV` yields `FAQ` from the
  // quotes and `FAQ" in DEV` from the cue — two title detections of one
  // intent, which the pin stage can only resolve by pinning one page or
  // two. Quotes are the more precise expression, so they win outright.
  if (!quoted) {
    const called = CALLED_CUE.exec(trimmed);
    if (called) {
      const title = called[1]!.trim().replace(LEADING_PUNCT, '').replace(TRAILING_PUNCT, '');
      if (title.length >= 2) add('title', title);
    }
  }

  // Space key: whole query or cue-adjacent — NEVER a bare token in prose.
  if (WHOLE_SPACE_KEY.test(trimmed)) {
    add('spaceKey', trimmed);
  } else {
    const cued = CUED_SPACE_KEY.exec(trimmed);
    if (cued) add('spaceKey', cued[1]!);
  }

  return found
    .sort((a, b) => KIND_STRENGTH[a.kind] - KIND_STRENGTH[b.kind])
    .slice(0, 2);
}
