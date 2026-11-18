-- Old writers must be quiesced/fenced and held stopped across this snapshot cutover.
-- Durable pending intents may remain; execution authority must already be retired.
--
-- #2063: migration 151b retires every pre-upgrade epoch before this guard runs.
-- An epoch it could not fence (started work, no termination proof) is closed by
-- `quiesced_at` + `upgrade_retired_at` with no owner acknowledgment; that state
-- is retired for this cutover and must pass. A row with the marker but an open
-- gate still blocks.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM page_writer_runtimes
     WHERE fenced_at IS NULL
       AND (
         quiesced_at IS NULL
         OR (quiescence_ack IS NULL AND upgrade_retired_at IS NULL)
       )
  ) OR EXISTS (
    SELECT 1 FROM page_runtime_admissions WHERE released_at IS NULL
  ) THEN
    RAISE EXCEPTION 'relocation_notion_upgrade_requires_retired_writers';
  END IF;
END $$;

SELECT pg_advisory_xact_lock(279004);
LOCK TABLE page_relocation_preparations, pages IN ACCESS EXCLUSIVE MODE;

ALTER TABLE page_relocation_preparations
  ADD COLUMN original_notion_page_id TEXT;

-- Old application writers only INSERTed this token; the preparation FK keeps
-- that same page alive. Capture every exact original value before either repair.
UPDATE page_relocation_preparations AS prep
   SET original_notion_page_id = p.notion_page_id
  FROM pages AS p
 WHERE p.id = prep.page_id;

UPDATE pages SET notion_page_id = NULL
 WHERE source = 'confluence' AND notion_page_id IS NOT NULL;

-- Only a matching retained Confluence-to-local cutover loses its token here.
-- Identity near-matches stay untouched for the existing recovery verifier.
UPDATE pages AS p SET notion_page_id = NULL
  FROM page_relocation_preparations AS prep
  JOIN page_write_intents AS i ON i.id = prep.intent_id
 WHERE p.id = prep.page_id
   AND i.kind = 'page.relocate' AND i.status = 'pending'
   AND prep.direction = 'to_local' AND prep.original_source = 'confluence'
   AND prep.original_confluence_id IS NOT NULL
   AND prep.original_key = prep.original_confluence_id
   AND p.source = 'standalone' AND p.confluence_id IS NULL
   AND p.space_key IS NOT DISTINCT FROM prep.target_space_key
   AND p.visibility = prep.target_visibility
   AND p.created_by_user_id = prep.actor_id
   AND p.deleted_at IS NULL AND p.baseline_id IS NULL
   AND p.notion_page_id IS NOT NULL;

DROP INDEX pages_notion_page_id_owner_live_uidx;
CREATE UNIQUE INDEX pages_notion_page_id_owner_live_uidx ON pages
  (created_by_user_id, (lower(replace(notion_page_id, '-', ''))))
  WHERE source = 'standalone'
    AND notion_page_id IS NOT NULL AND deleted_at IS NULL;
