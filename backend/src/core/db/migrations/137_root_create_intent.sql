-- Root Confluence page creation through the write-intent ledger (#280).
--
-- Migration 125 admitted `pages.create.confluence` only in its PARENTED shape
-- (`page_ids = ARRAY[parentPageId]`), so a create at the space root could
-- not reserve an intent and bypassed admission (and with it the same-tx
-- initial-policy write). This forward migration NARROWLY admits one more
-- shape of the same kind; every other kind, the parented shape, the remote
-- effect class and `remote_terminal_only` are untouched — the existing
-- policy expression is reused verbatim and OR-ed with the root branch.
--
-- Root shape (all conditions required):
--   kind = 'pages.create.confluence', effectClass = 'remote',
--   recovery_mode = 'remote_terminal_only',
--   page_ids = '{}'::integer[], revisions = '{}'::jsonb,
--   effect.parentPageId = null, effect.parentConfluenceId = null,
--   effect.spaceKey nonempty string, titleSha256/storageSha256 sha-256 hex,
--   effect.initialPolicy in ('all','local_only','none'),
--   effect.initialLabels an array of at most 50 entries.
--
-- Empty targets stay refused for everything else: `page_ids_check` admits an
-- empty array ONLY for this kind with a null parent.

-- Every initialLabels element must be a non-empty string of at most 100
-- characters (the CreatePageSchema bound). A CHECK cannot hold a subquery,
-- so the rule lives in this IMMUTABLE function.
CREATE OR REPLACE FUNCTION page_write_intent_initial_labels_valid(labels JSONB) RETURNS BOOLEAN
  LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_typeof(labels) = 'array'
     AND jsonb_array_length(labels) <= 50
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(labels) AS e
        WHERE jsonb_typeof(e) <> 'string'
           OR length(e #>> '{}') = 0
           OR length(e #>> '{}') > 100)
$$;

DO $$
DECLARE
  existing TEXT;
  root_branch CONSTANT TEXT := $root$
    (kind = 'pages.create.confluence'
     AND (effect ->> 'effectClass') = 'remote'
     AND recovery_mode = 'remote_terminal_only'
     AND page_ids = '{}'::integer[]
     AND revisions = '{}'::jsonb
     AND (effect -> 'parentPageId') = 'null'::jsonb
     AND (effect -> 'parentConfluenceId') = 'null'::jsonb
     AND jsonb_typeof(effect -> 'spaceKey') = 'string'
     AND length(effect ->> 'spaceKey') > 0
     AND (effect ->> 'titleSha256') ~ '^[a-f0-9]{64}$'
     AND (effect ->> 'storageSha256') ~ '^[a-f0-9]{64}$'
     AND (effect ->> 'initialPolicy') IN ('all', 'local_only', 'none')
     AND page_write_intent_initial_labels_valid(effect -> 'initialLabels'))
  $root$;
  -- The root branch of the FIRST revision of this migration (no per-element
  -- label check) is recognised by its empty-array comparison; the upgraded
  -- one by the validator function it calls.
  stale_marker CONSTANT TEXT := '''{}''::integer[]';
  upgraded_marker CONSTANT TEXT := 'page_write_intent_initial_labels_valid';
BEGIN
  IF to_regclass('page_write_intents') IS NULL THEN RETURN; END IF;

  SELECT pg_get_constraintdef(c.oid) INTO existing
    FROM pg_constraint c
   WHERE c.conrelid = 'page_write_intents'::regclass
     AND c.conname = 'page_write_intents_effect_policy_check';

  IF existing IS NULL THEN
    RAISE EXCEPTION 'page_write_intents_effect_policy_check is missing; migration 125 must run first';
  END IF;

  -- pg_get_constraintdef yields `CHECK (<expr>)`; keep <expr> verbatim.
  IF existing NOT LIKE '%' || stale_marker || '%' THEN
    -- Fresh: migration 125's expression OR the (upgraded) root branch.
    EXECUTE 'ALTER TABLE page_write_intents DROP CONSTRAINT page_write_intents_effect_policy_check';
    EXECUTE 'ALTER TABLE page_write_intents ADD CONSTRAINT page_write_intents_effect_policy_check '
         || 'CHECK (COALESCE(' || substring(existing FROM 7) || ' OR ' || root_branch || ', false))';
  ELSIF existing NOT LIKE '%' || upgraded_marker || '%' THEN
    -- The first revision of this migration ran (root branch without the
    -- per-element label check). Tighten in place: the whole existing
    -- expression is kept and AND-ed with the element rule for empty-target
    -- rows, so nothing the old branch refused is admitted and the parented
    -- shape (non-empty page_ids) is untouched.
    EXECUTE 'ALTER TABLE page_write_intents DROP CONSTRAINT page_write_intents_effect_policy_check';
    EXECUTE 'ALTER TABLE page_write_intents ADD CONSTRAINT page_write_intents_effect_policy_check '
         || 'CHECK ((' || substring(existing FROM 7) || ') AND (cardinality(page_ids) > 0 '
         || 'OR page_write_intent_initial_labels_valid(effect -> ''initialLabels'')))';
  END IF;

  -- `cardinality(page_ids) > 0` (migration 120) — admit the empty set only
  -- for the root create shape.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'page_write_intents'::regclass
       AND conname = 'page_write_intents_page_ids_check'
       AND pg_get_constraintdef(oid) NOT LIKE '%pages.create.confluence%'
  ) THEN
    EXECUTE 'ALTER TABLE page_write_intents DROP CONSTRAINT page_write_intents_page_ids_check';
    EXECUTE 'ALTER TABLE page_write_intents ADD CONSTRAINT page_write_intents_page_ids_check '
         || 'CHECK (cardinality(page_ids) > 0 OR (kind = ''pages.create.confluence'' '
         || 'AND (effect -> ''parentPageId'') = ''null''::jsonb))';
  END IF;
END $$;
