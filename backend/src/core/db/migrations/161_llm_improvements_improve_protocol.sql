-- #1958 (coordinator decisions D26, D28) — which converter protocol produced a
-- stored Improve suggestion, and the code nonce of that generation.
--
-- Apply binds its Markdown to the row the user selected (improvement id).
-- The #1958 generator writes code-block titles and options as CODE-META lines
-- and frozen code blocks as CQ_CODE_PLACEHOLDER_<nonce>_<N> tokens, and
-- records both here: `improve_protocol` (1 = the #1958 code-metadata
-- protocol) and `improve_code_nonce` (64 random bits, lowercase hex, made per
-- generation; only a token spelled with it places a protected code block).
-- A row written before this migration stays NULL in both: a suggestion of the
-- earlier release, never inferred from its text. Forward-only and additive; no
-- backfill.
ALTER TABLE llm_improvements
  ADD COLUMN IF NOT EXISTS improve_protocol INTEGER,
  ADD COLUMN IF NOT EXISTS improve_code_nonce TEXT;
