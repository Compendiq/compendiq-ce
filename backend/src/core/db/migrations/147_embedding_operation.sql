-- Evidence scheduling state is separate from pages: allocating a stage attempt
-- must not invalidate the retained xmin used by final dispatch/publication.
CREATE TABLE IF NOT EXISTS embedding_ai_operations (
  page_id INTEGER PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  content_revision BIGINT NOT NULL,
  image_revision BIGINT NOT NULL,
  operation_id UUID NOT NULL DEFAULT gen_random_uuid(),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0)
);

CREATE OR REPLACE FUNCTION reset_embedding_ai_operation() RETURNS trigger AS $$
BEGIN
  IF NEW.content_revision IS DISTINCT FROM OLD.content_revision
     OR NEW.image_analysis_revision IS DISTINCT FROM OLD.image_analysis_revision
     OR (NEW.embedding_dirty AND NOT OLD.embedding_dirty) THEN
    DELETE FROM embedding_ai_operations WHERE page_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS zz_embedding_ai_operation_reset ON pages;
CREATE TRIGGER zz_embedding_ai_operation_reset AFTER UPDATE ON pages
  FOR EACH ROW EXECUTE FUNCTION reset_embedding_ai_operation();
