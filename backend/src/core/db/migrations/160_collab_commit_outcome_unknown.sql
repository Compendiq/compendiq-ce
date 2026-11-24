-- #2035: mark a collaborative Save whose remote phase failed after dispatch.
--
-- A pending `collab.commit.confluence[.media]` intent with
-- `remote_effect_started_at` set and no terminal result is also what a healthy
-- Save in flight looks like. The owning runtime sets this marker when its own
-- remote phase ended without a terminal result, so every process can tell the
-- failed Save (outcome unknown, the room fails closed) from the one in flight.
--
-- The marker removes write authority only. It never settles, cancels or
-- releases anything, and reconciliation does not read it.
--
-- A nullable column without a default is a metadata-only change, and the CHECK
-- holds for every existing row because the column is NULL there.
ALTER TABLE page_write_intents
  ADD COLUMN remote_effect_failed_at TIMESTAMPTZ NULL;

ALTER TABLE page_write_intents
  ADD CONSTRAINT page_write_intents_remote_effect_failed_check
  CHECK (remote_effect_failed_at IS NULL OR remote_effect_started_at IS NOT NULL);
