-- Revocation may overtake an already-started generated label request. Preserve
-- its original token and effect: this receipt authorizes acknowledgment only,
-- never publication or another remote request.
CREATE TABLE IF NOT EXISTS page_generated_label_supersessions (
  intent_id UUID PRIMARY KEY REFERENCES page_write_intents(id) ON DELETE CASCADE,
  runtime_id TEXT NOT NULL,
  original_revisions JSONB NOT NULL,
  original_effect JSONB NOT NULL,
  effect_started_at TIMESTAMPTZ NOT NULL,
  superseded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(original_revisions) = 'object'),
  CHECK (jsonb_typeof(original_effect) = 'object')
);
