/**
 * #1110 — normalise a user query before it reaches `websearch_to_tsquery`.
 *
 * `websearch_to_tsquery` is worth having for one reason: it honours
 * `"quoted phrases"`, which `plainto_tsquery` flattens into loose ANDs. But
 * it also reads a leading `-` as NOT, and on THIS corpus that is actively
 * harmful in two separate ways, both measured on Postgres 17 / pg_trgm 1.6:
 *
 * 1. **CLI flags become exclusions.** Compendiq indexes engineering
 *    documentation, so questions carry shell commands constantly:
 *      'docker run -it ubuntu bash' -> 'docker' & 'run' & !'it' & …
 *      'curl -X POST'               -> 'curl' & !'x' & 'post'
 *      'what does the -v flag do'   -> … & !'v' & …
 *    Under the default `simple` configuration `it` is not a stop word, so
 *    that first query demands pages which do NOT contain the word "it" —
 *    i.e. almost nothing. Prose ranges do it too: '500 - 599' -> & !'599'.
 *    That is the exact inverse of the defect the swap set out to fix.
 *
 * 2. **A run of hyphens crashes the parser.** Each `-` nests another NOT,
 *    so ~32 of them raise `XX000 tsquery stack too small` — an ERROR, not
 *    an empty result. An ASCII rule pasted into a question
 *    ('------------------------------', ubiquitous in logs and copied
 *    docs) would therefore 500 the whole request. `plainto_tsquery` returns
 *    empty for the same input.
 *
 * Stripping a hyphen run only where it STARTS a token fixes both while
 * keeping what matters here: hyphenated compounds and identifiers are
 * untouched, because their hyphen is mid-token. `fastify-plugin`,
 * `INC-2203` and `CVE-2024-1234` all survive and match exactly as before —
 * verified against real `to_tsvector` output, not assumed.
 *
 * The cost is explicit: `-term` is no longer an exclusion. It is simply the
 * term, which is what `plainto_tsquery` did anyway, so no behaviour
 * regresses relative to today. Whether this product WANTS Google-style
 * exclusion syntax — given a corpus full of CLI flags — is a product
 * decision recorded on #1110, not one this helper should make silently.
 */
export function sanitizeLexicalQuery(query: string): string {
  // `(^|\s)-+` — a hyphen run at the start of a token only. A mid-token
  // hyphen (the compound case) never matches, which is the whole point.
  return query.replace(/(^|\s)-+/g, '$1');
}
