CREATE TABLE knowledge_requests (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  requested_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_to UUID REFERENCES users(id) ON DELETE SET NULL,
  space_key TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  fulfilled_by_page_id INTEGER REFERENCES pages(id) ON DELETE SET NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT knowledge_requests_status_check CHECK (status IN ('open', 'in_progress', 'completed', 'declined')),
  CONSTRAINT knowledge_requests_priority_check CHECK (priority IN ('low', 'normal', 'high'))
);

CREATE INDEX idx_knowledge_requests_status ON knowledge_requests(status) WHERE status IN ('open', 'in_progress');
CREATE INDEX idx_knowledge_requests_assigned ON knowledge_requests(assigned_to) WHERE assigned_to IS NOT NULL;
CREATE INDEX idx_knowledge_requests_requested_by ON knowledge_requests(requested_by);
