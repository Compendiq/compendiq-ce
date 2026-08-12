/**
 * #1110 — choose which Postgres text-search parser a user query is safe for.
 *
 * `websearch_to_tsquery` is what we want: it honours `"quoted phrases"` and
 * `-exclusions`, where `plainto_tsquery` flattened both into loose ANDs (and
 * *inverted* exclusions, since a leading `-` parsed as an ordinary term and
 * so REQUIRED the excluded word).
 *
 * But it is structurally more fragile than the parser it replaces, in two
 * ways that are measured rather than theorised:
 *
 * 1. **NOT nesting.** Every `-` in operand position compiles to a NOT, and
 *    pending NOTs accumulate on the parser stack across runs. ~32 raise
 *    `XX000 tsquery stack too small`.
 * 2. **Phrase nesting.** Punctuation-joined tokens compile to a RIGHT-NESTED
 *    phrase chain — `1,2,3` becomes `'1' <-> '2' <-> '3'` where plainto
 *    gives a flat `'1' & '2' & '3'`. So ~14,600 comma-separated terms raise
 *    `54001 stack depth limit exceeded`, with no hyphens involved at all.
 *    plainto survives roughly three times longer on the same input.
 *
 * Both are ERRORS, not empty results, so they 500 the request.
 *
 * ## Why this switches parser instead of rewriting the query
 *
 * Three earlier guards rewrote the string, and each was disproved by
 * execution: whitespace-anchored stripping missed the operand positions
 * Postgres also honours; per-run parity bounded one run but not the count;
 * and a total-hyphen cap bounded neither the phrase nesting above nor its
 * own escape hatch. That last one was the instructive failure — replacing
 * every `-` with a space destroys exactly the identifiers this product is
 * full of. Measured: `to_tsvector('simple','advisory CVE-2024-1234')` holds
 * the lexemes `'-2024'` and `'-1234'`, so a query rewritten to `2024 1234`
 * can never match it. Nine of ten identifier shapes (CVE, INC, dates,
 * versions, IPs, emails, paths) were lost that way, while `plainto_tsquery`
 * kept all ten — so the "fallback" was strictly worse than the thing it
 * claimed to fall back to.
 *
 * A query is either safe for the richer parser or it is not. When it is not,
 * parse it the way this product parsed everything until now: `plainto`
 * keeps hyphens, keeps compound lexemes, flattens instead of nesting, and
 * cannot do worse than the pre-#1110 baseline by construction. Phrases and
 * exclusions are lost for that one pathological query, which is the correct
 * trade against a 500.
 */

/**
 * Hyphens allowed before a query is treated as punctuation art rather than
 * intent. Well under the ~32 that exhausts the NOT stack, and well above
 * real usage: a couple of exclusions plus hyphenated identifiers.
 */
export const MAX_QUERY_HYPHENS = 8;

/**
 * Query LENGTH allowed before falling back, and length rather than a token
 * count on purpose. The phrase-nesting failure comes from punctuation-joined
 * tokens, and `1,2,3,…,14600` is a SINGLE whitespace chunk holding 14,600
 * nested nodes — a chunk counter would sail straight past it. (I wrote that
 * counter first; it is the same mistake as the three string-rewriting guards
 * before it, which is why the rule is now something provable.)
 *
 * A tsquery cannot contain more nodes than the input has characters, so
 * capping characters caps nesting depth outright, whatever shape the input
 * takes. 4,000 is an order of magnitude below the ~29,000-char measured
 * failure and far above any real question.
 */
export const MAX_QUERY_CHARS = 4000;

export type LexicalParser = 'websearch_to_tsquery' | 'plainto_tsquery';

/**
 * The parser to use for this query. SAFE TO INTERPOLATE: the return type is
 * a closed union of two literals from this module, never user input.
 */
export function chooseLexicalParser(query: string): LexicalParser {
  if (query.length > MAX_QUERY_CHARS) return 'plainto_tsquery';
  let hyphens = 0;
  for (let i = 0; i < query.length; i += 1) {
    if (query[i] === '-') {
      hyphens += 1;
      if (hyphens > MAX_QUERY_HYPHENS) return 'plainto_tsquery';
    }
  }
  return 'websearch_to_tsquery';
}
