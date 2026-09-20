-- #276 collaborative commits that upload pasted images contain unversioned
-- attachment mutations. Keep that sequence terminal-only in SQL as well as in
-- the TypeScript policy registry; the later conditional page PUT cannot make
-- an earlier attachment POST conditionally recoverable.
ALTER TABLE page_write_intents DROP CONSTRAINT page_write_intents_effect_policy_check;

ALTER TABLE page_write_intents ADD CONSTRAINT page_write_intents_effect_policy_check CHECK (COALESCE(
  (
    kind IN (
      'attachment.local.put',
      'baseline.prepare',
      'icon.image.delete',
      'icon.image.put',
      'icon.metadata.patch',
      'import.notion.overwrite',
      'import.notion.placeholder.delete',
      'import.notion.publish',
      'import.notion.reparent',
      'pages.bulk.delete.local',
      'pages.delete.local',
      'pages.delete.standalone',
      'pages.image.import.store',
      'pages.image.upload'
    )
    AND effect->>'effectClass' = 'local'
    AND recovery_mode = 'local_verified'
  )
  OR
  (
    kind IN (
      'attachment.confluence.put',
      'page.labels',
      'page.relocate',
      'pages.bulk.delete.remote',
      'pages.bulk.replace_tags',
      'pages.bulk.tags',
      'pages.create.labels',
      'pages.delete.confluence',
      'pages.draft.publish.confluence',
      'pages.update.confluence'
    )
    AND effect->>'effectClass' = 'remote'
    AND recovery_mode = 'remote_terminal_only'
  )
  OR
  (
    kind = 'collab.commit.confluence.media'
    AND effect->>'effectClass' = 'remote'
    AND recovery_mode = 'remote_terminal_only'
    AND jsonb_typeof(effect->'pageId') = 'number'
    AND effect->>'pageId' ~ '^[1-9][0-9]*$'
    AND page_ids = ARRAY[(effect->>'pageId')::integer]
    AND jsonb_typeof(effect->'confluenceId') = 'string'
    AND length(effect->>'confluenceId') > 0
    AND jsonb_typeof(effect->'expectedRemoteVersion') = 'string'
    AND effect->>'expectedRemoteVersion' ~ '^[1-9][0-9]*$'
    AND jsonb_typeof(effect->'intendedStateDigest') = 'string'
    AND effect->>'intendedStateDigest' ~ '^[a-f0-9]{64}$'
    AND CASE
      WHEN jsonb_typeof(effect->'images') = 'array'
      THEN jsonb_array_length(effect->'images') > 0
      ELSE FALSE
    END
  )
  OR
  (
    kind = 'pages.create.confluence'
    AND effect->>'effectClass' = 'remote'
    AND recovery_mode = 'remote_terminal_only'
    AND jsonb_typeof(effect->'parentPageId') = 'number'
    AND effect->>'parentPageId' ~ '^[1-9][0-9]*$'
    AND page_ids = ARRAY[(effect->>'parentPageId')::integer]
    AND (
      effect->'parentConfluenceId' = 'null'::jsonb
      OR (jsonb_typeof(effect->'parentConfluenceId') = 'string'
          AND length(effect->>'parentConfluenceId') > 0)
    )
    AND jsonb_typeof(effect->'spaceKey') = 'string'
    AND length(effect->>'spaceKey') > 0
    AND effect->>'titleSha256' ~ '^[a-f0-9]{64}$'
    AND effect->>'storageSha256' ~ '^[a-f0-9]{64}$'
  )
  OR
  (
    kind IN ('page.ai_apply', 'page.version_restore', 'collab.commit.confluence')
    AND effect->>'effectClass' = 'remote'
    AND recovery_mode = 'remote_conditional'
    AND jsonb_typeof(effect->'pageId') = 'number'
    AND effect->>'pageId' ~ '^[1-9][0-9]*$'
    AND jsonb_typeof(effect->'confluenceId') = 'string'
    AND length(effect->>'confluenceId') > 0
    AND jsonb_typeof(effect->'expectedRemoteVersion') = 'string'
    AND effect->>'expectedRemoteVersion' ~ '^[1-9][0-9]*$'
    AND jsonb_typeof(effect->'intendedStateDigest') = 'string'
    AND effect->>'intendedStateDigest' ~ '^[a-f0-9]{64}$'
  ),
  FALSE
));
