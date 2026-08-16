/**
 * The destructive-database guard, shared by every eval-rig entrypoint.
 *
 * It began as a private helper inside `scripts/run-retrieval-eval.ts`, below
 * that file's top-level `main()` call — so a second script could not import it
 * without running a full destructive eval as a side effect. #1114's latency
 * benchmark needs the same protection, and a second copy of a refusal rule is
 * how two copies drift apart.
 *
 * The comments below are the original reasoning, kept verbatim because they
 * record decisions that were reached the hard way.
 */

/**
 * Substring, not token-delimited (review r4): the refusal tells the operator to
 * use a name containing "eval" or "test", and the first version then refused
 * `test`, `testdb` and `eval-db` with that very message — a loop whose only
 * exit was the blanket override, which is the wrong habit to teach for a
 * destructive script. Widening admits `production_eval`, so the production
 * words are refused outright and win over the allow-list.
 */
export const DISPOSABLE_DB_PATTERN = /eval|test|scratch|sandbox/i;
export const NEVER_DISPOSABLE_PATTERN = /prod|live|main|staging/i;

/**
 * Refuse a database that does not look disposable.
 *
 * The eval rig is DESTRUCTIVE: it truncates pages, page_embeddings,
 * page_relationships and search_analytics, retypes the vector columns and
 * rewrites admin_settings — against whatever POSTGRES_URL names. Prose in a
 * runbook is not a safeguard (review r3), so the database has to opt in by
 * name or by an explicit override.
 *
 * The allow-list is on the DATABASE name rather than the host: a colleague's
 * laptop, a staging box and production all differ in host but the fatal
 * mistake is pointing this at a database that holds real pages.
 */
export function assertDisposableDatabase(url: string): void {
  if (process.env.EVAL_ALLOW_DESTRUCTIVE === 'yes-wipe-this-database') return;

  let dbName: string;
  try {
    dbName = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  } catch {
    throw new Error('POSTGRES_URL is not a valid URL — refusing to run a destructive eval against it');
  }

  if (!DISPOSABLE_DB_PATTERN.test(dbName) || NEVER_DISPOSABLE_PATTERN.test(dbName)) {
    throw new Error(
      `Refusing to run: this script TRUNCATES pages, page_embeddings, page_relationships and ` +
        `search_analytics and RETYPES the vector columns, and "${dbName}" does not look disposable. ` +
        `Its name must contain "eval", "test", "scratch" or "sandbox", and must not contain ` +
        `"prod", "live", "main" or "staging". Point POSTGRES_URL at a throwaway database, or set ` +
        `EVAL_ALLOW_DESTRUCTIVE=yes-wipe-this-database if you genuinely mean this one.`,
    );
  }
}
