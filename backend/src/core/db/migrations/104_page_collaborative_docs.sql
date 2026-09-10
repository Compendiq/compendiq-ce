-- #1443 / #1411 PR 1 — Yjs CRDT persistence for realtime collaborative editing.
--
-- Unused at runtime until the collab gateway (later PRs) writes it. `version`
-- is the BYTEA persistence generation for this row, NOT pages.version.
-- Flag default off: collab_editing_enabled = '0'. ON CONFLICT DO NOTHING so a
-- later operator-set value is not overwritten on re-apply.

CREATE TABLE page_collaborative_docs (
    page_id INTEGER PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
    doc_state BYTEA NOT NULL,
    state_vector BYTEA,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_page_collaborative_docs_updated
  ON page_collaborative_docs (updated_at);

INSERT INTO admin_settings (setting_key, setting_value, updated_at)
VALUES ('collab_editing_enabled', '0', NOW())
ON CONFLICT (setting_key) DO NOTHING;
