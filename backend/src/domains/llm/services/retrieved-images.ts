/**
 * #1115 P4 — pick, load and validate the retrieved images the chat model is
 * shown.
 *
 * P3 made pictures RETRIEVABLE: the image leg ranks pages by what their
 * images look like, and `/llm/ask` puts the matched ones on the wire as
 * `kind: 'image'` sources so a reader can open them. What it deliberately did
 * NOT do is show them to the model — an image-only page's grounding was its
 * synthesised title. This module is the other half: it turns the hits riding
 * on the returned `SearchResult`s into `image_url` content parts.
 *
 * ── Why it is a domains/llm service and not a few lines in the route ──────
 *
 * `resolveAttachmentBytes` is the SYSTEM reader — no page visibility, no space
 * RBAC, no per-page ACE (`core/services/attachment-store.ts`) — and
 * `attachment-store.test.ts` walks `src/routes` and fails if any file there so
 * much as names it. That guard is not a formality this module routes around:
 * it is the reason the pick lives behind a service boundary at all. The read
 * is only safe because retrieval has ALREADY applied the visibility predicate
 * to the pages it returned (`visiblePagesPredicate` in the kNN and both text
 * legs, plus the EE per-page filter over the fused set), and this function's
 * whole input is that post-ACL set. It reads bytes for a page the caller was
 * handed; it must never be given a page id from a request.
 *
 * So the sanctioned-caller list is enforced structurally rather than by name:
 * the guard bans the route tree, and the route calls this. Nothing was added
 * to an allow-list, because there is no allow-list to add to — the mechanism
 * is a walk over `src/routes`, and a service in `domains/llm` is outside it by
 * construction. A future caller that wants these bytes should reach this
 * function, not `attachment-store` directly.
 *
 * ── Round-robin, not best-first ───────────────────────────────────────────
 *
 * A plain best-first sort over the flattened hits is the obvious
 * implementation and it is wrong: a page carrying three near-identical
 * screenshots would take every slot at the default cap of 2, and the second
 * page — the one whose single picture matched almost as well — would never be
 * shown. That is image COUNT beating image BREADTH, the same head dilution
 * `MAX_IMAGE_HITS_PER_PAGE` bounds inside a page and `#1106`'s best-chunk-only
 * fusion bounds inside a leg. So selection proceeds in ROUNDS: round 0 is
 * every page's best image, ordered among themselves by the hit's own
 * similarity; round 1 is every page's second-best; and so on. A page gets a
 * second slot only once every page with hits has had a first.
 *
 * ── Zero HTTP ─────────────────────────────────────────────────────────────
 *
 * The bytes come off disk. There is no download, no resize (ADR-025 D10
 * settled that), and no provider call — the only network cost of this step is
 * the larger completion request it produces, which is exactly what the byte
 * budget below bounds.
 */

import { createHash } from 'crypto';
import { query } from '../../../core/db/postgres.js';
import { logger } from '../../../core/utils/logger.js';
import {
  resolveAttachmentBytes,
  type AttachmentStoreSource,
} from '../../../core/services/attachment-store.js';
import { validateImage } from '../../../core/services/image-validator.js';
import type { PageSource } from '@compendiq/contracts';
import type { ChatContentPart } from './prompts.js';
import type { ImageHit } from './image-leg-search.js';

/**
 * Ceiling on the base64 an answer's retrieved images may add to one chat
 * request. 6 MB.
 *
 * **A constant, not an admin knob, and the difference is deliberate.**
 * `rag_answer_max_images` is a COUNT, which is a thing an operator can reason
 * about ("show the model at most two pictures"). A byte budget is not: it
 * depends on what the corpus happens to hold, and the operator has no way to
 * measure the right value or to notice when they have picked a wrong one —
 * the symptom of a too-high one is a provider timing out on a request nobody
 * can see the size of. So the count is theirs and the bound is ours.
 *
 * The number is the backpressure bound for a path that BYPASSES the queue's
 * own sizing by design: `streamChat` wraps the call in the shared LLM queue
 * and the per-provider breaker, but neither of those weighs a request, so a
 * cap of 8 against `MAX_IMAGE_BYTES` (5 MB) would admit 40 MB of raw bytes —
 * ~55 MB base64 — into a single prompt and, at `LLM_CONCURRENCY` 4, four of
 * those in flight at once. 6 MB is roughly one `MAX_IMAGE_BYTES` image at
 * base64's ~1.37x inflation, which is what the intake cap already lets into
 * the index, plus room for the ordinary case of several small screenshots.
 * Reaching it is a skip-and-count, never an error: the answer still runs, with
 * fewer pictures.
 */
export const RETRIEVED_IMAGES_BYTE_BUDGET = 6 * 1024 * 1024;

/**
 * The shape this module needs off a `SearchResult` — its page id and the
 * image hits P3 attached to it.
 *
 * Structural rather than the imported `SearchResult`, because everything else
 * on that interface is about ranking and none of it belongs to this decision;
 * a narrow input is also what lets the tests build one by hand.
 */
export interface RetrievedImagePage {
  pageId: number;
  imageHits?: ImageHit[];
}

/** One image that really was sent, as the audit and the cache key read it. */
export interface RetrievedImageUse {
  pageId: number;
  source: AttachmentStoreSource;
  attachmentKey: string;
  /** RAW bytes on disk, not the base64 length. */
  bytes: number;
}

export interface RetrievedImagesSkipped {
  /** No page identity, or no such file in the store the hit names. */
  missing: number;
  /** Bytes a vision encoder cannot read, or past a #1154 ceiling. */
  invalid: number;
  /**
   * The image that would have taken the request past
   * {@link RETRIEVED_IMAGES_BYTE_BUDGET}.
   *
   * At most 1, and that is the point rather than a limitation: the loop stops
   * at the first image that does not fit, so counting the rest would mean
   * reading bytes precisely to decide not to use them. It reads "at least one
   * picture was dropped for size", which is the operational fact.
   */
  overBudget: number;
}

export interface RetrievedImagesPick {
  /** In send order — the same order as {@link RetrievedImagesPick.used}. */
  parts: ChatContentPart[];
  used: RetrievedImageUse[];
  skipped: RetrievedImagesSkipped;
}

const EMPTY: RetrievedImagesPick = {
  parts: [],
  used: [],
  skipped: { missing: 0, invalid: 0, overBudget: 0 },
};

interface Candidate {
  pageId: number;
  source: AttachmentStoreSource;
  key: string;
  similarity: number;
}

/**
 * Flatten the pages' hits into one round-robin candidate list — see the
 * module docstring for why the obvious flat sort is wrong.
 */
export function orderRetrievedImageCandidates(pages: RetrievedImagePage[]): Candidate[] {
  const perPage = pages
    .map((p) => ({
      pageId: p.pageId,
      // Defensive: P3 already emits these best-first, but this function's
      // contract is "best image per page", and a producer that stopped
      // sorting would silently degrade it into "first image per page".
      hits: [...(p.imageHits ?? [])].sort((a, b) => b.similarity - a.similarity),
    }))
    .filter((p) => p.hits.length > 0);

  const deepest = perPage.reduce((n, p) => Math.max(n, p.hits.length), 0);
  const ordered: Candidate[] = [];
  for (let round = 0; round < deepest; round++) {
    const thisRound: Candidate[] = [];
    for (const p of perPage) {
      const h = p.hits[round];
      if (!h) continue;
      thisRound.push({ pageId: p.pageId, source: h.source, key: h.key, similarity: h.similarity });
    }
    thisRound.sort((a, b) => b.similarity - a.similarity);
    ordered.push(...thisRound);
  }
  return ordered;
}

interface PageIdentityRow {
  id: number;
  confluence_id: string | null;
  source: PageSource;
}

/**
 * Load, validate and encode up to `max` of the images the image leg matched
 * on the pages that ground this answer.
 *
 * Never throws: an answer must not fail because a picture could not be read.
 * Every refusal is a skip with a counter, and the caller answers text-only —
 * which is the same thing it does when the model cannot see images at all
 * (ADR-025 D8: text-only and UNQUALIFIED, no degradation copy).
 */
export async function pickRetrievedImages(
  pages: RetrievedImagePage[],
  opts: { max: number; byteBudget?: number },
): Promise<RetrievedImagesPick> {
  const max = Math.floor(opts.max);
  if (!Number.isFinite(max) || max <= 0) return EMPTY;

  const candidates = orderRetrievedImageCandidates(pages);
  if (candidates.length === 0) return EMPTY;

  // ONE identity lookup for every candidate page, before any byte is read.
  // `pages.source` is why it exists: `resolveAttachmentBytes` requires it and
  // refuses to infer it, because `confluenceId ?? pageId` names a DIFFERENT
  // page's directory for a standalone row that carries a Confluence id.
  const pageIds = [...new Set(candidates.map((c) => c.pageId))];
  let identities: Map<number, PageIdentityRow>;
  try {
    const res = await query<PageIdentityRow>(
      `SELECT id, confluence_id, source FROM pages WHERE id = ANY($1::int[])`,
      [pageIds],
    );
    identities = new Map(res.rows.map((r) => [r.id, r]));
  } catch (err) {
    // A failed lookup is a text-only answer, not a failed answer. The images
    // still reach the reader as sources — that list is built from the search
    // results and needs nothing from this table.
    logger.warn({ err }, '#1115 P4: could not resolve page identities for retrieved images');
    return EMPTY;
  }

  const budget = opts.byteBudget ?? RETRIEVED_IMAGES_BYTE_BUDGET;
  const parts: ChatContentPart[] = [];
  const used: RetrievedImageUse[] = [];
  const skipped: RetrievedImagesSkipped = { missing: 0, invalid: 0, overBudget: 0 };
  let base64Total = 0;

  for (const candidate of candidates) {
    if (used.length >= max) break;

    const identity = identities.get(candidate.pageId);
    if (!identity) {
      skipped.missing++;
      continue;
    }

    const resolved = await resolveAttachmentBytes({
      pageId: identity.id,
      confluenceId: identity.confluence_id,
      pageSource: identity.source,
      source: candidate.source,
      key: candidate.key,
    });
    if (!resolved) {
      skipped.missing++;
      continue;
    }

    let format;
    try {
      // The #1154 gate, unforked — format sniff, `MAX_IMAGE_BYTES`,
      // `MAX_IMAGE_DIMENSION`. A corpus image is not a more trusted input
      // than an upload; it is a LESS trusted one, since nobody chose to send
      // it and the ceilings are what keep a 40 MB scan out of a prompt.
      //
      // The filename is deliberately NOT passed. `validateImage`'s extension
      // check is an intake signal — "the client claims .png and the bytes are
      // JPEG" is worth refusing from an uploader making a claim — and here
      // nobody is claiming anything: the name is whatever Confluence called
      // the file, a mismatch is a badly-named attachment rather than a lie,
      // and P2's intake gate admitted it into the index on the sniffed format
      // alone. Refusing it here would drop a picture the leg ranked while the
      // index says it is fine.
      ({ format } = validateImage(resolved.bytes, undefined));
    } catch {
      skipped.invalid++;
      continue;
    }

    const base64 = resolved.bytes.toString('base64');
    if (base64Total + base64.length > budget) {
      // Stop rather than skip-and-continue: every further candidate costs a
      // disk read to reach the same verdict, and the request is already at
      // the size this bound exists to hold it to.
      skipped.overBudget++;
      break;
    }
    base64Total += base64.length;

    parts.push({ type: 'image_url', image_url: { url: `data:image/${format};base64,${base64}` } });
    used.push({
      pageId: candidate.pageId,
      source: candidate.source,
      attachmentKey: candidate.key,
      bytes: resolved.bytes.length,
    });
  }

  return { parts, used, skipped };
}

/**
 * A stable, short identity for "these images, in this order" — the component
 * the answer cache key needs (#1115 P4).
 *
 * The cache is keyed on the retrieved doc ids, which say which PAGES ground
 * the answer and nothing about whether the model could SEE them. Without this
 * a vision-capable model's image-augmented answer and a text-only model's
 * answer to the same question over the same pages share one key and serve each
 * other for the TTL — and so do the same model's answers either side of an
 * admin moving the cap, or of an image being deleted from a page.
 *
 * The keys are hashed rather than concatenated because an attachment filename
 * is free-form user content and the cache key is a Redis key.
 */
export function retrievedImagesCacheComponent(used: RetrievedImageUse[]): string | undefined {
  if (used.length === 0) return undefined;
  const canonical = used.map((u) => `${u.pageId}:${u.source}:${u.attachmentKey}:${u.bytes}`).join('|');
  return `${used.length}-${createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`;
}
