-- #2063 — retire every pre-upgrade writer epoch so the one-time migration 152
-- cutover cannot deadlock a restarting deployment.
--
-- `152_relocation_notion_identity.sql` refuses to run while a writer epoch is
-- unretired (`fenced_at IS NULL` and not owner-acknowledged quiescent) or any
-- writable room admission is unreleased. A backend stopped without a graceful
-- quiesce (kill, crash, exceeded SHUTDOWN_TIMEOUT_MS) leaves exactly that
-- state, and the replacement process cannot retire it: `owner_ack` needs the
-- owning process, and `verified_local_termination` needs the same host, boot
-- and PID namespace, which a recreated container never has. The upgrade then
-- stopped at the migration runner, before the app could start, and needed
-- manual SQL (issue #2063).
--
-- This migration runs BETWEEN 151 and 152:
--   * on an install still blocked at 152 it retires the epochs inside this one
--     transaction, so 152's guard sees committed retirement;
--   * on an install whose `_migrations` already recorded 152 it only installs
--     the schema (retirement DML would gain that install nothing and would cut
--     a live replica of the running version).
--
-- Retirement never invents an owner acknowledgment and never fences work that
-- was dispatched:
--   * an epoch with no pending intent carrying `effect_started_at` or
--     `recovery_started_at` is FENCED with the same server-verified
--     `durable_no_started_effects` proof `fencePageWriterRuntime` writes; its
--     pre-effect intents are cancelled and its admissions released as
--     `runtime_fenced`;
--   * an epoch that dispatched work is only QUIESCED and marked with
--     `upgrade_retired_at`. Its started intents stay `pending`: without
--     verified termination it must not be fenced, and only a fence authorises
--     outcome recovery (`reconcilePageWriteIntent`). Its admissions are
--     released as `upgrade_retired`, the third release path, justified because
--     the durable write gate below is closed in this same transaction.
--
-- Both states close the gate `assertRuntimeActive` reads, so an old process
-- that is somehow still running is refused at its next write. The epoch row is
-- also the barrier: writers take its `FOR SHARE` lock before any page lock, so
-- this transaction waits for an in-flight writer and excludes the next one.
-- The table locks below mirror that order (runtime, then admission, then the
-- hierarchy/page lifecycle advisory keys every writer takes) rather than
-- inventing a new lock graph.
--
-- Re-running is a no-op: capture requires `upgrade_retired_at IS NULL` and
-- every timestamp is COALESCEd.
--
-- Residual, documented in `docs/runbooks/immutable-page-baselines.md`: a live
-- old replica on a blocked install loses its write gate and room admissions at
-- this point (scale old replicas to 0 first if their unflushed room edits
-- matter); and pages whose started intent remains pending still need an
-- operator-proven termination fence, which a recreated container cannot supply.

ALTER TABLE page_writer_runtimes
  ADD COLUMN IF NOT EXISTS upgrade_retired_at TIMESTAMPTZ;

-- Migration 120 created this pair CHECK unnamed; discover it by definition,
-- never by an assumed name. `fence_proof` excludes the separate fence CHECK,
-- which also mentions `quiescence_ack`.
DO $$
DECLARE
  existing_name TEXT;
BEGIN
  FOR existing_name IN
    SELECT c.conname
      FROM pg_constraint c
     WHERE c.conrelid = 'page_writer_runtimes'::regclass
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) LIKE '%quiesced_at%'
       AND pg_get_constraintdef(c.oid) LIKE '%quiescence_ack%'
       AND pg_get_constraintdef(c.oid) NOT LIKE '%fence_proof%'
  LOOP
    EXECUTE format('ALTER TABLE page_writer_runtimes DROP CONSTRAINT %I', existing_name);
  END LOOP;
END $$;

-- An epoch is retired in exactly one of three shapes:
--   1. untouched (live, or never retired);
--   2. owner-acknowledged quiescence (the gate is closed by the owner);
--   3. closed by this upgrade (no acknowledgment exists; the marker says so).
-- An upgrade-retired row therefore can never be `owner_ack`-fenced: the fence
-- CHECK requires `quiescence_ack IS NOT NULL` for that proof kind.
ALTER TABLE page_writer_runtimes
  ADD CONSTRAINT page_writer_runtimes_retirement_state_check CHECK (
    (quiesced_at IS NULL AND quiescence_ack IS NULL AND upgrade_retired_at IS NULL)
    OR (quiesced_at IS NOT NULL AND quiescence_ack IS NOT NULL AND upgrade_retired_at IS NULL)
    OR (quiesced_at IS NOT NULL AND quiescence_ack IS NULL
        AND upgrade_retired_at IS NOT NULL AND upgrade_retired_at = quiesced_at)
  );

-- A room token can now end in three ways: a clean flush/disconnect, the fence
-- of its runtime, or the upgrade that closed its runtime's gate.
DO $$
DECLARE
  existing_name TEXT;
BEGIN
  FOR existing_name IN
    SELECT c.conname
      FROM pg_constraint c
     WHERE c.conrelid = 'page_runtime_admissions'::regclass
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) LIKE '%clean_disconnect%'
  LOOP
    EXECUTE format('ALTER TABLE page_runtime_admissions DROP CONSTRAINT %I', existing_name);
  END LOOP;
END $$;

ALTER TABLE page_runtime_admissions
  ADD CONSTRAINT page_runtime_admissions_release_kind_check
  CHECK (release_kind IN ('clean_disconnect', 'runtime_fenced', 'upgrade_retired'));

-- The discovery above must have left exactly the named pair CHECK, the
-- untouched fence CHECK and the release-kind CHECK. A silent zero-or-several
-- match would otherwise degrade the two guarantees those constraints carry.
DO $$ BEGIN
  IF (
    SELECT count(*) FROM pg_constraint c
     WHERE c.conrelid = 'page_writer_runtimes'::regclass
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) LIKE '%quiesced_at%'
       AND pg_get_constraintdef(c.oid) LIKE '%quiescence_ack%'
       AND pg_get_constraintdef(c.oid) NOT LIKE '%fence_proof%'
  ) <> 1
  OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'page_writer_runtimes'::regclass
       AND conname = 'page_writer_runtimes_retirement_state_check'
  )
  OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'page_writer_runtimes'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%fence_proof%'
       AND pg_get_constraintdef(oid) LIKE '%owner_quiescence_ack%'
  )
  OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'page_runtime_admissions'::regclass
       AND conname = 'page_runtime_admissions_release_kind_check'
  ) THEN
    RAISE EXCEPTION 'page_writer_upgrade_retirement_constraint_shape';
  END IF;
END $$;

DO $$
DECLARE
  awaiting_152 BOOLEAN;
  target_pages INTEGER[];
  target_pages_slot INTEGER;
BEGIN
  -- The DDL above converges every install. Retirement is only needed while the
  -- one-time 152 cutover is still pending.
  SELECT NOT EXISTS (
    SELECT 1 FROM _migrations WHERE name = '152_relocation_notion_identity.sql'
  ) INTO awaiting_152;
  IF NOT awaiting_152 THEN
    RETURN;
  END IF;

  -- Writers take their runtime epoch lock before any admission or page lock
  -- (migration 120's documented order). Holding both tables exclusively waits
  -- for every in-flight writer and excludes the next one; no writer can be
  -- holding a page lock that this transaction would wait for.
  LOCK TABLE page_writer_runtimes IN ACCESS EXCLUSIVE MODE;
  LOCK TABLE page_runtime_admissions IN ACCESS EXCLUSIVE MODE;

  CREATE TEMP TABLE upgrade_retirement_targets ON COMMIT DROP AS
  SELECT r.runtime_id,
         count(i.id) FILTER (
           WHERE i.effect_started_at IS NOT NULL OR i.recovery_started_at IS NOT NULL
         )::int AS started_intents
    FROM page_writer_runtimes r
    LEFT JOIN page_write_intents i
           ON i.runtime_id = r.runtime_id
          AND i.status = 'pending'
   WHERE r.fenced_at IS NULL
     AND (r.quiesced_at IS NULL OR r.quiescence_ack IS NULL)
     AND r.upgrade_retired_at IS NULL
   GROUP BY r.runtime_id;

  SELECT COALESCE(array_agg(page_id ORDER BY page_id), '{}') INTO target_pages
    FROM (
      SELECT unnest(i.page_ids) AS page_id
        FROM page_write_intents i
       WHERE i.status = 'pending'
         AND i.runtime_id IN (SELECT runtime_id FROM upgrade_retirement_targets)
      UNION
      SELECT a.page_id
        FROM page_runtime_admissions a
       WHERE a.released_at IS NULL
         AND (
           a.runtime_id IN (SELECT runtime_id FROM upgrade_retirement_targets)
           OR EXISTS (
             SELECT 1 FROM page_writer_runtimes r
              WHERE r.runtime_id = a.runtime_id AND r.fenced_at IS NOT NULL
           )
         )
    ) targets;

  -- Same prelude as `fencePageWriterRuntime`: hierarchy SHARE, then the
  -- ascending page lifecycle keys, before any intent/admission/page row.
  PERFORM pg_advisory_xact_lock_shared(279004);
  FOREACH target_pages_slot IN ARRAY target_pages LOOP
    PERFORM pg_advisory_xact_lock(279001, target_pages_slot);
  END LOOP;

  -- Only reservations that never started I/O are cancelled. Started intents
  -- stay pending as recovery evidence.
  UPDATE page_write_intents i
     SET status = 'cancelled',
         settled_at = NOW(),
         settlement_reason = CASE
           WHEN t.started_intents > 0 THEN 'upgrade_retired_before_effect'
           ELSE 'runtime_fenced_before_effect'
         END,
         settlement_proof = CASE
           WHEN t.started_intents > 0
             THEN jsonb_build_object('assertion', 'no_io_began', 'by', 'migration_151b')
           ELSE jsonb_build_object('assertion', 'durable_no_started_effects')
         END
    FROM upgrade_retirement_targets t
   WHERE i.runtime_id = t.runtime_id
     AND i.status = 'pending'
     AND i.effect_started_at IS NULL
     AND i.recovery_started_at IS NULL;

  -- Close the gate on every target, including the ones fenced below, so the
  -- AI-policy legacy-client window (`max(quiesced_at)`) stays conservative.
  UPDATE page_writer_runtimes r
     SET quiesced_at = COALESCE(r.quiesced_at, NOW()),
         upgrade_retired_at = COALESCE(r.upgrade_retired_at, NOW())
    FROM upgrade_retirement_targets t
   WHERE r.runtime_id = t.runtime_id;

  UPDATE page_writer_runtimes r
     SET fenced_at = NOW(),
         fence_reason = 'Retired by the schema upgrade before migration 152: durable state records no dispatched effect.',
         fence_proof = jsonb_build_object(
           'kind', 'durable_no_started_effects',
           'retiredBy', 'upgrade:migration_151b',
           'deploymentIdentity', jsonb_strip_nulls(jsonb_build_object(
             'host', CASE
               WHEN jsonb_typeof(r.deployment_identity->'host') = 'string'
                 THEN r.deployment_identity->>'host'
             END,
             'pid', CASE
               WHEN jsonb_typeof(r.deployment_identity->'pid') = 'number'
                 AND (r.deployment_identity->>'pid') ~ '^[0-9]{1,9}$'
                 THEN (r.deployment_identity->>'pid')::int
             END,
             'startedAt', CASE
               WHEN jsonb_typeof(r.deployment_identity->'startedAt') = 'string'
                 THEN r.deployment_identity->>'startedAt'
             END
           ))
         )
    FROM upgrade_retirement_targets t
   WHERE r.runtime_id = t.runtime_id
     AND t.started_intents = 0
     AND r.fenced_at IS NULL;

  UPDATE page_runtime_admissions a
     SET released_at = NOW(), release_kind = 'runtime_fenced'
    FROM upgrade_retirement_targets t
   WHERE a.runtime_id = t.runtime_id
     AND t.started_intents = 0
     AND a.released_at IS NULL;

  UPDATE page_runtime_admissions a
     SET released_at = NOW(), release_kind = 'upgrade_retired'
    FROM upgrade_retirement_targets t
   WHERE a.runtime_id = t.runtime_id
     AND t.started_intents > 0
     AND a.released_at IS NULL;

  -- Leftover room tokens of an epoch retired earlier: the fence that retired it
  -- already promised this release, and 152's guard counts every unreleased one.
  UPDATE page_runtime_admissions a
     SET released_at = NOW(), release_kind = 'runtime_fenced'
    FROM page_writer_runtimes r
   WHERE a.runtime_id = r.runtime_id
     AND r.fenced_at IS NOT NULL
     AND a.released_at IS NULL;

  INSERT INTO audit_log (action, resource_type, resource_id, metadata)
  SELECT 'PAGE_WRITER_UPGRADE_RETIREMENT',
         'page_writer_runtime',
         t.runtime_id,
         jsonb_build_object(
           'mode', CASE
             WHEN t.started_intents > 0 THEN 'gate_closed_started_work'
             ELSE 'durable_no_started_effects'
           END,
           'startedIntents', t.started_intents,
           'by', 'migration_151b'
         )
    FROM upgrade_retirement_targets t;
END $$;
