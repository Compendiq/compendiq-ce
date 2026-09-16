/**
 * The `(id, confluence_id, source)` triple `buildPageImageUrl` and
 * `resolveAttachmentBytes` need, read ONCE per request.
 *
 * Two steps of `/llm/ask` want it over overlapping page sets: the D12 citation
 * append (`derived-provenance.ts`) and the answer-time byte pick
 * (`retrieved-images.ts`). Both used to take their own
 * `SELECT id, confluence_id, source FROM pages WHERE id = ANY($1::int[])` —
 * two identical reads on one request (review r1 finding 7). This is that read,
 * memoized per instance: the caller builds one reader and hands it to both.
 *
 * **No visibility predicate, deliberately.** The page ids arrive from
 * retrieval, which applied `visiblePagesPredicate` and the EE per-page filter
 * before any derived text was read (ADR-027 D14); a second predicate here
 * would be a second place for that rule to drift. A reader must therefore
 * never be given a page id that came from a request.
 *
 * Absence is cached too — a page deleted between retrieval and here is
 * answered `undefined` without a second round trip. A FAILED read is not
 * cached: it throws to the caller (both of which soft-fail in their own way,
 * because one of them must not turn an answerable turn into a 500), and the
 * next `load` retries.
 */
import { query } from '../../../core/db/postgres.js';
import type { PageSource } from '@compendiq/contracts';

export interface PageIdentity {
  id: number;
  confluence_id: string | null;
  source: PageSource;
}

export interface PageIdentityReader {
  /**
   * The identities of `pageIds`, querying only the ones not already known.
   * A page with no row is absent from the map.
   */
  load(pageIds: readonly number[]): Promise<Map<number, PageIdentity>>;
}

/** One reader per request. Never module-level: the cache must not outlive it. */
export function createPageIdentityReader(): PageIdentityReader {
  const known = new Map<number, PageIdentity>();
  const resolved = new Set<number>();
  return {
    async load(pageIds) {
      const missing = [...new Set(pageIds)].filter((id) => !resolved.has(id));
      if (missing.length > 0) {
        const res = await query<PageIdentity>(
          `SELECT id, confluence_id, source FROM pages WHERE id = ANY($1::int[])`,
          [missing],
        );
        for (const row of res.rows) known.set(row.id, row);
        // AFTER the query, so a throw leaves nothing marked resolved.
        for (const id of missing) resolved.add(id);
      }
      const out = new Map<number, PageIdentity>();
      for (const id of pageIds) {
        const row = known.get(id);
        if (row) out.set(id, row);
      }
      return out;
    },
  };
}
