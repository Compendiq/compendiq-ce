/**
 * `/api/search` `snippet` is an HTML-safe fragment in every mode (#1964): page
 * text passed once through the `& < > " '` mapping below, plus `<mark>` and
 * `</mark>` exactly where PostgreSQL's `ts_headline` generated a highlight.
 * Authored `<mark>`, `<script>`, entities, quotes and control characters are
 * text. All snippet escaping lives in this module.
 *
 * Keyword full-text rows: `ts_headline` runs over the unmodified `body_text`
 * (so the passage and its highlights are PostgreSQL's) with one-character
 * selectors instead of `<mark>`. Which positions of its output are selectors is
 * proven by position, never by searching the text: when the body itself
 * contains a primary selector character, the route also asks for the same
 * headline with an alternate pair, and only a position holding the primary
 * selector in one output and the alternate in the other is markup.
 */
const ESCAPE_BY_CHAR: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const ESCAPED_CHARS = /[&<>"']/g;

/** HTML-escape plain text for a search snippet. */
export function escapeSnippetHtml(text: string): string {
  return text.replace(ESCAPED_CHARS, (char) => ESCAPE_BY_CHAR[char]!);
}

/** Fuzzy-title rows take this many characters of `body_text`, semantic and hybrid rows of the flattened chunk. */
export const SNIPPET_MAX_CODE_POINTS = 300;

/**
 * The first `max` Unicode code points of `text` (PostgreSQL `substring`
 * semantics), so a cut never leaves half of a surrogate pair. A lone surrogate
 * already in the text counts as one.
 */
export function takeCodePoints(text: string, max: number): string {
  let count = 0;
  for (let index = 0; index < text.length; index++) {
    if (count === max) return text.slice(0, index);
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index++;
    }
    count++;
  }
  return text;
}

const START = 0x01;
const STOP = 0x02;
const ALT_START = 0x03;
const ALT_STOP = 0x04;

function headlineOptionsSql(start: number, stop: number): string {
  return `'MaxWords=30, MinWords=15, StartSel=' || chr(${start}) || ', StopSel=' || chr(${stop})`;
}

/**
 * `ts_headline` option expressions, built server-side from `chr(n)` constants
 * (no document or query text enters them). The word limits are the ones the
 * keyword snippet always used.
 */
export const HEADLINE_OPTIONS_SQL = headlineOptionsSql(START, STOP);
export const HEADLINE_ALT_OPTIONS_SQL = headlineOptionsSql(ALT_START, ALT_STOP);

/** SQL condition over a fixed text expression: true when it contains a primary selector character. */
export function headlineNeedsAlternateSql(textExpr: string): string {
  return `(strpos(${textExpr}, chr(${START})) > 0 OR strpos(${textExpr}, chr(${STOP})) > 0)`;
}

/**
 * Render a keyword full-text headline as an HTML fragment in one pass.
 *
 * `headline` is the `ts_headline` output with the primary selectors.
 * `alternate` is the same headline with the alternate selectors, present only
 * when the body contains a primary selector character; without it every
 * primary selector character is generated markup.
 *
 * Any doubt about provenance (unequal lengths, a position where the outputs
 * differ other than primary/alternate start or stop, a nested start, a stop
 * with no open mark, a mark still open at the end) discards all markup found so
 * far and returns the whole headline escaped as text, control characters
 * included.
 */
export function keywordHeadlineHtml(headline: string, alternate: string | null): string {
  if (alternate !== null && alternate.length !== headline.length) return escapeSnippetHtml(headline);
  const parts: string[] = [];
  let open = false;
  let runStart = 0;
  for (let index = 0; index < headline.length; index++) {
    const code = headline.charCodeAt(index);
    let isStart: boolean;
    if (alternate === null) {
      if (code !== START && code !== STOP) continue;
      isStart = code === START;
    } else {
      const alternateCode = alternate.charCodeAt(index);
      if (code === START && alternateCode === ALT_START) isStart = true;
      else if (code === STOP && alternateCode === ALT_STOP) isStart = false;
      else if (code === alternateCode) continue;
      else return escapeSnippetHtml(headline);
    }
    // A start inside an open mark, or a stop outside one.
    if (isStart === open) return escapeSnippetHtml(headline);
    parts.push(escapeSnippetHtml(headline.slice(runStart, index)), isStart ? '<mark>' : '</mark>');
    open = isStart;
    runStart = index + 1;
  }
  if (open) return escapeSnippetHtml(headline);
  parts.push(escapeSnippetHtml(headline.slice(runStart)));
  return parts.join('');
}
