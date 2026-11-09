-- #1881 — CE-owned article AI policy activation.
--
-- Three things live here, every statement idempotent so fresh, upgrade and
-- re-run paths converge on one shape:
--
--   1. `ai_policy_activation_state`: the durable, cluster-wide enforcement
--      switch (actor + time recorded; every transition is also an audit event).
--      Seeded DISABLED with no actor. `observing_since` is the moment this
--      schema — and so the legacy-client observer — was installed.
--   2. `ai_policy_legacy_client_observations`: attributed observations of
--      browser sessions issued to pre-#1881 bundles.
--   3. The binary one-way door: `page_writer_runtimes.ai_policy_enforcement_version`
--      plus two guards that serialize against each other in both orders on
--      the activation row. Once the switch is on or any restriction exists, a
--      policy-unaware binary (version 0: it omits the column) cannot register;
--      while such a binary is active, no restriction can be created. The door
--      is keyed on `enabled OR restrictions exist`, independent of the switch,
--      so turning the switch off weakens nothing that is stored.

-- ─── 1. Activation state singleton ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_policy_activation_state (
  singleton                   BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  enabled                     BOOLEAN NOT NULL DEFAULT FALSE,
  changed_at                  TIMESTAMPTZ,
  changed_by_user_id          UUID REFERENCES users(id) ON DELETE SET NULL,
  changed_by_name             TEXT,
  legacy_clients_acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
  observing_since             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO ai_policy_activation_state (singleton, enabled)
VALUES (TRUE, FALSE)
ON CONFLICT (singleton) DO NOTHING;

-- ─── 2. Legacy browser-session observations ─────────────────────────────────
-- `token_expires_at` is fixed at issuance (NOW() + access-token lifetime), so
-- a later ACCESS_TOKEN_EXPIRY change cannot mis-measure the window.
CREATE TABLE IF NOT EXISTS ai_policy_legacy_client_observations (
  user_id          UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_seen_at     TIMESTAMPTZ NOT NULL,
  token_expires_at TIMESTAMPTZ NOT NULL,
  observations     INTEGER NOT NULL DEFAULT 1
);

-- ─── 3. Runtime protocol version ────────────────────────────────────────────
-- This build registers 1 (`AI_POLICY_ENFORCEMENT_VERSION`, beside
-- `PAGE_WRITER_ENFORCEMENT_VERSION` in `registerRuntimeOnClient`). Older
-- binaries omit the column and therefore register as version 0.
ALTER TABLE page_writer_runtimes
  ADD COLUMN IF NOT EXISTS ai_policy_enforcement_version INTEGER NOT NULL DEFAULT 0
    CHECK (ai_policy_enforcement_version >= 0);

-- Both guard checks are index probes.
CREATE INDEX IF NOT EXISTS pages_ai_policy_restricted_idx
  ON pages (id)
  WHERE ai_policy <> 'all';
CREATE INDEX IF NOT EXISTS page_writer_runtimes_ai_policy_incompatible_idx
  ON page_writer_runtimes (runtime_id)
  WHERE fenced_at IS NULL AND quiesced_at IS NULL AND ai_policy_enforcement_version <> 1;

-- ─── 4. Registration guard ──────────────────────────────────────────────────
-- A genuinely new, active, version-0 row (a process start holding no page
-- locks) takes the activation row FOR UPDATE and is refused while the switch
-- is on or any page — soft-deleted included, fail closed — is restricted.
-- Version 1 returns at once, and so do re-registrations (the per-admission
-- `INSERT … ON CONFLICT DO NOTHING` of an existing runtime id) and rows that
-- are already fenced/quiesced: none of them lock, so an old binary's
-- re-registration can never deadlock with a new binary's tightening.
-- The lock and the existence checks are SEPARATE statements: after the lock
-- wait, the checks run on a fresh snapshot and see what the holder committed.
CREATE OR REPLACE FUNCTION guard_ai_policy_runtime_registration()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ai_policy_enforcement_version = 1 THEN
    RETURN NEW;
  END IF;
  IF NEW.fenced_at IS NOT NULL OR NEW.quiesced_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' AND EXISTS (
    SELECT 1 FROM page_writer_runtimes WHERE runtime_id = NEW.runtime_id
  ) THEN
    RETURN NEW;
  END IF;

  PERFORM 1 FROM ai_policy_activation_state WHERE singleton = TRUE FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Article AI policy activation state is unavailable';
  END IF;

  IF EXISTS (SELECT 1 FROM ai_policy_activation_state WHERE singleton = TRUE AND enabled)
     OR EXISTS (SELECT 1 FROM pages WHERE ai_policy <> 'all') THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      CONSTRAINT = 'ai_policy_incompatible_runtime_registration',
      MESSAGE = 'This writer does not support the installed article AI policy enforcement protocol';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_ai_policy_runtime_registration ON page_writer_runtimes;
CREATE TRIGGER guard_ai_policy_runtime_registration
  BEFORE INSERT OR UPDATE OF ai_policy_enforcement_version ON page_writer_runtimes
  FOR EACH ROW EXECUTE FUNCTION guard_ai_policy_runtime_registration();

-- ─── 5. Tightening guard ────────────────────────────────────────────────────
-- AFTER the row change, so it sees the value the BEFORE INSERT label trigger
-- (migration 135) produced. The WHEN clauses below pre-filter cheaply; the
-- function decides "stricter": any restrictive INSERT counts, an UPDATE only
-- when `ai_policy_rank` rises. A tightening takes the activation row FOR
-- SHARE (so tightenings never contend with each other, while a registration
-- or an enabling transition — both FOR UPDATE — waits for in-flight ones) and
-- is refused while any active runtime does not enforce the protocol. This
-- covers every writer — the policy primitive, creation INSERTs, recovery
-- replay, deferred ingestion, and a stale-enabled process cache — without
-- trusting application code. The error is recognized by its constraint name
-- (`isAiPolicyRuntimeGuardError`); HTTP maps it to 409
-- `ai_policy_enforcement_unavailable`, workers and recovery stay pending.
CREATE OR REPLACE FUNCTION guard_ai_policy_tightening()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ai_policy = 'all' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND ai_policy_rank(NEW.ai_policy) <= ai_policy_rank(OLD.ai_policy) THEN
    RETURN NULL;
  END IF;

  PERFORM 1 FROM ai_policy_activation_state WHERE singleton = TRUE FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Article AI policy activation state is unavailable';
  END IF;

  IF EXISTS (
    SELECT 1 FROM page_writer_runtimes
     WHERE fenced_at IS NULL AND quiesced_at IS NULL AND ai_policy_enforcement_version <> 1
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      CONSTRAINT = 'ai_policy_incompatible_runtime_active',
      MESSAGE = 'Restrictive AI policies cannot be stored while a writer that does not enforce them is active';
  END IF;
  RETURN NULL;
END;
$$;

-- One function, two triggers: a trigger declared for INSERT OR UPDATE cannot
-- reference OLD in its WHEN clause, and the INSERT arm must not.
DROP TRIGGER IF EXISTS guard_ai_policy_tightening_insert ON pages;
CREATE TRIGGER guard_ai_policy_tightening_insert
  AFTER INSERT ON pages
  FOR EACH ROW WHEN (NEW.ai_policy <> 'all')
  EXECUTE FUNCTION guard_ai_policy_tightening();

DROP TRIGGER IF EXISTS guard_ai_policy_tightening_update ON pages;
CREATE TRIGGER guard_ai_policy_tightening_update
  AFTER UPDATE ON pages
  FOR EACH ROW WHEN (NEW.ai_policy IS DISTINCT FROM OLD.ai_policy)
  EXECUTE FUNCTION guard_ai_policy_tightening();
