-- Stage attempt allocation must survive process restarts without changing page xmin.
CREATE TABLE IF NOT EXISTS shadow_embedding_ai_operations (
  page_id INTEGER PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  epoch TEXT NOT NULL,
  content_revision BIGINT NOT NULL,
  image_revision BIGINT NOT NULL,
  operation_id UUID NOT NULL DEFAULT gen_random_uuid(),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0)
);
CREATE TABLE IF NOT EXISTS explicit_embedding_ai_attempts (
  page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  operation_id UUID NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  PRIMARY KEY (page_id, operation_id)
);
