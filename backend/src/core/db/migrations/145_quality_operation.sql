-- Quality evidence identity survives retries and crash recovery, not new content.
ALTER TABLE pages ADD COLUMN IF NOT EXISTS quality_ai_operation_id UUID;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS quality_ai_attempt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_quality_ai_attempt_check;
ALTER TABLE pages ADD CONSTRAINT pages_quality_ai_attempt_check CHECK (quality_ai_attempt >= 0);

CREATE OR REPLACE FUNCTION reset_quality_ai_operation() RETURNS trigger AS $$
BEGIN
  IF NEW.content_revision IS DISTINCT FROM OLD.content_revision
     OR (NEW.quality_status = 'pending' AND OLD.quality_status IN ('analyzed', 'skipped', 'policy_blocked')) THEN
    NEW.quality_ai_operation_id := NULL;
    NEW.quality_ai_attempt := 0;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS zz_quality_ai_operation_reset ON pages;
CREATE TRIGGER zz_quality_ai_operation_reset BEFORE UPDATE ON pages
  FOR EACH ROW EXECUTE FUNCTION reset_quality_ai_operation();
