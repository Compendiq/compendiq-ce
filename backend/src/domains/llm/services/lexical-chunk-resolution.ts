/**
 * ADR-027 D10, query-time half (#1617) — the SQL the lexical leg and the
 * #1107 exact-identifier pin share: the derived candidate arm of the page
 * union, and the per-page `LATERAL` that resolves a page hit to the CHUNK
 * that matched.
 *
 * Before this, every keyword and pin row carried `substring(body_text, 1,
 * 500)` — a page PREFIX. An OCR-only hit therefore reranked and cited text
 * that did not contain the match, and so did an authored hit deep in a long
 * page. D10 replaces the prefix with the matched chunk for **every** lexical
 * hit, authored included, which is why #1617 lands it as its own measured
 * change (#1619 attributes it).
 *
 * Three rules from the ADR are encoded here and nowhere else:
 *
 *  1. **`pages.tsv` is not touched** (`:4265-4267`). Authored page ranking is
 *     bit-identical to today's; the derived arm only ADDS pages and can only
 *     RAISE a rank through `GREATEST`.
 *  2. **Authored chunks do not contribute to a page's rank** (`:4272-4273`) —
 *     that would double-count `pages.tsv`. {@link derivedRankArmSql} selects
 *     derived rows only. Authored chunks take part in resolution alone.
 *  3. **One page, one vote** (`:4280-4282`). The derived arm is
 *     `MAX(ts_rank(...)) GROUP BY page_id`, so a page with five matching
 *     images is one candidate at one rank — no third RRF leg, no inflated
 *     page count.
 *
 * And one security rule, D14 (`:4536-4538`): the derived arm is the one NEW
 * place a lexical candidate can enter, so it joins `pages` and carries the
 * same `visiblePagesPredicate` the authored arm does. It reads
 * `page_embeddings` — derived TEXT — so the predicate must be inside the
 * query, not applied to its output.
 */
import type { LexicalParser } from '../../../core/utils/lexical-query.js';
import type { FtsLanguage } from '@compendiq/contracts';
import {
  IMAGE_ANALYSIS_CHUNK_SOURCE,
  readDerivedProvenance,
  type DerivedProvenance,
} from './derived-provenance.js';

/**
 * The `tsquery` expression, built from a parser chosen per query
 * (`chooseLexicalParser`) and the configured FTS configuration.
 *
 * Both halves are interpolated and both are closed sets: `LexicalParser` is a
 * two-member union of literals from `lexical-query.ts`, and `FtsLanguage` is
 * the contracts enum `fts-language.ts` re-narrows on read (Postgres has no
 * bind-parameter form for a `regconfig`). The user's text is the BOUND
 * parameter `$<textParam>` and never reaches the string.
 */
export function lexicalTsQuery(parser: LexicalParser, language: FtsLanguage, textParam: number): string {
  return `${parser}('${language}', $${textParam})`;
}

/**
 * The derived half of the page candidate union (D10): pages holding a DERIVED
 * chunk whose `chunk_tsv` matches, each at `MAX(ts_rank(...))`.
 *
 * Shaped to `UNION ALL` with the authored arm and be collapsed by an outer
 * `MAX(rank) GROUP BY page_id` — which is the `GREATEST(ts_rank(pages.tsv,q),
 * MAX(ts_rank(derived.chunk_tsv,q)))` the ADR specifies, expressed so a page
 * present in only one arm needs no `coalesce`.
 *
 * `visibility` is the caller's `visiblePagesPredicate(...)` over alias `cp`
 * and `extraPageFilter` its optional space narrowing — the same fragments the
 * authored arm binds, at the same parameter indexes, so the two arms cannot
 * drift apart (D14).
 */
export function derivedRankArmSql(
  tsQuery: string,
  visibility: string,
  extraPageFilter = '',
): string {
  return `SELECT pe.page_id AS page_id, MAX(ts_rank(pe.chunk_tsv, ${tsQuery})) AS rank
            FROM page_embeddings pe
            JOIN pages cp ON cp.id = pe.page_id
           WHERE pe.chunk_tsv @@ ${tsQuery}
             AND (pe.metadata->>'source') = '${IMAGE_ANALYSIS_CHUNK_SOURCE}'
             AND ${visibility}
             AND cp.deleted_at IS NULL${extraPageFilter}
           GROUP BY pe.page_id`;
}

/**
 * The per-page chunk resolution (D10 `:4274-4279`), as a `LEFT JOIN LATERAL`
 * over the matched page's chunks:
 *
 *   ORDER BY (chunk_tsv @@ q) DESC, ts_rank(chunk_tsv, q) DESC, chunk_index ASC
 *   LIMIT 1
 *
 * A matching chunk wins; among matches the best-ranked one; the
 * `chunk_index ASC` tiebreak makes a TITLE-only match resolve to chunk 0 and
 * makes the choice deterministic between two identical requests. `LEFT` so a
 * page with no chunks at all (not yet embedded) still comes back — its
 * `chunk_*` columns are NULL and the caller falls back to the body prefix,
 * the only place that prefix survives.
 *
 * `chunk_matched` is returned because the two callers need different things
 * from it: the keyword leg takes the resolved chunk unconditionally, while the
 * pin adopts it only on a real `@@` hit (ADR-027 erratum #1617/Q1).
 */
export function bestChunkLateralSql(tsQuery: string, alias = 'best', pageAlias = 'cp'): string {
  return `LEFT JOIN LATERAL (
            SELECT pe.chunk_text, pe.chunk_index, pe.metadata,
                   pe.chunk_tsv @@ ${tsQuery} AS chunk_matched
              FROM page_embeddings pe
             WHERE pe.page_id = ${pageAlias}.id
             ORDER BY (pe.chunk_tsv @@ ${tsQuery}) DESC,
                      ts_rank(pe.chunk_tsv, ${tsQuery}) DESC,
                      pe.chunk_index ASC
             LIMIT 1
          ) ${alias} ON TRUE`;
}

/**
 * The columns {@link bestChunkLateralSql} adds to a row.
 *
 * All four are nullable in the same breath: the `LEFT JOIN LATERAL` answers
 * NULL for a page with no chunk rows, and that is the one case the body-prefix
 * fallback exists for. `?` as well as `| null` because a caller that has not
 * selected the lateral at all (a unit test, a future narrow query) must land
 * on the fallback rather than on `undefined` as a chunk text.
 */
export interface BestChunkColumns {
  chunk_text?: string | null;
  chunk_index?: number | null;
  metadata?: unknown;
  chunk_matched?: boolean | null;
}

/** What a lexical row carries once its chunk is resolved. */
export interface ResolvedLexicalChunk {
  chunkText: string;
  /** Absent only when the page has no chunk rows, or the caller declined the swap. */
  chunkIndex?: number;
  sectionTitle: string;
  derived?: DerivedProvenance;
}

/**
 * The resolved chunk, or the caller's fallback text.
 *
 * `adopt` is the Q1 gate: `'always'` for the keyword leg (D10's rule as
 * written) and `'on-match'` for the pin, which keeps its
 * `rag_context_chars_per_page`-sized lede (#1273 F9) unless a chunk really
 * matched the identifier. Declining the swap declines `chunkIndex` with it —
 * sibling assembly must not anchor a window on a chunk retrieval did not
 * pick.
 *
 * `sectionTitle` follows the chunk: for a derived row that is #1616's
 * `[Image: <key> — <kind>]` label, which is the provenance line
 * `buildRagContext` shows the model. It falls back to the page title, which
 * is what a keyword row has always carried.
 */
export function resolveLexicalChunk(
  row: BestChunkColumns,
  fallback: { text: string; sectionTitle: string },
  adopt: 'always' | 'on-match' = 'always',
): ResolvedLexicalChunk {
  const usable =
    row.chunk_text != null
    && row.chunk_index != null
    && (adopt === 'always' || row.chunk_matched === true);
  if (!usable) {
    return { chunkText: fallback.text, sectionTitle: fallback.sectionTitle };
  }
  const metadata = (typeof row.metadata === 'object' && row.metadata !== null
    ? (row.metadata as Record<string, unknown>)
    : {});
  const sectionTitle = typeof metadata.section_title === 'string' && metadata.section_title.length > 0
    ? metadata.section_title
    : fallback.sectionTitle;
  const derived = readDerivedProvenance(row.metadata);
  return {
    chunkText: row.chunk_text!,
    chunkIndex: row.chunk_index!,
    sectionTitle,
    ...(derived ? { derived } : {}),
  };
}
