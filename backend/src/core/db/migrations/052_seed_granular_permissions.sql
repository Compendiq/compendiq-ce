-- Migration 052: Grant granular LLM and sync permissions to default system roles.
-- Required because CE PR #207 added requireGlobalPermission() preHandlers on
-- LLM and sync routes, but migration 039 only seeded legacy coarse permissions
-- (read, comment, edit, delete, manage, admin). Without this seed, non-admin
-- users with default roles get 403 on all AI features after upgrading to v1.1.
--
-- Idempotent: guarded by NOT permissions @> ARRAY[...] so reruns are safe.

-- viewer, commenter, editor all need LLM access
UPDATE roles
SET permissions = array_cat(permissions, ARRAY['llm:query', 'llm:generate', 'llm:improve', 'llm:summarize'])
WHERE name IN ('viewer', 'commenter', 'editor')
  AND NOT permissions @> ARRAY['llm:query'];

-- editor needs sync trigger (viewers/commenters don't trigger syncs)
UPDATE roles
SET permissions = array_cat(permissions, ARRAY['sync:trigger'])
WHERE name = 'editor'
  AND NOT permissions @> ARRAY['sync:trigger'];

-- space_admin gets everything editors have plus manage
UPDATE roles
SET permissions = array_cat(permissions, ARRAY['llm:query', 'llm:generate', 'llm:improve', 'llm:summarize', 'sync:trigger'])
WHERE name = 'space_admin'
  AND NOT permissions @> ARRAY['llm:query'];
