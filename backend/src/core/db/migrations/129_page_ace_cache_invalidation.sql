-- Page ACEs decide which restricted pages every non-RAG read surface returns
-- (`visiblePagesPredicate`). Every writer of those rows must therefore fence
-- the page-derived caches, including writers that never call into CE cache
-- code: the Confluence restriction sync and its stale sweep, page relocation,
-- and the Enterprise bulk page-permission route.
--
-- Queue the page in the same transaction as the ACE change, exactly like
-- migration 120's `pages` trigger does for `inherit_perms`. The page
-- publication worker drains the queue with a namespace-wide generation bump
-- after commit. A refresh that only touches bookkeeping (`synced_at`,
-- `source`) or the permission name changes no read decision (any page ACE
-- grants read, as in `userCanAccessPage`) and is not queued.
CREATE OR REPLACE FUNCTION enqueue_page_ace_cache_invalidation() RETURNS trigger AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.resource_type = 'page' THEN
    IF TG_OP = 'DELETE'
       OR NEW.resource_type IS DISTINCT FROM OLD.resource_type
       OR NEW.resource_id IS DISTINCT FROM OLD.resource_id
       OR NEW.principal_type IS DISTINCT FROM OLD.principal_type
       OR NEW.principal_id IS DISTINCT FROM OLD.principal_id THEN
      INSERT INTO page_cache_invalidation_queue (page_id)
        VALUES (OLD.resource_id)
        ON CONFLICT (page_id) DO UPDATE
          SET queued_at = page_cache_invalidation_queue.queued_at;
    END IF;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.resource_type = 'page' THEN
    IF TG_OP = 'INSERT'
       OR NEW.resource_type IS DISTINCT FROM OLD.resource_type
       OR NEW.resource_id IS DISTINCT FROM OLD.resource_id
       OR NEW.principal_type IS DISTINCT FROM OLD.principal_type
       OR NEW.principal_id IS DISTINCT FROM OLD.principal_id THEN
      INSERT INTO page_cache_invalidation_queue (page_id)
        VALUES (NEW.resource_id)
        ON CONFLICT (page_id) DO UPDATE
          SET queued_at = page_cache_invalidation_queue.queued_at;
    END IF;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS access_control_entries_page_cache_invalidation_trigger
  ON access_control_entries;
CREATE TRIGGER access_control_entries_page_cache_invalidation_trigger
  AFTER INSERT OR UPDATE OR DELETE ON access_control_entries
  FOR EACH ROW EXECUTE FUNCTION enqueue_page_ace_cache_invalidation();

-- A group ACE reads through `group_memberships`, so a membership change moves
-- restricted pages in or out of that member's lists just like an ACE change.
-- Queue every page carrying a page ACE for the affected group; groups without
-- page ACEs queue nothing.
CREATE OR REPLACE FUNCTION enqueue_group_membership_page_cache_invalidation() RETURNS trigger AS $$
BEGIN
  INSERT INTO page_cache_invalidation_queue (page_id)
    SELECT DISTINCT ace.resource_id
      FROM access_control_entries ace
     WHERE ace.resource_type = 'page'
       AND ace.principal_type = 'group'
       -- Same principal parsing as `visiblePagesPredicate`.
       AND (CASE WHEN ace.principal_id ~ '^[0-9]{1,9}$'
                 THEN ace.principal_id::integer END) IN (
         CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.group_id END,
         CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.group_id END
       )
    ON CONFLICT (page_id) DO UPDATE
      SET queued_at = page_cache_invalidation_queue.queued_at;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS group_memberships_page_cache_invalidation_trigger
  ON group_memberships;
CREATE TRIGGER group_memberships_page_cache_invalidation_trigger
  AFTER INSERT OR UPDATE OR DELETE ON group_memberships
  FOR EACH ROW EXECUTE FUNCTION enqueue_group_membership_page_cache_invalidation();
