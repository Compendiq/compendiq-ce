-- Migration 112: Refresh built-in templates and add Cornell Notes
--
-- 032 already seeded five global templates. This migration overhauls their
-- body_json / body_html (richer structure, task lists) and inserts Cornell
-- Notes when missing. Do not edit 032 — it has already been applied.


INSERT INTO users (id, username, password_hash, role)
VALUES ('00000000-0000-0000-0000-000000000000', '__system__', 'nologin', 'admin')
ON CONFLICT (id) DO NOTHING;

UPDATE templates
SET
  description = $desc$Date, attendees, agenda, decisions, and task-list action items$desc$,
  body_json = $json${"type":"doc","content":[{"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"Meeting Notes"}]},{"type":"paragraph","content":[{"type":"text","text":"Date: YYYY-MM-DD  ·  Time: HH:MM  ·  Location: …"}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Attendees"}]},{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Name — role"}]}]}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Agenda"}]},{"type":"orderedList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Topic 1"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Topic 2"}]}]}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Discussion"}]},{"type":"paragraph","content":[{"type":"text","text":"Capture the main points of the conversation."}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Decisions"}]},{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Decision 1 — owner"}]}]}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Action Items"}]},{"type":"taskList","content":[{"type":"taskItem","attrs":{"checked":false},"content":[{"type":"paragraph","content":[{"type":"text","text":"Action — Owner — Due date"}]}]},{"type":"taskItem","attrs":{"checked":false},"content":[{"type":"paragraph","content":[{"type":"text","text":"Action — Owner — Due date"}]}]}]}]}$json$,
  body_html = $html$<h1>Meeting Notes</h1><p>Date: YYYY-MM-DD  ·  Time: HH:MM  ·  Location: …</p><h2>Attendees</h2><ul><li>Name — role</li></ul><h2>Agenda</h2><ol><li>Topic 1</li><li>Topic 2</li></ol><h2>Discussion</h2><p>Capture the main points of the conversation.</p><h2>Decisions</h2><ul><li>Decision 1 — owner</li></ul><h2>Action Items</h2><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Action — Owner — Due date</p></li><li data-type="taskItem" data-checked="false"><p>Action — Owner — Due date</p></li></ul>$html$,
  updated_at = NOW()
WHERE title = 'Meeting Notes'
  AND created_by = '00000000-0000-0000-0000-000000000000';

UPDATE templates
SET
  description = $desc$Summary, severity, timeline, root cause, resolution, and prevention$desc$,
  body_json = $json${"type":"doc","content":[{"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"Incident Report"}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Summary"}]},{"type":"paragraph","content":[{"type":"text","text":"One-paragraph description of what happened and who was affected."}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Severity"}]},{"type":"paragraph","content":[{"type":"text","text":"P1 / P2 / P3 / P4  ·  Impact: users / revenue / SLO"}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Timeline"}]},{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"HH:MM — Detection"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"HH:MM — Mitigation started"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"HH:MM — Resolved"}]}]}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Root Cause"}]},{"type":"paragraph","content":[{"type":"text","text":"What failed, and why. Link evidence if available."}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Resolution"}]},{"type":"paragraph","content":[{"type":"text","text":"Steps taken to restore service."}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Prevention"}]},{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Follow-up action — owner — due date"}]}]}]}]}$json$,
  body_html = $html$<h1>Incident Report</h1><h2>Summary</h2><p>One-paragraph description of what happened and who was affected.</p><h2>Severity</h2><p>P1 / P2 / P3 / P4  ·  Impact: users / revenue / SLO</p><h2>Timeline</h2><ul><li>HH:MM — Detection</li><li>HH:MM — Mitigation started</li><li>HH:MM — Resolved</li></ul><h2>Root Cause</h2><p>What failed, and why. Link evidence if available.</p><h2>Resolution</h2><p>Steps taken to restore service.</p><h2>Prevention</h2><ul><li>Follow-up action — owner — due date</li></ul>$html$,
  updated_at = NOW()
WHERE title = 'Incident Report'
  AND created_by = '00000000-0000-0000-0000-000000000000';

UPDATE templates
SET
  description = $desc$Prerequisites, steps, expected outcome, and troubleshooting$desc$,
  body_json = $json${"type":"doc","content":[{"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"How to: [Title]"}]},{"type":"paragraph","content":[{"type":"text","text":"Audience: …  ·  Time: ~N minutes"}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Prerequisites"}]},{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Access / tools required"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Background knowledge"}]}]}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Steps"}]},{"type":"orderedList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Step 1 — do X"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Step 2 — verify Y"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Step 3 — finish Z"}]}]}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Expected Outcome"}]},{"type":"paragraph","content":[{"type":"text","text":"What the reader should see or have when the steps succeed."}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Troubleshooting"}]},{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Problem → likely cause → fix"}]}]}]}]}$json$,
  body_html = $html$<h1>How to: [Title]</h1><p>Audience: …  ·  Time: ~N minutes</p><h2>Prerequisites</h2><ul><li>Access / tools required</li><li>Background knowledge</li></ul><h2>Steps</h2><ol><li>Step 1 — do X</li><li>Step 2 — verify Y</li><li>Step 3 — finish Z</li></ol><h2>Expected Outcome</h2><p>What the reader should see or have when the steps succeed.</p><h2>Troubleshooting</h2><ul><li>Problem → likely cause → fix</li></ul>$html$,
  updated_at = NOW()
WHERE title = 'How-to Guide'
  AND created_by = '00000000-0000-0000-0000-000000000000';

UPDATE templates
SET
  description = $desc$Status, context, decision, consequences, and alternatives$desc$,
  body_json = $json${"type":"doc","content":[{"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"ADR-NNN: [Title]"}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Status"}]},{"type":"paragraph","content":[{"type":"text","text":"Proposed / Accepted / Deprecated / Superseded  ·  Date: YYYY-MM-DD"}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Context"}]},{"type":"paragraph","content":[{"type":"text","text":"What issue is motivating this decision? Constraints and forces."}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Decision"}]},{"type":"paragraph","content":[{"type":"text","text":"The change we are proposing or have made, and why now."}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Consequences"}]},{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Positive: what becomes easier"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Negative: what becomes harder or riskier"}]}]}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Alternatives Considered"}]},{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Alternative 1 — rejected because…"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Alternative 2 — rejected because…"}]}]}]}]}$json$,
  body_html = $html$<h1>ADR-NNN: [Title]</h1><h2>Status</h2><p>Proposed / Accepted / Deprecated / Superseded  ·  Date: YYYY-MM-DD</p><h2>Context</h2><p>What issue is motivating this decision? Constraints and forces.</p><h2>Decision</h2><p>The change we are proposing or have made, and why now.</p><h2>Consequences</h2><ul><li>Positive: what becomes easier</li><li>Negative: what becomes harder or riskier</li></ul><h2>Alternatives Considered</h2><ul><li>Alternative 1 — rejected because…</li><li>Alternative 2 — rejected because…</li></ul>$html$,
  updated_at = NOW()
WHERE title = 'Architecture Decision Record'
  AND created_by = '00000000-0000-0000-0000-000000000000';

UPDATE templates
SET
  description = $desc$Trigger, steps, rollback, and escalation for operational response$desc$,
  body_json = $json${"type":"doc","content":[{"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"Runbook: [Alert/Scenario Name]"}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Trigger"}]},{"type":"paragraph","content":[{"type":"text","text":"Alert name, condition, or symptom that starts this runbook."}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Steps"}]},{"type":"orderedList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Confirm the alert is still firing"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Check dashboards / logs"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Apply the mitigation"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Verify recovery"}]}]}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Rollback"}]},{"type":"paragraph","content":[{"type":"text","text":"How to undo the change if it makes things worse."}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Escalation"}]},{"type":"paragraph","content":[{"type":"text","text":"Who to contact (team, on-call, manager) if this runbook does not resolve the issue."}]}]}$json$,
  body_html = $html$<h1>Runbook: [Alert/Scenario Name]</h1><h2>Trigger</h2><p>Alert name, condition, or symptom that starts this runbook.</p><h2>Steps</h2><ol><li>Confirm the alert is still firing</li><li>Check dashboards / logs</li><li>Apply the mitigation</li><li>Verify recovery</li></ol><h2>Rollback</h2><p>How to undo the change if it makes things worse.</p><h2>Escalation</h2><p>Who to contact (team, on-call, manager) if this runbook does not resolve the issue.</p>$html$,
  updated_at = NOW()
WHERE title = 'Runbook'
  AND created_by = '00000000-0000-0000-0000-000000000000';

INSERT INTO templates (title, description, category, icon, body_json, body_html, is_global, created_by)
SELECT
  'Cornell Notes',
  'Two-column Cornell layout: cues, notes, and a summary in your own words',
  'notes',
  '📝',
  $json${"type":"doc","content":[{"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"Cornell Notes"}]},{"type":"paragraph","content":[{"type":"text","text":"Topic: …  ·  Date: YYYY-MM-DD  ·  Source: …"}]},{"type":"table","content":[{"type":"tableRow","content":[{"type":"tableHeader","attrs":{"colspan":1,"rowspan":1},"content":[{"type":"paragraph","content":[{"type":"text","text":"Cues"}]}]},{"type":"tableHeader","attrs":{"colspan":1,"rowspan":1},"content":[{"type":"paragraph","content":[{"type":"text","text":"Notes"}]}]}]},{"type":"tableRow","content":[{"type":"tableCell","attrs":{"colspan":1,"rowspan":1},"content":[{"type":"paragraph"}]},{"type":"tableCell","attrs":{"colspan":1,"rowspan":1},"content":[{"type":"paragraph"}]}]},{"type":"tableRow","content":[{"type":"tableCell","attrs":{"colspan":1,"rowspan":1},"content":[{"type":"paragraph"}]},{"type":"tableCell","attrs":{"colspan":1,"rowspan":1},"content":[{"type":"paragraph"}]}]}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Summary"}]},{"type":"paragraph","content":[{"type":"text","text":"Recap the lecture or article in your own words — key ideas, not a transcript."}]},{"type":"panel","attrs":{"panelType":"tip"},"content":[{"type":"paragraph","content":[{"type":"text","text":"Jot cues while you review; write the summary last."}]}]}]}$json$,
  $html$<h1>Cornell Notes</h1><p>Topic: …  ·  Date: YYYY-MM-DD  ·  Source: …</p><table><tr><th><p>Cues</p></th><th><p>Notes</p></th></tr><tr><td><p></p></td><td><p></p></td></tr><tr><td><p></p></td><td><p></p></td></tr></table><h2>Summary</h2><p>Recap the lecture or article in your own words — key ideas, not a transcript.</p><div class="panel-tip"><p>Jot cues while you review; write the summary last.</p></div>$html$,
  TRUE,
  '00000000-0000-0000-0000-000000000000'
WHERE NOT EXISTS (
  SELECT 1 FROM templates
  WHERE title = 'Cornell Notes'
    AND created_by = '00000000-0000-0000-0000-000000000000'
);
