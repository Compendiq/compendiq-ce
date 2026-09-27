-- #275 keeps every accepted write-recovery attempt without allowing the live
-- intent row to grow without bound. Each row is one complete retired segment;
-- the current segment remains on page_write_intents for existing token readers.
CREATE TABLE page_write_recovery_history_segments (
  id                BIGSERIAL PRIMARY KEY,
  intent_id         UUID NOT NULL REFERENCES page_write_intents(id) ON DELETE RESTRICT,
  recovery_history  JSONB NOT NULL,
  archived_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(recovery_history) = 'array'),
  CHECK (jsonb_array_length(recovery_history) BETWEEN 1 AND 32),
  CHECK (octet_length(recovery_history::text) <= 65536)
);

CREATE INDEX page_write_recovery_history_segments_intent_idx
  ON page_write_recovery_history_segments (intent_id, archived_at, id);

CREATE OR REPLACE FUNCTION protect_page_write_recovery_history_segment() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'page write recovery history segments are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER page_write_recovery_history_segments_append_only
  BEFORE UPDATE OR DELETE ON page_write_recovery_history_segments
  FOR EACH ROW EXECUTE FUNCTION protect_page_write_recovery_history_segment();
