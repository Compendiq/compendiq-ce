-- Preserve both version counters when compensating a Confluence relocation.
-- A prior publication used the provider number as its local version.
-- New publications record the actual local number for exact crash recovery.
ALTER TABLE page_relocation_preparations
  ADD COLUMN original_remote_version INTEGER,
  ADD COLUMN published_local_version INTEGER;

-- Confluence pages created after migration 157 and before the new writers
-- went live have the same legacy assumption as the original backfill.
UPDATE pages SET remote_version = version
 WHERE source = 'confluence' AND remote_version IS NULL;

-- Legacy drafts publish locally before calling Confluence. Their version
-- at reservation is one higher than the provider number the intent stores.
UPDATE pages AS page
   SET remote_version = page.version - 1
  FROM page_write_intents AS intent
 WHERE intent.kind = 'pages.draft.publish.confluence'
   AND intent.status = 'pending'
   AND intent.page_ids = ARRAY[page.id]
   AND page.source = 'confluence'
   AND page.version > 1
   AND intent.effect->'expectedVersion' = to_jsonb(page.version - 1);
