-- #1618 stage 2 (ADR-027 "Retirement plan") — retire the legacy image
-- embedding space.
--
-- HELD ARTEFACT. This file is NOT in `backend/src/core/db/migrations/` and MUST
-- NOT be moved there until the stage-2 gate opens; see the README beside it for
-- the gate, the number and the copy procedure. `postgres.ts` applies every
-- `*.sql` in that directory on boot, so a staged file placed there executes on
-- the next boot of every environment that pulls `dev`, including every
-- developer's test database.
--
-- Destructive. Nothing here removes page content, `body_html`, `body_text` or
-- attachment BYTES: it removes the legacy image VECTOR index, its dirty flag,
-- and the settings and assignment rows that configured it. The recovery
-- boundary and the exact `pg_dump` set are in
-- `docs/runbooks/image-embedding-retirement.md`; that procedure must be
-- exercised before this runs against anything an operator cares about.
--
-- Migrations 093, 097, 115 and 116 are RETAINED as history. This migration
-- undoes 093's objects; it does not delete 093.

-- ─── 1. The vector index itself ──────────────────────────────────────────────
-- Dropped with CASCADE off: nothing references it. The HNSW index (built at
-- probe time by `ensureImageEmbeddingColumn`, never by a migration) and the
-- per-page index go with the table.
DROP TABLE IF EXISTS page_image_embeddings;

-- ─── 2. The dirty flag and its partial index ─────────────────────────────────
-- `pages_image_embedding_dirty_idx` is a partial index ON `pages (id) WHERE
-- image_embedding_dirty`, so dropping the column drops the index with it. The
-- explicit DROP INDEX is belt and braces for a database where a restored dump
-- left the index without the column.
DROP INDEX IF EXISTS pages_image_embedding_dirty_idx;
ALTER TABLE pages DROP COLUMN IF EXISTS image_embedding_dirty;

-- ─── 3. The use-case CHECK ───────────────────────────────────────────────────
-- 054's inline column constraint, auto-named by Postgres, so every change is a
-- drop and a re-add of the WHOLE list. Lineage: 054 (five) → 090 (`rerank`) →
-- 093 (`image_embedding`) → 097 (`inline_completion`) → 115 (`image_analysis`)
-- → this migration, which is the first to NARROW it.
--
-- The assignment row must go BEFORE the constraint is re-added, or the re-add
-- fails on the row it is meant to outlaw.
DELETE FROM llm_usecase_assignments WHERE usecase = 'image_embedding';

ALTER TABLE llm_usecase_assignments
  DROP CONSTRAINT IF EXISTS llm_usecase_assignments_usecase_check;
ALTER TABLE llm_usecase_assignments
  ADD CONSTRAINT llm_usecase_assignments_usecase_check
  CHECK (usecase IN ('chat', 'summary', 'quality', 'auto_tag', 'embedding', 'rerank',
                     'inline_completion', 'image_analysis'));

-- ─── 4. The settings rows ────────────────────────────────────────────────────
-- `image_embedding_probe`, `image_embedding_dimensions`,
-- `image_embedding_index_model` and `image_embedding_target_dimensions` are
-- ADR-027 `:5275`'s `admin_settings.image_embedding_*`; `rag_image_leg_enabled`
-- is named beside them.
--
-- `image_index_last_run` is NOT named by `:5275` — it is neither prefix — and
-- is deleted here as an ADR erratum (#1618/Q3): it is the last legacy scan's
-- audit trail, and it describes a worker that no longer exists. It is the one
-- row whose deletion loses operator-visible history, which is why the runbook's
-- `pg_dump` set includes the whole `admin_settings` table.
DELETE FROM admin_settings
 WHERE setting_key IN (
   'image_embedding_probe',
   'image_embedding_dimensions',
   'image_embedding_index_model',
   'image_embedding_target_dimensions',
   'rag_image_leg_enabled',
   'image_index_last_run'
 );

-- ─── What this migration deliberately does NOT touch ─────────────────────────
-- `page_image_analyses` and every column migration 116 added: they are the
-- replacement, not the thing being retired.
-- `admin_settings.image_analysis_*` (identity, ceiling, batch size, last run).
-- `rag_answer_max_images` and `rag_images_per_page_max`: ADR-025 D8/D8b survive
-- the cutover for the optional chat attachment (ADR-027 D11).
-- `pages.image_analysis_dirty` / `image_analysis_revision`.
-- Attachment files on disk, and `local_attachments`.
