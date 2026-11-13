/**
 * ADR-027 D11/D12 — the ONE reader of a derived chunk's provenance, and the
 * ONE `(pageId, attachment_source, attachment_key)` dedup/ordering both the
 * answer path (`llm-ask.ts`'s `kind: 'image'` sources) and the answer-time
 * byte pick (`retrieved-images.ts`) consume.
 *
 * Provenance lives in `page_embeddings.metadata` and NOWHERE else (D9.4:
 * "nothing downstream may infer provenance from anything but
 * `metadata.source`"). That is also what keeps the retrieval path independent
 * of `page_image_analyses`: #1617 never joins the analysis table, so a
 * revoked, re-pended or swept analysis row cannot change what a citation says
 * about the chunk the model actually read.
 *
 * The reader is TOTAL and STRICT: a row whose metadata is missing a field, or
 * carries the wrong type for one, yields `undefined` rather than a partial
 * object. D12 requires the four citation fields to travel together or not at
 * all, and a half-populated provenance object is exactly how one of them
 * would travel alone — so the validity decision is made once, here, where the
 * JSON is first touched.
 */
import { logger } from '../../../core/utils/logger.js';
import { buildPageImageUrl } from '../../../core/services/image-references.js';
import { createPageIdentityReader, type PageIdentity, type PageIdentityReader } from './page-identity.js';

/**
 * `metadata->>'source'` for a derived chunk (D9.4). Spelled once and shared
 * by the lexical union, the provenance reader and the byte pick; migration
 * 116's `page_embeddings_derived_idx` and 117's partial GIN both key on it.
 */
export const IMAGE_ANALYSIS_CHUNK_SOURCE = 'image_analysis';

/** The D9.4 provenance of a derived chunk, as `SearchResult.derived`. */
export interface DerivedProvenance {
  /** Which attachment store holds the bytes — the `buildPageImageUrl` prefix. */
  attachmentSource: 'confluence' | 'local';
  /** The on-disk filename (`page_image_analyses.attachment_key`). */
  attachmentKey: string;
  /** D6's revision token: the hash of the bytes this description was made from. */
  contentHash: string;
  /** `page_image_analyses.id` — provenance only; nothing re-reads that table. */
  analysisId: number;
  /** D8's payload schema version, carried onto the citation (D12). */
  analysisVersion: number;
  /** 1-based part of a multi-part serialization, and how many parts there are. */
  part: number;
  parts: number;
}

function isFiniteInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * `page_embeddings.metadata` → {@link DerivedProvenance}, or `undefined` for
 * an authored chunk and for any row that does not carry the whole shape.
 */
export function readDerivedProvenance(metadata: unknown): DerivedProvenance | undefined {
  if (typeof metadata !== 'object' || metadata === null) return undefined;
  const m = metadata as Record<string, unknown>;
  if (m.source !== IMAGE_ANALYSIS_CHUNK_SOURCE) return undefined;
  const store = m.attachment_source;
  if (store !== 'confluence' && store !== 'local') return undefined;
  if (!nonEmptyString(m.attachment_key)) return undefined;
  if (!nonEmptyString(m.content_hash)) return undefined;
  if (!isFiniteInt(m.analysis_id)) return undefined;
  if (!isFiniteInt(m.analysis_version)) return undefined;
  if (!isFiniteInt(m.part) || !isFiniteInt(m.parts)) return undefined;
  return {
    attachmentSource: store,
    attachmentKey: m.attachment_key,
    contentHash: m.content_hash,
    analysisId: m.analysis_id,
    analysisVersion: m.analysis_version,
    part: m.part,
    parts: m.parts,
  };
}

/** The part of a `SearchResult` the two consumers below actually read. */
export interface DerivedCarrier {
  pageId: number;
  pageTitle?: string;
  spaceKey?: string | null;
  /**
   * The row's `score`, copied onto the image unchanged and never sorted on:
   * the row's position in the array is its rank (#1716).
   */
  score?: number;
  derived?: DerivedProvenance;
}

/** One distinct image among a result set's derived rows, best row first. */
export interface DerivedImage {
  pageId: number;
  pageTitle: string;
  spaceKey: string | null;
  derived: DerivedProvenance;
  /** The carrying row's `score`, unchanged — never the rank, never a cross-modal measure. */
  score: number;
  /** The carrying row's index in the input array: the image's rank, lower first (#1716). */
  position: number;
}

/**
 * The answer's derived rows reduced to DISTINCT `(pageId, attachment_source,
 * attachment_key)` images, best final result order first (array position;
 * reranking and identifier pins included) — ADR-027 D12 as amended by #1716.
 *
 * The array order is the pipeline's verdict (`SearchResult`'s contract in
 * `rag-service.ts`): reranking, the ranking prior, MMR and the identifier
 * pins all reorder rows whose fused `score` no longer describes that order,
 * and a new pin carries `score: 0` at the head. So `score` is carried onto the
 * image and never sorted on. There is still **no cross-modal score** (ADR-027
 * D12): a derived chunk was found by the text legs, and its citation's
 * `similarity` stays null.
 *
 * After the position come `part` (an earlier part is the head of the
 * description the reranker saw), the page id and `attachmentKey`, retained so
 * the comparator is total on its own keys. A row carries at most one
 * `derived`, so two entries never share a position and those keys do not
 * decide on today's input: the order is a pure function of `rows`, and two
 * identical requests cite the same pictures in the same order.
 *
 * Dedup rather than distinct-by-construction because one image can legitimately
 * arrive twice: a multi-part serialization puts several chunks of the SAME
 * picture in the index, and both can survive into top-K on a wide fetch. The
 * EARLIER row is kept — its provenance and its `score`.
 */
export function distinctDerivedImages(rows: readonly DerivedCarrier[]): DerivedImage[] {
  const out: DerivedImage[] = [];
  const seen = new Set<string>();
  const ordered = rows
    .flatMap((row, position) => (row.derived ? [{ row, derived: row.derived, position }] : []))
    .sort((a, b) => {
      const byPosition = a.position - b.position;
      if (byPosition !== 0) return byPosition;
      const byPart = a.derived.part - b.derived.part;
      if (byPart !== 0) return byPart;
      const byPage = a.row.pageId - b.row.pageId;
      if (byPage !== 0) return byPage;
      return a.derived.attachmentKey < b.derived.attachmentKey
        ? -1
        : a.derived.attachmentKey > b.derived.attachmentKey
          ? 1
          : 0;
    });
  for (const { row, derived, position } of ordered) {
    const key = `${row.pageId}\u0000${derived.attachmentSource}\u0000${derived.attachmentKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      pageId: row.pageId,
      pageTitle: row.pageTitle ?? '',
      spaceKey: row.spaceKey ?? null,
      derived,
      score: row.score ?? 0,
      position,
    });
  }
  return out;
}

/** A `kind: 'image'` citation entry (D12), as `llm-ask.ts` appends it. */
export interface DerivedImageSource {
  kind: 'image';
  pageId: number;
  pageTitle: string;
  spaceKey: string | null;
  attachmentUrl: string;
  attachmentStore: 'confluence' | 'local';
  attachmentKey: string;
  contentHash: string;
  analysisVersion: number;
  /** Always null: there is no cross-modal score to fabricate (D12). */
  similarity: null;
  /**
   * The carrying row's `score`, unchanged, like every other entry's `score` —
   * never this image's rank: image entries follow the final result order (#1716).
   */
  score: number;
}

/**
 * The D12 image citations for an answer's top-K rows, capped at `max`.
 *
 * `attachmentUrl` needs three columns a `SearchResult` does not carry
 * (`pages.source`, `pages.confluence_id`, `pages.id`) — inferring the store
 * tree from `confluence_id IS NULL` is the rule `attachment-store.ts`
 * documents as wrong — so this takes ONE batched identity read over the
 * distinct pages that actually have derived rows. No visibility predicate: the
 * rows arrive from retrieval, which applied `ragRetrievalPagesPredicate` and the EE
 * per-page filter before any derived text was read (D14), and a second
 * predicate here would be a second place for that rule to drift.
 *
 * `identities` is the request's shared reader: `/llm/ask` hands the SAME one
 * to this and to `pickRetrievedImages`, so the two steps take one read
 * between them rather than two identical ones (review r1 finding 7). A
 * caller with nothing to share gets its own.
 *
 * A page whose identity row has vanished (deleted between retrieval and here)
 * contributes no image entry — its page source still carries the evidence.
 * A failing read is the same answer for the whole set rather than a thrown
 * error: this runs on the request path BEFORE the SSE headers are written, so
 * a transient DB fault here would turn a perfectly answerable turn into a
 * 500. The page sources are built from the search results and need nothing
 * from this table.
 */
export async function buildDerivedImageSources(
  rows: readonly DerivedCarrier[],
  max: number,
  identities: PageIdentityReader = createPageIdentityReader(),
): Promise<DerivedImageSource[]> {
  if (max <= 0) return [];
  const images = distinctDerivedImages(rows);
  if (images.length === 0) return [];
  const pageIds = [...new Set(images.map((i) => i.pageId))];
  let byId: Map<number, PageIdentity>;
  try {
    byId = await identities.load(pageIds);
  } catch (err) {
    logger.warn({ err }, 'ADR-027 D12: could not resolve page identities for image citations — omitting them');
    return [];
  }
  const out: DerivedImageSource[] = [];
  for (const image of images) {
    if (out.length >= max) break;
    const identity = byId.get(image.pageId);
    if (!identity) continue;
    out.push({
      kind: 'image',
      pageId: image.pageId,
      pageTitle: image.pageTitle,
      spaceKey: image.spaceKey,
      attachmentUrl: buildPageImageUrl({
        pageId: identity.id,
        pageSource: identity.source,
        confluenceId: identity.confluence_id,
        source: image.derived.attachmentSource,
        key: image.derived.attachmentKey,
      }),
      attachmentStore: image.derived.attachmentSource,
      attachmentKey: image.derived.attachmentKey,
      contentHash: image.derived.contentHash,
      analysisVersion: image.derived.analysisVersion,
      similarity: null,
      score: image.score,
    });
  }
  return out;
}
