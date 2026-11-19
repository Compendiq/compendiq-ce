-- Each dispatched request has an independently acknowledged outcome. A missing
-- acknowledgment remains unknown; a successful prefix is not phase completion.
CREATE TABLE IF NOT EXISTS page_generated_label_requests (
  intent_id uuid NOT NULL REFERENCES page_write_intents(id) ON DELETE CASCADE,
  request_index integer NOT NULL CHECK (request_index >= 0),
  runtime_id text NOT NULL,
  actor_id uuid NOT NULL,
  original_revisions jsonb NOT NULL CHECK (jsonb_typeof(original_revisions) = 'object'),
  original_effect jsonb NOT NULL CHECK (jsonb_typeof(original_effect) = 'object'),
  request jsonb NOT NULL CHECK (jsonb_typeof(request) = 'object'
    AND jsonb_typeof(request->'before') = 'array' AND jsonb_typeof(request->'after') = 'array'),
  started_at timestamptz NOT NULL DEFAULT NOW(),
  acknowledged_at timestamptz,
  PRIMARY KEY (intent_id, request_index)
);
