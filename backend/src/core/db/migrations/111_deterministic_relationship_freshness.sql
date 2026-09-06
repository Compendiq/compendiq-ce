-- Deterministic evidence has its own durable queue: embedding/provider state is
-- unrelated. No FK: a hard-deleted page must still invalidate old title/key matches.
CREATE SEQUENCE IF NOT EXISTS deterministic_relationship_revision;
CREATE TABLE IF NOT EXISTS deterministic_relationship_dirty (
  page_id INTEGER PRIMARY KEY,
  revision BIGINT NOT NULL DEFAULT nextval('deterministic_relationship_revision'),
  full_rebuild BOOLEAN NOT NULL DEFAULT FALSE
);

-- Same source-sensitive key as parentKeyFor. A synced parent's internal id is
-- NOT a second key (082). Cross-namespace collisions resolve to no parent.
CREATE OR REPLACE FUNCTION relationship_parent_key(page_source TEXT, page_id INTEGER, confluence_id TEXT)
RETURNS TEXT LANGUAGE SQL IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN page_source = 'confluence' AND NULLIF(confluence_id, '') IS NOT NULL
    THEN confluence_id ELSE page_id::text END
$$;
CREATE INDEX IF NOT EXISTS idx_pages_relationship_parent_key
  ON pages (relationship_parent_key(source, id, confluence_id)) WHERE deleted_at IS NULL;
CREATE OR REPLACE FUNCTION relationship_parent_id(parent_key TEXT)
RETURNS INTEGER LANGUAGE SQL STABLE AS $$
  SELECT MIN(id) FROM pages
  WHERE deleted_at IS NULL
    AND relationship_parent_key(source, id, confluence_id) = parent_key
  HAVING COUNT(*) = 1
$$;

CREATE OR REPLACE FUNCTION mark_deterministic_relationship_dirty()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  changed_id INTEGER;
  rebuild BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(OLD.id, OLD.title, OLD.source, OLD.confluence_id, OLD.deleted_at,
           OLD.parent_id, OLD.labels, OLD.body_html, OLD.body_storage, OLD.body_text)
       IS NOT DISTINCT FROM
       ROW(NEW.id, NEW.title, NEW.source, NEW.confluence_id, NEW.deleted_at,
           NEW.parent_id, NEW.labels, NEW.body_html, NEW.body_storage, NEW.body_text) THEN
      RETURN NULL;
    END IF;
    -- Old identities can resolve references from anywhere, including a title
    -- that was ambiguous before the write. Incremental scans know only NEW.
    rebuild := ROW(OLD.id, OLD.title, OLD.source, OLD.confluence_id, OLD.deleted_at)
      IS DISTINCT FROM ROW(NEW.id, NEW.title, NEW.source, NEW.confluence_id, NEW.deleted_at);
    changed_id := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    changed_id := OLD.id;
    rebuild := TRUE;
  ELSE
    changed_id := NEW.id;
    -- A new unique identity only affects pairs touching the new page. A new
    -- duplicate also invalidates a previously resolved pair not touching it.
    SELECT EXISTS (
      SELECT 1 FROM pages p WHERE p.id <> NEW.id AND p.deleted_at IS NULL
        AND (p.title = NEW.title OR
          relationship_parent_key(p.source, p.id, p.confluence_id) =
          relationship_parent_key(NEW.source, NEW.id, NEW.confluence_id))
    ) INTO rebuild;
  END IF;
  INSERT INTO deterministic_relationship_dirty (page_id, full_rebuild)
  VALUES (changed_id, rebuild)
  ON CONFLICT (page_id) DO UPDATE SET
    revision = nextval('deterministic_relationship_revision'),
    full_rebuild = deterministic_relationship_dirty.full_rebuild OR EXCLUDED.full_rebuild;
  RETURN NULL;
END
$$;
DROP TRIGGER IF EXISTS pages_deterministic_relationship_dirty ON pages;
CREATE TRIGGER pages_deterministic_relationship_dirty
  AFTER INSERT OR UPDATE OR DELETE ON pages
  FOR EACH ROW EXECUTE FUNCTION mark_deterministic_relationship_dirty();

-- Upgrade backlog includes every existing page, even never-embedded rows.
-- Zero is a queue-only sentinel, not a relationship vertex.
INSERT INTO deterministic_relationship_dirty (page_id, full_rebuild) VALUES (0, TRUE)
ON CONFLICT (page_id) DO UPDATE SET
  revision = nextval('deterministic_relationship_revision'), full_rebuild = TRUE;
