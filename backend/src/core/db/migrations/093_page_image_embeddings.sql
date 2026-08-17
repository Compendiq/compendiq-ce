-- #1115 P0: the image index's schema. Nothing reads or writes it yet.
--
-- ADR-025 ("Multimodal image retrieval — dual space"). Images get their own
-- table rather than rows in `page_embeddings`, so `embedPage`, the #1116
-- shadow columns, `pages.page_avg_embedding`, MMR, rerank and sibling
-- assembly all stay text-only BY CONSTRUCTION rather than by everyone
-- remembering to add `WHERE kind = 'text'`. The two indexes are also
-- different widths from different models, which a shared column cannot hold.
--
-- What each object is for, and which PR turns it on:
--
--   page_image_embeddings
--     P1 re-types `embedding` to the probed width and creates the HNSW index
--         (`ensureImageEmbeddingColumn(dims)`; see the note on the column).
--     P2 writes rows: one per referenced image per page, upserted on
--         (page_id, source, attachment_key) and reconciled against the page's
--         current image references.
--     P3 reads them as retrieval's third RRF leg.
--
--   pages.image_embedding_dirty
--     P2 sets it wherever an image can change under a page — the sync upsert,
--         the attachment writers (`writeAttachmentCache`, `putLocalAttachment`,
--         `syncImageAttachments` / `syncDrawioAttachments`), the paste/import
--         routes and the admin re-scan — and clears it after a successful
--         `embedPageImages`. It is deliberately separate from
--         `embedding_dirty`: an attachment changing under an unchanged page
--         version (sync-service.ts's version-unchanged branch) must re-embed
--         the images and NOT the text.
--
--   llm_usecase_assignments CHECK
--     P1 adds the `image_embedding` use case, the resolver and the probe. Like
--         `rerank` (090) it NEVER inherits the default provider: an unassigned
--         row means the image leg is disabled, because the endpoint takes
--         vLLM's chat-embeddings `messages` shape, which a plain
--         OpenAI-compatible text embedder cannot serve.

CREATE TABLE IF NOT EXISTS page_image_embeddings (
  id             BIGSERIAL   PRIMARY KEY,
  page_id        INTEGER     NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  -- Which of the two attachment stores `attachment_key` resolves in:
  -- 'confluence' = the Confluence cache tree (keyed by confluence_id, or by the
  -- numeric page id for pasted images on standalone pages), 'local' =
  -- `local_attachments` under `<ATTACHMENTS_DIR>/local/<page_id>/`.
  source         TEXT        NOT NULL CHECK (source IN ('confluence', 'local')),
  -- Filename inside that store — the basename of the `<img src>` the content
  -- converter wrote into `body_html`, which is how the enumerator finds it.
  attachment_key TEXT        NOT NULL,
  -- Content address of the bytes that were embedded. P2 skips re-embedding an
  -- unchanged file by comparing this, which is what makes a re-scan cheap.
  sha256         TEXT        NOT NULL,
  -- Sniffed by `core/services/image-validator.ts`, never trusted from the
  -- extension: png | jpeg | webp | gif. A draw.io `.png` that is really XML
  -- sniffs as nothing and is skipped, so it never reaches this table.
  format         TEXT        NOT NULL,
  -- Read from the file header where the format declares it; NULL otherwise.
  -- The backend never decodes pixels (#1154).
  width          INTEGER,
  height         INTEGER,
  -- Provider model id that produced the vector, snapshotted like
  -- `llm_audit_log.model` — a model change empties this table (ADR-025 D7),
  -- and this column is how a leftover row is recognised if one ever survives.
  model          TEXT        NOT NULL,
  -- PLACEHOLDER width: 2048 is Qwen3-VL-Embedding-2B's native dimension and
  -- the recommended default, but the live width is whatever the probe reports.
  -- P1's `ensureImageEmbeddingColumn(dims)` re-types this column and builds the
  -- index, using the same tiering as `columnTypeFor` (vector + HNSW ≤ 2000,
  -- halfvec + HNSW ≤ 4000, unindexed above), truncating the table when the
  -- width changes.
  embedding      vector(2048) NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- The two stores are independent namespaces, so the same basename can
  -- legitimately exist in both for one page: `source` is part of the key.
  UNIQUE (page_id, source, attachment_key)
);

-- Per-page reconcile (P2) and the CASCADE above both scan by page.
CREATE INDEX IF NOT EXISTS page_image_embeddings_page_id_idx
  ON page_image_embeddings (page_id);

-- NO HNSW INDEX HERE, deliberately. The opclass depends on the probed width
-- (`vector_cosine_ops` ≤ 2000, `halfvec_cosine_ops` ≤ 4000, no index above),
-- and that width is unknown until the assigned model answers a probe. An index
-- built here would be dropped and rebuilt by the first probe anyway. P1's
-- `ensureImageEmbeddingColumn` owns it — the same runtime-DDL pattern
-- `embedding-service.ts` and `shadow-migration-service.ts` already use for the
-- text column.

ALTER TABLE pages ADD COLUMN IF NOT EXISTS image_embedding_dirty BOOLEAN NOT NULL DEFAULT FALSE;

-- Partial, like the worker's question: "which pages need their images
-- re-embedded?" On a settled corpus almost nothing is dirty, so a full index
-- would be mostly dead weight.
CREATE INDEX IF NOT EXISTS pages_image_embedding_dirty_idx
  ON pages (id) WHERE image_embedding_dirty;

-- Widen the use-case CHECK to admit 'image_embedding' (same shape as
-- 090_rerank_usecase.sql: the constraint is the inline column constraint from
-- 054_llm_providers.sql, which Postgres auto-names <table>_<column>_check, so
-- it has to be dropped and re-added with the full list).
ALTER TABLE llm_usecase_assignments
  DROP CONSTRAINT IF EXISTS llm_usecase_assignments_usecase_check;
ALTER TABLE llm_usecase_assignments
  ADD CONSTRAINT llm_usecase_assignments_usecase_check
  CHECK (usecase IN ('chat', 'summary', 'quality', 'auto_tag', 'embedding', 'rerank', 'image_embedding'));
