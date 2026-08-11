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
 * - Detection only fires on SHORT queries: MAX_BARE_QUERY_TOKENS for
 *   uncued shapes, MAX_CUED_QUERY_TOKENS with a cue — long natural-language
 *   questions keep their normal retrieval untouched.
 * - Case is a signal: issue keys and space keys match case-sensitively.
 * - At most two identifiers are returned, strongest kind first
 *   (pageId > issueKey > title > spaceKey by ambiguity).
 *
 * Detection is necessary, never sufficient: the caller VERIFIES every
 * detection with a cheap indexed lookup before pinning anything (the
 * rag-service pin stage), so a false positive costs one fast query, not a
 * wrong answer. This module is dependency-free and pure.
 */

export const MAX_BARE_QUERY_TOKENS = 4;
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

const ISSUE_KEY = /\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/g;
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
const QUOTED = /"([^"]{2,120})"/;
const CUED_SPACE_KEY = /\b(?:space|key|in)\s+([A-Z]{2,10})\b/;
// Greedy to end-of-query by design; trailing qualifiers ("page called X
// in DEV space") widen the captured title and typically miss the 0.3
// trigram threshold — a silent miss, never a wrong pin (#1273 review M9).
// The issueKey shape also admits RFC-2119/ISO-9001-style tokens; they cost
// one indexed title probe and pin only when a page's TITLE carries them
// (#1273 M12 — safe post-B2).
const CALLED_CUE = /\bpage\s+(?:called|named)\s+(.{2,120})$/i;

export function detectIdentifiers(query: string): DetectedIdentifier[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];
  const tokens = trimmed.split(/\s+/);
  const bareOk = tokens.length <= MAX_BARE_QUERY_TOKENS;
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
    const inner = quoted[1]!.trim();
    // A short all-caps quoted token reads as a space key, not a title.
    if (WHOLE_SPACE_KEY.test(inner)) add('spaceKey', inner);
    else add('title', inner);
  }
  const called = CALLED_CUE.exec(trimmed);
  if (called) add('title', called[1]!.trim());

  // Space key: whole query or cue-adjacent — NEVER a bare token in prose.
  if (bareOk && WHOLE_SPACE_KEY.test(trimmed)) {
    add('spaceKey', trimmed);
  } else {
    const cued = CUED_SPACE_KEY.exec(trimmed);
    if (cued) add('spaceKey', cued[1]!);
  }

  return found
    .sort((a, b) => KIND_STRENGTH[a.kind] - KIND_STRENGTH[b.kind])
    .slice(0, 2);
}
