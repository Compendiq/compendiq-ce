-- #1104: add 'rerank' as the sixth LLM use case (ADR-021 amendment).
--
-- Unlike the existing five, rerank targets a /v1/rerank endpoint
-- (Cohere/Jina shape — NOT OpenAI-compatible, and NOT TEI's bare /rerank
-- either) via a dedicated client
-- method, and its resolution semantics differ deliberately: an UNASSIGNED
-- rerank use case means the rerank stage is DISABLED, never "inherit the
-- default provider" — a chat provider cannot answer /v1/rerank, so the
-- fallback every other use case enjoys would break retrieval the moment an
-- admin set a default provider. See resolveRerankUsecase in
-- llm-provider-resolver.ts.
--
-- The CHECK is the inline column constraint from 054_llm_providers.sql,
-- which Postgres auto-names <table>_<column>_check.
ALTER TABLE llm_usecase_assignments
  DROP CONSTRAINT IF EXISTS llm_usecase_assignments_usecase_check;
ALTER TABLE llm_usecase_assignments
  ADD CONSTRAINT llm_usecase_assignments_usecase_check
  CHECK (usecase IN ('chat', 'summary', 'quality', 'auto_tag', 'embedding', 'rerank'));
