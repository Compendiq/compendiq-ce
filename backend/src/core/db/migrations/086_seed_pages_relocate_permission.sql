-- Migration 086: seed the `pages:relocate` global permission onto the default
-- system roles (#1123).
--
-- `POST /api/pages/:id/relocate` moves an article between a local space and
-- Confluence. It is gated by requireGlobalPermission('pages:relocate') *in
-- addition to* the per-space write check `POST /api/pages` already applies —
-- the permission is a second gate, never a bypass of space authorization.
--
-- Granted to `editor` and `space_admin` only. Relocating is destructive across
-- a system boundary (a move to a local space deletes the Confluence page
-- upstream; a move to Confluence discards local version history), so `viewer`
-- and `commenter` must not hold it.
--
-- CE has no admin UI for granting permissions — `permission_definitions` and
-- `GET /api/admin/permissions` are EE-only overlays — so this seed is the only
-- way the permission reaches a role in a community deployment. Do not assume
-- an administrator can grant it by hand.
--
-- Idempotent: guarded by `NOT permissions @> ARRAY[...]` so reruns are safe.
-- Follows the pattern established by 052_seed_granular_permissions.sql.

UPDATE roles
SET permissions = array_cat(permissions, ARRAY['pages:relocate'])
WHERE name = 'editor'
  AND NOT permissions @> ARRAY['pages:relocate'];

UPDATE roles
SET permissions = array_cat(permissions, ARRAY['pages:relocate'])
WHERE name = 'space_admin'
  AND NOT permissions @> ARRAY['pages:relocate'];
