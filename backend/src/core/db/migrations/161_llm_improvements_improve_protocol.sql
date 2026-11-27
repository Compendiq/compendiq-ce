-- #1958 (coordinator decision D26) — which converter protocol produced a stored
-- Improve suggestion.
--
-- An Apply binds its Markdown to the caller's stored row by exact content.
-- The #1958 generator writes code-block titles and options as CODE-META lines
-- and frozen code blocks as CQ_CODE_PLACEHOLDER_<N> tokens, and records that
-- here (1 = the #1958 code-metadata protocol). A row written before this
-- migration stays NULL: a suggestion of the earlier release, never inferred
-- from its text. Forward-only and additive; no backfill.
ALTER TABLE llm_improvements
  ADD COLUMN IF NOT EXISTS improve_protocol INTEGER;
