/**
 * #1110 — make a user query safe for `websearch_to_tsquery` WITHOUT changing
 * what it means.
 *
 * `websearch_to_tsquery` is worth having because it honours `"quoted
 * phrases"` and `-exclusions`, which `plainto_tsquery` flattens into loose
 * ANDs. But it compiles every leading `-` into a nested NOT, and a long run
 * of them exhausts the parser stack: measured on Postgres 17, ~32 hyphens
 * raise `XX000 tsquery stack too small`. That is an ERROR, not an empty
 * result, so an ASCII rule pasted into a question —
 * `------------------------------`, ordinary in logs and copied docs —
 * would 500 the whole request. `plainto_tsquery` returned empty for the
 * same input, so this is a hazard the swap introduces.
 *
 * The fix reduces each hyphen run to its PARITY, which is exact rather than
 * approximate. Measured:
 *
 *   'alpha -beta'    ->  'alpha' & !'beta'        (odd  = excluded)
 *   'alpha --beta'   ->  'alpha' & !!'beta'       (even = identity)
 *
 * and `--beta` matches a document containing "beta" exactly as `beta` does,
 * because double negation is identity. So collapsing N hyphens to `N % 2`
 * leaves every query meaning precisely what Postgres would have computed,
 * while bounding nesting depth at one. Exclusions keep working; the crash
 * becomes unreachable.
 *
 * Only runs that START a token are touched. A mid-token hyphen is part of a
 * compound, never an operator, so `fastify-plugin`, `INC-2203` and
 * `CVE-2024-1234` pass through untouched and match as they always did.
 *
 * KNOWN, ACCEPTED CONSEQUENCE (owner decision on #1110, option "yes,
 * everywhere"): because `-term` really is an exclusion now, shell commands
 * inside questions misfire. `docker run -it ubuntu bash` compiles to
 * `& !'it'`, and under the default `simple` configuration `it` is not a
 * stop word, so the query demands pages WITHOUT the word "it". The same
 * applies to `curl -X POST`, `grep -r pattern` and prose ranges like
 * `errors between 500 - 599` (-> `& !'599'`). This was measured and
 * accepted rather than discovered: the mitigation is user-facing
 * documentation, not code. Revisit if support traffic says otherwise.
 */
export function sanitizeLexicalQuery(query: string): string {
  // `(^|\s)(-+)` — a hyphen run at a token start only. Mid-token hyphens
  // (the compound case) never match, which is the point.
  return query.replace(/(^|\s)(-+)/g, (_m, lead: string, dashes: string) =>
    `${lead}${dashes.length % 2 === 1 ? '-' : ''}`,
  );
}
