-- Migration 062: fix FKs that block DELETE users (PR #311 Finding #1)
--
-- The admin CRUD `DELETE /api/admin/users/:id` route (#304) relies on
-- PostgreSQL to cascade or null out back-references when a user row is
-- removed. Several tables declared their `user_id` FK with the PostgreSQL
-- default (ON DELETE NO ACTION), so DELETE fails as soon as the target has
-- ever logged in (audit_log LOGIN event), hit an error (error_log), or
-- resolved a comment (page_comments.resolved_by).
--
-- Fix: change each of these FKs to ON DELETE SET NULL so the historical
-- row survives with a null pointer — matching the pattern already used by
-- pages.created_by_user_id, pages.owner_id, notifications.source_user_id
-- and the other optional audit-trail back-references.
--
-- Tables with a NOT NULL user FK (e.g. templates.created_by) cannot use
-- SET NULL; those are reassigned to the system-sentinel user inside the
-- deleteUser() service transaction instead.

-- audit_log.user_id: historical login / admin-action rows must survive a
-- user delete with a NULL actor pointer rather than blocking the delete.
ALTER TABLE audit_log
  DROP CONSTRAINT audit_log_user_id_fkey,
  ADD CONSTRAINT audit_log_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;

-- error_log.user_id: same rationale — the error record (stack, message,
-- correlation_id) is what matters; the acting-user pointer is optional.
ALTER TABLE error_log
  DROP CONSTRAINT error_log_user_id_fkey,
  ADD CONSTRAINT error_log_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;

-- comments.resolved_by: the comment is authored by a different user (the
-- comments.user_id FK already cascades correctly). The resolver pointer is
-- informational and should null out on user delete, not block it.
ALTER TABLE comments
  DROP CONSTRAINT comments_resolved_by_fkey,
  ADD CONSTRAINT comments_resolved_by_fkey
    FOREIGN KEY (resolved_by) REFERENCES users(id) ON DELETE SET NULL;
