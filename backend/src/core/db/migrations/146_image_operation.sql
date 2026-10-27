-- Evidence attempt identity is separate from the provider failure budget.
ALTER TABLE page_image_analyses ADD COLUMN IF NOT EXISTS ai_operation_id UUID;
ALTER TABLE page_image_analyses ADD COLUMN IF NOT EXISTS ai_attempt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE page_image_analyses DROP CONSTRAINT IF EXISTS page_image_analyses_ai_attempt_check;
ALTER TABLE page_image_analyses ADD CONSTRAINT page_image_analyses_ai_attempt_check CHECK (ai_attempt >= 0);
CREATE OR REPLACE FUNCTION reset_image_ai_operation() RETURNS trigger AS $$
BEGIN
  IF NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR (NEW.status = 'pending' AND OLD.status IN ('analyzed', 'skipped')) THEN
    NEW.ai_operation_id := NULL;
    NEW.ai_attempt := 0;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS zz_image_ai_operation_reset ON page_image_analyses;
CREATE TRIGGER zz_image_ai_operation_reset BEFORE UPDATE ON page_image_analyses
  FOR EACH ROW EXECUTE FUNCTION reset_image_ai_operation();
