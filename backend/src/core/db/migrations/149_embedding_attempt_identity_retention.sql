-- Attempt identity is evidence bookkeeping, not live article-derived content.
-- A caller can retry a retained operation after its page was hard-deleted.
-- Cascading the counter (or refusing its insertion) reuses attempt 1 for those
-- refusals. Keep only the numeric article identifier and operation counter;
-- no content, provider credentials or authorization is retained here.
ALTER TABLE explicit_embedding_ai_attempts
  DROP CONSTRAINT IF EXISTS explicit_embedding_ai_attempts_page_id_fkey;
