-- A commit must collect every durable room owner, not its own HTTP request
-- admission. Historical rows have no certified purpose and remain unknown.
ALTER TABLE page_runtime_admissions
  ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'legacy';

ALTER TABLE page_runtime_admissions
  ADD CONSTRAINT page_runtime_admissions_purpose_check
    CHECK (purpose IN ('legacy', 'collab_room', 'collab_request'));
