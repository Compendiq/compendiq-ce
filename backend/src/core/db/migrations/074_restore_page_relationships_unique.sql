-- Restore the UNIQUE (page_id_1, page_id_2, relationship_type) constraint on
-- page_relationships.
--
-- History: migration 023 added this constraint on the original TEXT columns.
-- Migration 030 swapped those columns out for INT replacements via
--   DROP COLUMN page_id_1; DROP COLUMN page_id_2;
--   RENAME new_page_id_1 -> page_id_1; RENAME new_page_id_2 -> page_id_2;
-- which silently dropped the unique constraint along with the old columns.
-- 030 never recreated it on the new INT columns, so the
--   ON CONFLICT (page_id_1, page_id_2, relationship_type) ...
-- clauses in computePageRelationships() raise
--   42P10: no unique or exclusion constraint matching the ON CONFLICT specification
-- and POST /api/pages/graph/refresh returns 500.

-- Defensive de-dup before constraint creation. Under normal use ON CONFLICT
-- would have prevented duplicates, but the missing constraint means earlier
-- failed runs could have left partial inserts behind. Keep the lowest id per
-- (page_id_1, page_id_2, relationship_type) tuple.
DELETE FROM page_relationships pr
USING page_relationships pr2
WHERE pr.id > pr2.id
  AND pr.page_id_1 = pr2.page_id_1
  AND pr.page_id_2 = pr2.page_id_2
  AND pr.relationship_type = pr2.relationship_type;

DO $$ BEGIN
  ALTER TABLE page_relationships
    ADD CONSTRAINT page_relationships_page_id_1_page_id_2_type_key
      UNIQUE (page_id_1, page_id_2, relationship_type);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
