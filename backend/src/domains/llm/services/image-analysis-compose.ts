/**
 * ADR-027 D9 — what `embedPage` composes AFTER its authored chunks: the page's
 * currently VALID image analyses, serialized with the page's current context.
 *
 * The read takes the page's `image_analysis_revision` (the D6.3 token
 * `embedPage` compares before clearing `embedding_dirty`) and the rows that
 * pass D5's validity predicate under the retained identity (D7) in one
 * query. A re-assign or a sweep landing between the identity read and this
 * one cannot pair stale rows with a fresh revision: the sweep bumps the
 * revision when it re-pends, so the mismatch leaves the page dirty for a
 * recompose. Ordered by `(source, attachment_key)`, not body order: stable
 * across re-embeds and reconciles; retrieval does not depend on it.
 *
 * `embedPage` never calls the vision model: a text-model change re-embeds
 * these cached descriptions with zero vision calls (D9.8), and a title,
 * caption or heading edit is an ordinary recompose that touches no
 * `page_image_analyses` row (D9.9).
 */
import { query } from '../../../core/db/postgres.js';
import { extractImageReferencesFromHtml } from '../../../core/services/image-references.js';
import { getRetainedImageAnalysisIdentity, type ImageAnalysisPayload } from './image-analysis-provider.js';
import { serializeImageAnalysis, substantiveChars } from './image-analysis-serialize.js';
import { imageAnalysisStorePresent, validityParamValues, validitySql } from './image-analysis-validity.js';

/** The authored `ChunkMetadata` fields, restated: `core` owns no chunk type. */
export interface AuthoredChunkContext {
  page_title: string;
  space_key: string;
  confluence_id: string;
}

/**
 * D9.4: the authored fields (`section_title` = the `[Image: …]` label) plus
 * provenance. Nothing downstream may infer provenance from anything but
 * `source`.
 */
export interface DerivedChunkMetadata extends AuthoredChunkContext {
  section_title: string;
  source: 'image_analysis';
  attachment_source: 'confluence' | 'local';
  attachment_key: string;
  content_hash: string;
  analysis_id: number;
  analysis_version: number;
  part: number;
  parts: number;
}

export interface DerivedChunkPlan {
  text: string;
  metadata: DerivedChunkMetadata;
}

export interface DerivedComposition {
  /** `pages.image_analysis_revision` at the read; `embedPage` clears `embedding_dirty` only if unchanged. */
  revision: number;
  chunks: DerivedChunkPlan[];
  /** Σ of D8's substantive length over the composed rows, for the D9.5 floor. */
  substantiveChars: number;
}

interface CompositionRow {
  revision: string;
  rows:
    | Array<{
        id: number;
        source: 'confluence' | 'local';
        attachment_key: string;
        content_hash: string;
        analysis_version: number;
        payload: ImageAnalysisPayload;
      }>
    | null;
}

export async function planDerivedChunks(
  pageId: number,
  bodyHtml: string,
  context: AuthoredChunkContext,
  chunkHardLimit: number,
): Promise<DerivedComposition> {
  if (!(await imageAnalysisStorePresent())) return { revision: 0, chunks: [], substantiveChars: 0 };

  const retained = await getRetainedImageAnalysisIdentity();
  const r = await query<CompositionRow>(
    `SELECT p.image_analysis_revision::text AS revision,
            (SELECT json_agg(json_build_object(
                      'id', a.id, 'source', a.source, 'attachment_key', a.attachment_key,
                      'content_hash', a.content_hash, 'analysis_version', a.analysis_version,
                      'payload', a.payload)
                    ORDER BY a.source, a.attachment_key)
               FROM page_image_analyses a
              WHERE a.page_id = p.id AND ${validitySql('a', 2, 3, 4)}) AS rows
       FROM pages p WHERE p.id = $1`,
    [pageId, ...validityParamValues({ identityHash: retained?.identityHash ?? null })],
  );
  const row = r.rows[0];
  const revision = Number(row?.revision ?? 0);
  const rows = row?.rows ?? [];
  if (rows.length === 0) return { revision, chunks: [], substantiveChars: 0 };

  // Context comes from the same body the authored chunks came from (D9.2).
  const refs = new Map(extractImageReferencesFromHtml(bodyHtml).map((ref) => [`${ref.source}:${ref.key}`, ref] as const));
  const chunks: DerivedChunkPlan[] = [];
  let substantive = 0;
  for (const a of rows) {
    const ref = refs.get(`${a.source}:${a.attachment_key}`);
    const parts = serializeImageAnalysis(
      a.payload,
      {
        attachmentKey: a.attachment_key,
        pageTitle: context.page_title,
        caption: ref?.caption,
        heading: ref?.heading,
      },
      chunkHardLimit,
    );
    substantive += substantiveChars(a.payload);
    parts.forEach((text, i) => {
      chunks.push({
        text,
        metadata: {
          ...context,
          section_title: `[Image: ${a.attachment_key} — ${a.payload.kind}]`,
          source: 'image_analysis',
          attachment_source: a.source,
          attachment_key: a.attachment_key,
          content_hash: a.content_hash,
          analysis_id: a.id,
          analysis_version: a.analysis_version,
          part: i + 1,
          parts: parts.length,
        },
      });
    });
  }
  return { revision, chunks, substantiveChars: substantive };
}
