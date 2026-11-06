-- Separate evidence for canonical-only repair of acknowledged ordinary labels.
-- Never rewrite the original command or terminal response.
CREATE TABLE IF NOT EXISTS page_label_canonical_repairs (
  intent_id uuid PRIMARY KEY REFERENCES page_write_intents(id) ON DELETE CASCADE,
  plan jsonb NOT NULL CHECK (jsonb_typeof(plan) = 'object'),
  next_step integer NOT NULL DEFAULT 0 CHECK (next_step >= 0),
  in_flight boolean NOT NULL DEFAULT FALSE,
  outcomes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(outcomes) = 'array'),
  observed_at timestamptz,
  completed_at timestamptz,
  CHECK (completed_at IS NULL OR (observed_at IS NOT NULL AND NOT in_flight))
);
