/**
 * #1110 — make a user query safe for `websearch_to_tsquery` without changing
 * what an ordinary query means.
 *
 * `websearch_to_tsquery` is worth having because it honours `"quoted
 * phrases"` and `-exclusions`, which `plainto_tsquery` flattens into loose
 * ANDs — the latter previously *inverted* the user's intent, since a leading
 * `-` parsed as an ordinary term and so REQUIRED the excluded word.
 *
 * ## The hazard
 *
 * Every `-` that lands in operand position compiles to a NOT, and pending
 * NOTs accumulate on the parser's stack until an operand arrives. Past ~32
 * Postgres raises `XX000 tsquery stack too small` — an ERROR, not an empty
 * result, so it 500s the request. `plainto_tsquery` returns empty for all of
 * these, which makes it a regression rather than a pre-existing wart.
 *
 * ## Why this is a COUNT cap and not something cleverer
 *
 * Two earlier attempts modelled the grammar and both were wrong, each
 * disproved by execution:
 *
 * 1. "Strip runs that start a token" (`(^|\s)-+`) missed the operator
 *    positions Postgres also honours — a pasted Markdown table border,
 *    `| col |---------------------------------|`, sailed straight through.
 * 2. "Reduce each run to its parity" bounded one run's depth but not the
 *    number of runs. NOTs nest ACROSS runs, so 33 single spaced hyphens
 *    (`a - - - … b`, or a table separator row) still crashed with every
 *    individual run already at depth 1.
 *
 * The lesson is that the exact set of operand-state positions is a
 * version-dependent implementation detail of Postgres's parser, and guessing
 * it has now cost two wrong fixes. So this does not guess. Each `-` can
 * contribute AT MOST one NOT, therefore capping the total number of hyphens
 * caps the stack depth outright — no grammar model required, and it stays
 * true whatever the parser does with punctuation in future versions.
 *
 * Below the cap nothing is touched at all, so real queries keep exact
 * `websearch_to_tsquery` semantics: `-logging` still excludes, and
 * `fastify-plugin`, `INC-2203` and `CVE-2024-1234` still match as compounds.
 * Above it, every hyphen is dropped and the query degrades to plain terms —
 * which is precisely what `plainto_tsquery` did for the same input, so the
 * worst case is today's behaviour rather than an error.
 */

/**
 * Maximum hyphens allowed through untouched. Chosen well under the observed
 * ~32-deep parser limit so the guard holds even if that limit is lower on
 * another build, and well above real usage: a couple of exclusions plus a
 * hyphenated identifier or two. Anything beyond this is punctuation — a
 * table border, an ASCII rule, an arrow — not intent.
 */
export const MAX_QUERY_HYPHENS = 8;

export function sanitizeLexicalQuery(query: string): string {
  let hyphens = 0;
  for (let i = 0; i < query.length; i += 1) {
    if (query[i] === '-') {
      hyphens += 1;
      if (hyphens > MAX_QUERY_HYPHENS) return query.replace(/-/g, ' ');
    }
  }
  return query;
}
