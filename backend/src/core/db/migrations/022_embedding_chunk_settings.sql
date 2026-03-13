-- Migration 020: Add configurable embedding chunk size and overlap per user
--
-- These settings allow users to tune how their Confluence pages are chunked
-- before being stored as vector embeddings. Smaller chunks (128-256) find
-- precise facts; larger chunks (512-1024) preserve more context.
--
-- Changing either value marks all of the user's cached pages as dirty so
-- the embedding service re-processes them with the new parameters.

ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS embedding_chunk_size    INT NOT NULL DEFAULT 500,
  ADD COLUMN IF NOT EXISTS embedding_chunk_overlap INT NOT NULL DEFAULT 50;
