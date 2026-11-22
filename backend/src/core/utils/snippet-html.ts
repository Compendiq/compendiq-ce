/**
 * `/api/search` `snippet` is an HTML-safe fragment (#1964): HTML-escaped page
 * text plus the `<mark>`/`</mark>` highlight tags `ts_headline` inserts. Text is
 * escaped BEFORE highlighting (the SQL form feeds `ts_headline`) and AFTER any
 * length cut (`substring`, `.slice`), so a cut never lands inside an entity.
 *
 * One mapping serves both forms. `&` comes first because the SQL form applies
 * the replacements in sequence and must not re-escape the entities it wrote.
 */
const SNIPPET_HTML_ESCAPES: ReadonlyArray<readonly [string, string]> = [
  ['&', '&amp;'],
  ['<', '&lt;'],
  ['>', '&gt;'],
  ['"', '&quot;'],
  ["'", '&#39;'],
];

const ESCAPE_BY_CHAR = new Map(SNIPPET_HTML_ESCAPES);
// None of the mapped characters is special inside a character class.
const ESCAPED_CHARS = new RegExp(`[${SNIPPET_HTML_ESCAPES.map(([char]) => char).join('')}]`, 'g');

/** HTML-escape plain text for a search snippet (semantic and hybrid rows). */
export function escapeSnippetHtml(text: string): string {
  return text.replace(ESCAPED_CHARS, (char) => ESCAPE_BY_CHAR.get(char)!);
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * The same escape as a SQL expression over `expr` (keyword rows): nested
 * `replace(...)` calls built only from the constant mapping above. `expr` is
 * interpolated verbatim, so callers pass a fixed SQL expression, never input.
 */
export function sqlEscapeSnippetHtml(expr: string): string {
  return SNIPPET_HTML_ESCAPES.reduce(
    (inner, [char, entity]) => `replace(${inner}, ${sqlLiteral(char)}, ${sqlLiteral(entity)})`,
    expr,
  );
}
