/**
 * #1115 — the image index's column type and HNSW index, decided at PROBE time.
 *
 * Migration 093 ships `page_image_embeddings.embedding` as `vector(2048)` and
 * **no HNSW index at all**, deliberately: the opclass follows the probed width,
 * which is unknown until the assigned model answers. "The migration forgot an
 * index" is not a bug to fix — this module owns it, the same runtime-DDL
 * pattern `embedding-service.ts` (destructive re-embed) and
 * `shadow-migration-service.ts` (shadow columns) already use for the text
 * column, sharing their bounded-lock discipline and their tiering rule.
 *
 * **A model change is a truncate + re-scan (ADR-025 D7), not a shadow swap.**
 * The two are not the same trade. A text re-embed under the destructive path
 * costs search for its whole window, which is why #1116 built the shadow
 * machinery; the image leg is simply OFF while its index is empty, so text
 * search is never degraded, and images are far cheaper to re-embed (content-
 * addressed skip by sha256, and only referenced images). Building a second
 * shadow apparatus for that would be cost without a benefit.
 *
 * **The identity that triggers a rebuild is `provider + model + base URL`, not
 * width.** Two different models at the same width produce two incompatible
 * vector spaces, and a column type cannot tell them apart. The base URL is in
 * it — spelled out rather than implied by the provider id — because ADR-025 D12
 * makes the served vLLM version a re-index event (upstream preprocessing
 * diverges by ~0.92 cosine between paths, `vllm#33204`), and because one model
 * NAME can mean two different checkpoints on two different servers. Recording
 * only `providerId:model` let an operator move a provider row's `base_url` to a
 * different container and keep the old index (review round 1).
 *
 * `model` is likewise the RESOLVED model, and the assignment route pins it into
 * `llm_usecase_assignments.model` at probe time for the same reason: an
 * assignment that leaves the model to `provider.default_model` re-resolves on
 * every read, so editing that default would repoint the live model with no
 * probe and no rebuild.
 *
 * What is still invisible from here: a server UPGRADED IN PLACE at the same
 * URL. Nothing in the process can see that, which is why the runbook tells
 * operators to treat a version bump as a manual re-scan.
 */
import { query } from '../../../core/db/postgres.js';
import { columnTypeFor, HNSW_PARAMS } from '../../../core/db/vector-column-tier.js';
import type { VectorColumnTier } from '../../../core/db/vector-column-tier.js';
import { withLockRetry } from '../../../core/db/with-lock-retry.js';
import { logger } from '../../../core/utils/logger.js';

/** Width the image column is currently typed to, as `admin_settings` records it. */
export const IMAGE_EMBEDDING_DIMENSIONS_KEY = 'image_embedding_dimensions';
/** `<providerId>:<model>` the live index was built for. */
export const IMAGE_EMBEDDING_INDEX_MODEL_KEY = 'image_embedding_index_model';
/** The one HNSW index over `page_image_embeddings.embedding`. */
export const IMAGE_EMBEDDING_HNSW_INDEX = 'page_image_embeddings_embedding_hnsw_idx';

export interface ImageIndexPair {
  providerId: string;
  model: string;
  /** The provider's `base_url` as the leg will call it. Part of the identity. */
  baseUrl: string;
}

export interface EnsureImageIndexResult {
  /** `rebuilt` = the table was emptied and every page re-dirtied. */
  action: 'rebuilt' | 'index_only';
  dimensions: number;
  tier: VectorColumnTier;
  indexed: boolean;
  /** Pages marked `image_embedding_dirty`; 0 on the `index_only` path. */
  dirtiedPages: number;
}

function identityOf(pair: ImageIndexPair): string {
  return `${pair.providerId}:${pair.model}@${pair.baseUrl}`;
}

/**
 * NOTE: the live width, the live type and the recorded pair are ALL read inside
 * the locked transaction below, never before it. An unlocked pre-check would be
 * stale by the time the lock is granted — another admin can land the same
 * rebuild in that window — and acting on it would truncate a freshly-built
 * index and re-dirty the whole corpus a second time.
 */
async function hnswIndexExists(): Promise<boolean> {
  const r = await query(
    `SELECT 1 FROM pg_indexes WHERE tablename = 'page_image_embeddings' AND indexname = $1`,
    [IMAGE_EMBEDDING_HNSW_INDEX],
  );
  return r.rows.length > 0;
}

/**
 * Bring `page_image_embeddings.embedding` in line with `dimensions` and `pair`.
 *
 * Two outcomes:
 *
 *  - **rebuilt** — the width differs from the live column OR the recorded
 *    provider+model+baseUrl differs from the newly assigned one. Under one bounded-lock
 *    transaction: TRUNCATE (the stored vectors are of the old width and/or the
 *    old space, and neither can be cast into the new one), retype, drop and
 *    rebuild the HNSW index for the new tier, record the pair, and mark every
 *    non-folder page `image_embedding_dirty`. `embedding_dirty` is deliberately
 *    untouched: text search does not move when the image model does.
 *  - **index_only** — same width, same pair. Nothing is destroyed; the index is
 *    created if it is missing, which is the fresh-install case (migration 093
 *    ships none) and the "someone dropped it" case.
 *
 * The index is created INSIDE the transaction on the rebuild path because the
 * table is empty at that point, so the build is instant — unlike the text
 * column's, which is built outside a transaction over a real corpus.
 */
export async function ensureImageEmbeddingColumn(
  dimensions: number,
  pair: ImageIndexPair,
): Promise<EnsureImageIndexResult> {
  // Throws on a non-integer or out-of-range width, BEFORE any DDL: pgvector
  // type arguments cannot be bound, so `columnType` is interpolated.
  const { columnType, opclass, tier } = columnTypeFor(dimensions);
  const identity = identityOf(pair);

  if (!opclass) {
    logger.warn(
      { dimensions, model: pair.model },
      'Image embedding width exceeds pgvector\'s HNSW limit on halfvec (4000) — no index will be built, so image retrieval falls back to a sequential scan. Use the model\'s MRL `dimensions` parameter to stay at or below 4000.',
    );
  }

  let dirtiedPages = 0;
  // Set INSIDE the transaction, from the re-verified reads — never from a
  // pre-transaction check. A second admin can land the same rebuild in the
  // window between the two, and reporting "rebuilt" for a transaction that did
  // nothing but confirm an index would put a truncate-and-rescan into the audit
  // trail that never happened.
  let action: EnsureImageIndexResult['action'] = 'index_only';

  await withLockRetry(
    { lockTimeoutMs: 5000, maxAttempts: 5, operation: 'the image index rebuild' },
    async (client) => {
      // Lock first, read second — the same discipline every DDL path here
      // uses, and the reason there is no pre-transaction check to compare
      // against: another admin can land the same rebuild in the window before
      // this lock, and an unlocked read would truncate a freshly-built index
      // and re-dirty the whole corpus a second time.
      await client.query(`LOCK TABLE page_image_embeddings IN ACCESS EXCLUSIVE MODE`);
      const verify = await client.query(
        `SELECT atttypmod AS dims, format_type(atttypid, atttypmod) AS type
           FROM pg_attribute
          WHERE attrelid = 'page_image_embeddings'::regclass AND attname = 'embedding'`,
      );
      const verifiedDims = Number(verify.rows[0]?.dims ?? -1);
      const verifiedType = String(verify.rows[0]?.type ?? '');
      const verifiedIdentityRows = await client.query(
        `SELECT setting_value FROM admin_settings WHERE setting_key = $1`,
        [IMAGE_EMBEDDING_INDEX_MODEL_KEY],
      );
      const verifiedIdentity =
        (verifiedIdentityRows.rows[0] as { setting_value?: string } | undefined)?.setting_value ?? null;
      const needsRebuild =
        verifiedDims !== dimensions || verifiedType !== columnType || verifiedIdentity !== identity;
      action = needsRebuild ? 'rebuilt' : 'index_only';

      if (!needsRebuild) {
        // Index-only: create it if it is absent, and touch nothing else.
        if (opclass) {
          await client.query(
            `CREATE INDEX IF NOT EXISTS ${IMAGE_EMBEDDING_HNSW_INDEX}
               ON page_image_embeddings USING hnsw (embedding ${opclass}) ${HNSW_PARAMS}`,
          );
        } else {
          await client.query(`DROP INDEX IF EXISTS ${IMAGE_EMBEDDING_HNSW_INDEX}`);
        }
        return;
      }

      // DROP → TRUNCATE → ALTER → CREATE, in that order and for the reason
      // migration 048 documents: altering the column while an index tied to the
      // old opclass still exists makes Postgres try to rebuild that index on
      // the new type, which fails when the new type is `halfvec` (or the new
      // width is above the tier's limit). Dropping first disentangles them.
      await client.query(`DROP INDEX IF EXISTS ${IMAGE_EMBEDDING_HNSW_INDEX}`);
      await client.query(`TRUNCATE page_image_embeddings`);
      await client.query(
        `ALTER TABLE page_image_embeddings ALTER COLUMN embedding TYPE ${columnType}`,
      );
      if (opclass) {
        await client.query(
          `CREATE INDEX ${IMAGE_EMBEDDING_HNSW_INDEX}
             ON page_image_embeddings USING hnsw (embedding ${opclass}) ${HNSW_PARAMS}`,
        );
      }
      for (const [key, value] of [
        [IMAGE_EMBEDDING_DIMENSIONS_KEY, String(dimensions)],
        [IMAGE_EMBEDDING_INDEX_MODEL_KEY, identity],
      ] as const) {
        await client.query(
          `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (setting_key) DO UPDATE SET setting_value = $2, updated_at = NOW()`,
          [key, value],
        );
      }
      // Every non-folder page becomes a candidate again — the index is empty,
      // so P2's worker has to re-walk the corpus. A folder carries no body and
      // therefore no image reference, the same exclusion `embedding-service`,
      // `quality-worker` and `summary-worker` all apply.
      //
      // `embedding_dirty` is untouched on purpose. That column is why the two
      // flags exist separately (migration 093): the image model moving must not
      // enqueue a full text re-embed.
      const marked = await client.query(
        `UPDATE pages SET image_embedding_dirty = TRUE
          WHERE deleted_at IS NULL AND COALESCE(page_type, 'page') != 'folder'`,
      );
      dirtiedPages = (marked as unknown as { rowCount?: number }).rowCount ?? 0;
    },
  );

  const result: EnsureImageIndexResult = {
    action,
    dimensions,
    tier,
    indexed: opclass !== null && (await hnswIndexExists()),
    dirtiedPages,
  };
  logger.info({ ...result, model: pair.model, providerId: pair.providerId }, 'Image embedding index ensured');
  return result;
}
