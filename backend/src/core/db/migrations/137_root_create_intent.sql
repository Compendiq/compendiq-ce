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
     AND jsonb_typeof(effect -> 'initialLabels') = 'array'
     AND jsonb_array_length(effect -> 'initialLabels') <= 50)
  $root$;
BEGIN
  IF to_regclass('page_write_intents') IS NULL THEN RETURN; END IF;

  SELECT pg_get_constraintdef(c.oid) INTO existing
    FROM pg_constraint c
   WHERE c.conrelid = 'page_write_intents'::regclass
     AND c.conname = 'page_write_intents_effect_policy_check';

  IF existing IS NULL THEN
    RAISE EXCEPTION 'page_write_intents_effect_policy_check is missing; migration 125 must run first';
  END IF;

  -- Idempotency marker: the root branch is the only one comparing page_ids
  -- against an empty array.
  IF existing NOT LIKE '%''{}''::integer[]%' THEN
    -- pg_get_constraintdef yields `CHECK (<expr>)`; keep <expr> verbatim.
    existing := substring(existing FROM 7);               -- drop 'CHECK '
    EXECUTE 'ALTER TABLE page_write_intents DROP CONSTRAINT page_write_intents_effect_policy_check';
    EXECUTE 'ALTER TABLE page_write_intents ADD CONSTRAINT page_write_intents_effect_policy_check '
         || 'CHECK (COALESCE(' || existing || ' OR ' || root_branch || ', false))';
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
