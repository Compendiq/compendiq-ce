-- Restore the UNIQUE (page_id, chunk_index) invariant on page_embeddings.
--
-- History: migration 023 added page_embeddings_confluence_id_chunk_index_key
-- UNIQUE (confluence_id, chunk_index). Migration 030 swapped the natural key
-- from confluence_id to a page_id FK via
--   ALTER TABLE page_embeddings DROP COLUMN IF EXISTS confluence_id;
-- which silently dropped that unique constraint along with the old column.
-- Unlike page_versions (030 recreated its unique index on the new INT column),
-- page_embeddings only got a plain, non-unique page_embeddings_page_id_idx, so
-- the "one row per (page, chunk)" invariant has been DB-unenforced ever since.
--
-- The sole writer (embedPage in embedding-service.ts) replaces a page's rows
-- inside a single transaction via DELETE-then-INSERT (no ON CONFLICT), so this
-- index is purely a defense-in-depth backstop against duplicate (page_id,
-- chunk_index) rows from concurrent re-embeds or any future upsert writer — it
-- is fully compatible with the existing delete-then-insert path.

-- Defensive de-dup before index creation. The DELETE-then-INSERT writer should
-- never have produced duplicates, but the missing constraint means earlier
-- concurrent runs could have left some behind. Keep the lowest id per
-- (page_id, chunk_index) tuple.
DELETE FROM page_embeddings pe
USING page_embeddings pe2
WHERE pe.id > pe2.id
  AND pe.page_id = pe2.page_id
  AND pe.chunk_index = pe2.chunk_index;

CREATE UNIQUE INDEX IF NOT EXISTS page_embeddings_page_id_chunk_unique
  ON page_embeddings(page_id, chunk_index);
