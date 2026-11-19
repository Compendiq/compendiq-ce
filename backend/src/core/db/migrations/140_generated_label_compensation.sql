-- A compensation is not a replay of the original remote effect. Preserve its
-- terminal receipt and store the narrowly authorized undo independently.
CREATE TABLE IF NOT EXISTS page_generated_label_compensations (
  intent_id UUID PRIMARY KEY REFERENCES page_write_intents(id) ON DELETE CASCADE,
  plan JSONB NOT NULL CHECK (jsonb_typeof(plan) = 'object' AND octet_length(plan::text) <= 32768),
  next_step INTEGER NOT NULL DEFAULT 0 CHECK (next_step >= 0),
  in_flight BOOLEAN NOT NULL DEFAULT FALSE,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  CHECK (completed_at IS NULL OR started_at IS NOT NULL)
);
