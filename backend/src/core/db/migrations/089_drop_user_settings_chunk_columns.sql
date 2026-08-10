-- Migration 089: drop the dead per-user chunk settings (#1108)
--
-- `user_settings.embedding_chunk_size` / `embedding_chunk_overlap` arrived in
-- migration 022 and have never been read. Chunking is resolved from
-- `admin_settings` via `getAdminChunkSettings` (embedding-service.ts), which is
-- the only reader in the tree.
--
-- They are dropped rather than wired up because chunk settings cannot be
-- per-user: every chunk in `page_embeddings` is embedded once and shared by
-- every searcher, so a per-user size has nowhere to take effect. Leaving them
-- is worse than removing them — a column named `embedding_chunk_size` on a
-- settings table reads as configuration, and the next person to set it will
-- watch it do nothing.
--
-- Number 089 was reserved for #1116 on epic #1100 and released unused: that
-- issue creates its shadow columns with runtime DDL, because their type is the
-- dimension the server measures at probe time and no static file can know it.

ALTER TABLE user_settings DROP COLUMN IF EXISTS embedding_chunk_size;
ALTER TABLE user_settings DROP COLUMN IF EXISTS embedding_chunk_overlap;
