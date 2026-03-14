-- Migration 022: Article templates (#357)
--
-- Templates are stored TipTap JSON documents. Users can create pages from
-- templates and save any page as a template. Built-in system templates use
-- the sentinel UUID '00000000-0000-0000-0000-000000000000' as created_by.

CREATE TABLE templates (
  id          SERIAL PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT,
  category    TEXT,
  icon        TEXT,
  body_json   TEXT NOT NULL,
  body_html   TEXT NOT NULL,
  variables   JSONB NOT NULL DEFAULT '[]',
  created_by  UUID NOT NULL REFERENCES users(id),
  is_global   BOOLEAN NOT NULL DEFAULT FALSE,
  space_key   TEXT,
  use_count   INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX templates_global_idx     ON templates(is_global) WHERE is_global = TRUE;
CREATE INDEX templates_created_by_idx ON templates(created_by);
CREATE INDEX templates_category_idx   ON templates(category);

-- Seed built-in templates with sentinel system user
INSERT INTO users (id, username, password_hash, role)
VALUES ('00000000-0000-0000-0000-000000000000', '__system__', 'nologin', 'admin')
ON CONFLICT (id) DO NOTHING;

INSERT INTO templates (title, description, category, icon, body_json, body_html, is_global, created_by)
VALUES
  ('Meeting Notes', 'Template for meeting notes with agenda, decisions, and action items', 'meetings', '📋',
   '{"type":"doc","content":[{"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"Meeting Notes"}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Date"}]},{"type":"paragraph","content":[{"type":"text","text":"YYYY-MM-DD"}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Attendees"}]},{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Name 1"}]}]}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Agenda"}]},{"type":"orderedList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Topic 1"}]}]}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Decisions"}]},{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Decision 1"}]}]}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Action Items"}]},{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"[ ] Action item — Owner — Due date"}]}]}]}]}',
   '<h1>Meeting Notes</h1><h2>Date</h2><p>YYYY-MM-DD</p><h2>Attendees</h2><ul><li>Name 1</li></ul><h2>Agenda</h2><ol><li>Topic 1</li></ol><h2>Decisions</h2><ul><li>Decision 1</li></ul><h2>Action Items</h2><ul><li>[ ] Action item — Owner — Due date</li></ul>',
   TRUE, '00000000-0000-0000-0000-000000000000'),

  ('Incident Report', 'Template for documenting incidents with timeline and root cause', 'operations', '🚨',
   '{"type":"doc","content":[{"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"Incident Report"}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Summary"}]},{"type":"paragraph","content":[{"type":"text","text":"Brief description of the incident"}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Severity"}]},{"type":"paragraph","content":[{"type":"text","text":"P1 / P2 / P3 / P4"}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Timeline"}]},{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"HH:MM — Event description"}]}]}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Root Cause"}]},{"type":"paragraph","content":[{"type":"text","text":"Describe the root cause"}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Resolution"}]},{"type":"paragraph","content":[{"type":"text","text":"Steps taken to resolve"}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Prevention"}]},{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Action to prevent recurrence"}]}]}]}]}',
   '<h1>Incident Report</h1><h2>Summary</h2><p>Brief description of the incident</p><h2>Severity</h2><p>P1 / P2 / P3 / P4</p><h2>Timeline</h2><ul><li>HH:MM — Event description</li></ul><h2>Root Cause</h2><p>Describe the root cause</p><h2>Resolution</h2><p>Steps taken to resolve</p><h2>Prevention</h2><ul><li>Action to prevent recurrence</li></ul>',
   TRUE, '00000000-0000-0000-0000-000000000000'),

  ('How-to Guide', 'Step-by-step guide template', 'documentation', '📖',
   '{"type":"doc","content":[{"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"How to: [Title]"}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Prerequisites"}]},{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Prerequisite 1"}]}]}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Steps"}]},{"type":"orderedList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Step 1"}]}]}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Expected Outcome"}]},{"type":"paragraph","content":[{"type":"text","text":"What the user should see when done"}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Troubleshooting"}]},{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Problem → Solution"}]}]}]}]}',
   '<h1>How to: [Title]</h1><h2>Prerequisites</h2><ul><li>Prerequisite 1</li></ul><h2>Steps</h2><ol><li>Step 1</li></ol><h2>Expected Outcome</h2><p>What the user should see when done</p><h2>Troubleshooting</h2><ul><li>Problem → Solution</li></ul>',
   TRUE, '00000000-0000-0000-0000-000000000000'),

  ('Architecture Decision Record', 'ADR template for documenting technical decisions', 'engineering', '🏗️',
   '{"type":"doc","content":[{"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"ADR-NNN: [Title]"}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Status"}]},{"type":"paragraph","content":[{"type":"text","text":"Proposed / Accepted / Deprecated / Superseded"}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Context"}]},{"type":"paragraph","content":[{"type":"text","text":"What is the issue that we are seeing that is motivating this decision?"}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Decision"}]},{"type":"paragraph","content":[{"type":"text","text":"What is the change that we are proposing and/or doing?"}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Consequences"}]},{"type":"paragraph","content":[{"type":"text","text":"What becomes easier or more difficult because of this change?"}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Alternatives Considered"}]},{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Alternative 1 — rejected because..."}]}]}]}]}',
   '<h1>ADR-NNN: [Title]</h1><h2>Status</h2><p>Proposed / Accepted / Deprecated / Superseded</p><h2>Context</h2><p>What is the issue?</p><h2>Decision</h2><p>What is the change?</p><h2>Consequences</h2><p>What becomes easier or harder?</p><h2>Alternatives Considered</h2><ul><li>Alternative 1 — rejected because...</li></ul>',
   TRUE, '00000000-0000-0000-0000-000000000000'),

  ('Runbook', 'Operations runbook for responding to alerts', 'operations', '🔧',
   '{"type":"doc","content":[{"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"Runbook: [Alert/Scenario Name]"}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Trigger"}]},{"type":"paragraph","content":[{"type":"text","text":"What alert or condition triggers this runbook?"}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Steps"}]},{"type":"orderedList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Step 1"}]}]}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Rollback"}]},{"type":"paragraph","content":[{"type":"text","text":"How to undo the changes if they make things worse"}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Escalation"}]},{"type":"paragraph","content":[{"type":"text","text":"Who to contact if this runbook does not resolve the issue"}]}]}',
   '<h1>Runbook: [Alert/Scenario Name]</h1><h2>Trigger</h2><p>What triggers this?</p><h2>Steps</h2><ol><li>Step 1</li></ol><h2>Rollback</h2><p>How to undo</p><h2>Escalation</h2><p>Who to contact</p>',
   TRUE, '00000000-0000-0000-0000-000000000000');
