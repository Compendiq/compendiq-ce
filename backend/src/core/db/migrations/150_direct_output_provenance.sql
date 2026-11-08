-- #282 — durable transitive provenance on completed direct outputs.
--
-- A completed Improve row is reusable state: its text can be applied to the
-- article later, under a binding and a policy that may since have moved.
-- The row therefore retains the EXACT server-captured input provenance it was
-- generated under (the same `ConversationTurnAiProvenance` shape an Ask turn
-- and the direct-output cache carry): provider, configuration revision,
-- effective locality, and every page with its policy + content revision.
--
-- `ai_provenance_complete` is TRUE only when the write ran inside the
-- article-stage admission that re-proved that provenance on the held client.
-- Historical rows are deliberately UNKNOWN (NULL / FALSE) — never backfilled
-- from `page_id`, because an id is not a proof of what the output was fed.
ALTER TABLE llm_improvements
  ADD COLUMN IF NOT EXISTS ai_provenance JSONB,
  ADD COLUMN IF NOT EXISTS ai_provenance_complete BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS ai_provenance_version INTEGER;
