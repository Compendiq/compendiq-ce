-- Durable summary job evidence identity. Queuing a new generation resets the
-- identity, but retry/recovery of failed or interrupted work retains it.
ALTER TABLE pages ADD COLUMN IF NOT EXISTS summary_ai_operation_id UUID;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS summary_ai_attempt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_summary_ai_attempt_check;
ALTER TABLE pages ADD CONSTRAINT pages_summary_ai_attempt_check CHECK (summary_ai_attempt >= 0);

CREATE OR REPLACE FUNCTION reset_summary_ai_operation() RETURNS trigger AS $$
BEGIN
  IF NEW.content_revision IS DISTINCT FROM OLD.content_revision
     OR (NEW.summary_status = 'pending' AND OLD.summary_status IN ('summarized', 'skipped', 'policy_blocked')) THEN
    NEW.summary_ai_operation_id := NULL;
    NEW.summary_ai_attempt := 0;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS zz_summary_ai_operation_reset ON pages;
CREATE TRIGGER zz_summary_ai_operation_reset BEFORE UPDATE ON pages
  FOR EACH ROW EXECUTE FUNCTION reset_summary_ai_operation();
