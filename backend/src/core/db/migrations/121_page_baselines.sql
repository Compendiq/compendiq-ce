-- #275 immutable article baselines. Migration 120 owns content/lifecycle
-- revisions and writer admission. This migration owns the retained evidence,
-- live freeze metadata, governance marker, activation gate, and delivery outbox.

CREATE TABLE page_baseline_feature_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  creation_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  activated_at TIMESTAMPTZ,
  activated_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  activated_by_name TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (creation_enabled AND activated_at IS NOT NULL AND activated_by_name IS NOT NULL)
    OR (NOT creation_enabled)
  )
);
INSERT INTO page_baseline_feature_state (singleton, creation_enabled)
VALUES (TRUE, FALSE)
ON CONFLICT (singleton) DO NOTHING;

-- The singleton is locked before reserving bytes. It makes concurrent preview
-- quota checks exact without evicting published evidence. DB-proven abandoned
-- preparations release this logical reservation and are eligible for the
-- guarded retained-path cleanup; filesystem headroom is checked independently.
CREATE TABLE page_baseline_capacity (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  reserved_bytes BIGINT NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO page_baseline_capacity (singleton) VALUES (TRUE)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE page_baselines (
  id UUID PRIMARY KEY,
  page_id INTEGER REFERENCES pages(id) ON DELETE SET NULL,
  original_page_id INTEGER NOT NULL CHECK (original_page_id > 0),
  page_identity JSONB NOT NULL CHECK (jsonb_typeof(page_identity) = 'array'),
  version INTEGER NOT NULL CHECK (version > 0),
  content_revision BIGINT NOT NULL CHECK (content_revision >= 0),
  lifecycle_revision BIGINT NOT NULL CHECK (lifecycle_revision >= 0),
  manifest_version INTEGER NOT NULL DEFAULT 1 CHECK (manifest_version = 1),
  manifest_digest TEXT NOT NULL CHECK (manifest_digest ~ '^[a-f0-9]{64}$'),
  manifest JSONB NOT NULL CHECK (jsonb_typeof(manifest) = 'array'),
  manifest_bytes BYTEA NOT NULL,
  title TEXT NOT NULL,
  body_html TEXT,
  body_storage TEXT,
  body_text TEXT,
  labels TEXT[] NOT NULL DEFAULT '{}',
  parent_identity JSONB CHECK (parent_identity IS NULL OR jsonb_typeof(parent_identity) = 'array'),
  icon JSONB,
  attachments JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(attachments) = 'array'),
  total_bytes BIGINT NOT NULL CHECK (total_bytes >= 0),
  reserved_bytes BIGINT NOT NULL CHECK (reserved_bytes >= 0),
  status TEXT NOT NULL DEFAULT 'preparing'
    CHECK (status IN ('preparing', 'prepared', 'published', 'abandoned')),
  prepared_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  prepared_by_name TEXT NOT NULL,
  preparation_intent_id UUID NOT NULL REFERENCES page_write_intents(id) ON DELETE RESTRICT,
  prepared_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  published_by_name TEXT,
  published_at TIMESTAMPTZ,
  provenance TEXT CHECK (provenance IN ('manual_assertion', 'authenticated_approval')),
  freeze_reason TEXT,
  reported_signatories JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(reported_signatories) = 'array'),
  reported_reference TEXT,
  version_snapshot_id UUID REFERENCES page_versions(id) ON DELETE SET NULL,
  abandoned_at TIMESTAMPTZ,
  CHECK (
    (status IN ('preparing', 'prepared')
        AND published_at IS NULL AND provenance IS NULL AND abandoned_at IS NULL)
    OR (status = 'published' AND published_at IS NOT NULL AND published_by_name IS NOT NULL
        AND provenance IS NOT NULL AND freeze_reason IS NOT NULL AND abandoned_at IS NULL)
    OR (status = 'abandoned' AND published_at IS NULL AND provenance IS NULL AND abandoned_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX page_baselines_active_preparation_unique
  ON page_baselines (original_page_id, prepared_by_user_id, content_revision, lifecycle_revision)
  WHERE status IN ('preparing', 'prepared');
CREATE INDEX page_baselines_live_page_idx ON page_baselines (page_id, published_at DESC)
  WHERE status = 'published';
CREATE INDEX page_baselines_original_page_idx ON page_baselines (original_page_id, published_at DESC)
  WHERE status = 'published';
CREATE INDEX page_baselines_manifest_digest_idx ON page_baselines (manifest_digest);
CREATE INDEX page_baselines_version_snapshot_idx ON page_baselines (version_snapshot_id)
  WHERE version_snapshot_id IS NOT NULL;

ALTER TABLE pages ADD COLUMN baseline_id UUID REFERENCES page_baselines(id) ON DELETE RESTRICT;
ALTER TABLE pages ADD COLUMN frozen_version INTEGER;
ALTER TABLE pages ADD COLUMN frozen_at TIMESTAMPTZ;
ALTER TABLE pages ADD COLUMN frozen_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE pages ADD COLUMN frozen_by_name TEXT;
ALTER TABLE pages ADD COLUMN freeze_reason TEXT;
ALTER TABLE pages ADD COLUMN freeze_provenance TEXT
  CHECK (freeze_provenance IN ('manual_assertion', 'authenticated_approval'));
ALTER TABLE pages ADD COLUMN freeze_reported_signatories JSONB;
ALTER TABLE pages ADD COLUMN freeze_reported_reference TEXT;
ALTER TABLE pages ADD CONSTRAINT pages_freeze_state_complete CHECK (
  (baseline_id IS NULL AND frozen_version IS NULL AND frozen_at IS NULL
    AND frozen_by_name IS NULL AND freeze_reason IS NULL AND freeze_provenance IS NULL
    AND freeze_reported_signatories IS NULL AND freeze_reported_reference IS NULL)
  OR
  (baseline_id IS NOT NULL AND frozen_version IS NOT NULL AND frozen_at IS NOT NULL
    AND frozen_by_name IS NOT NULL AND freeze_reason IS NOT NULL AND freeze_provenance IS NOT NULL
    AND freeze_reported_signatories IS NOT NULL)
);
CREATE INDEX pages_frozen_idx ON pages (id) WHERE baseline_id IS NOT NULL;

-- Installation belongs with baseline_id: an older process can still write
-- after migration 120 commits and before this migration acquires its locks.
DROP TRIGGER IF EXISTS pages_protected_write_trigger ON pages;
CREATE TRIGGER pages_protected_write_trigger
  BEFORE UPDATE OR DELETE ON pages
  FOR EACH ROW EXECUTE FUNCTION enforce_page_protected_write();

CREATE TABLE page_baseline_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id INTEGER REFERENCES pages(id) ON DELETE SET NULL,
  original_page_id INTEGER NOT NULL CHECK (original_page_id > 0),
  baseline_id UUID NOT NULL REFERENCES page_baselines(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('freeze', 'thaw')),
  version INTEGER NOT NULL CHECK (version > 0),
  manifest_digest TEXT NOT NULL CHECK (manifest_digest ~ '^[a-f0-9]{64}$'),
  content_revision BIGINT NOT NULL CHECK (content_revision >= 0),
  lifecycle_revision BIGINT NOT NULL CHECK (lifecycle_revision >= 0),
  reason TEXT NOT NULL,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_display_name TEXT NOT NULL,
  provenance TEXT NOT NULL CHECK (provenance IN ('manual_assertion', 'authenticated_approval')),
  reported_signatories JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(reported_signatories) = 'array'),
  reported_reference TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (original_page_id, lifecycle_revision)
);
CREATE INDEX page_baseline_history_page_cursor_idx
  ON page_baseline_history (original_page_id, created_at, id);
CREATE INDEX page_baseline_history_baseline_cursor_idx
  ON page_baseline_history (baseline_id, created_at, id);

-- This marker remains in CE independently of plugin/license state. A true row
-- is a mandatory manual-finalization veto until a registered governance hook
-- successfully revalidates and finalizes inside the lifecycle transaction.
CREATE TABLE page_governance_policies (
  space_key TEXT PRIMARY KEY,
  governance_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  policy_revision BIGINT NOT NULL DEFAULT 1 CHECK (policy_revision > 0),
  updated_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by_name TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX page_governance_policies_enabled_idx ON page_governance_policies (space_key)
  WHERE governance_enabled;

CREATE TABLE page_lifecycle_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id INTEGER NOT NULL CHECK (page_id > 0),
  lifecycle_revision BIGINT NOT NULL CHECK (lifecycle_revision >= 0),
  event JSONB NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT,
  delivered_at TIMESTAMPTZ,
  claimed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (page_id, lifecycle_revision)
);
CREATE INDEX page_lifecycle_outbox_pending_idx
  ON page_lifecycle_outbox (next_attempt_at, created_at)
  WHERE delivered_at IS NULL;

CREATE OR REPLACE FUNCTION protect_page_baseline_row() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'abandoned' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'preparing, prepared, and published page baselines cannot be deleted';
  END IF;

  -- FK retention actions may only erase live locators. Immutable snapshots,
  -- actor display names, content and publication fields must remain identical.
  IF OLD.status = NEW.status
     AND (NEW.page_id IS NOT DISTINCT FROM OLD.page_id
          OR (OLD.page_id IS NOT NULL AND NEW.page_id IS NULL))
     AND (NEW.prepared_by_user_id IS NOT DISTINCT FROM OLD.prepared_by_user_id
          OR (OLD.prepared_by_user_id IS NOT NULL AND NEW.prepared_by_user_id IS NULL))
     AND (NEW.published_by_user_id IS NOT DISTINCT FROM OLD.published_by_user_id
          OR (OLD.published_by_user_id IS NOT NULL AND NEW.published_by_user_id IS NULL))
     AND (NEW.version_snapshot_id IS NOT DISTINCT FROM OLD.version_snapshot_id
          OR (OLD.version_snapshot_id IS NOT NULL AND NEW.version_snapshot_id IS NULL))
     AND (
       to_jsonb(NEW) - ARRAY[
         'page_id', 'prepared_by_user_id', 'published_by_user_id', 'version_snapshot_id'
       ]::text[]
       =
       to_jsonb(OLD) - ARRAY[
         'page_id', 'prepared_by_user_id', 'published_by_user_id', 'version_snapshot_id'
       ]::text[]
     )
  THEN
    RETURN NEW;
  END IF;

  IF (OLD.status = 'preparing' AND NEW.status IN ('prepared', 'abandoned'))
     OR (OLD.status = 'prepared' AND NEW.status IN ('published', 'abandoned'))
  THEN
    IF ROW(
      NEW.id, NEW.page_id, NEW.original_page_id, NEW.page_identity, NEW.version,
      NEW.content_revision, NEW.lifecycle_revision, NEW.manifest_version,
      NEW.manifest_digest, NEW.manifest, NEW.manifest_bytes, NEW.title,
      NEW.body_html, NEW.body_storage, NEW.body_text, NEW.labels,
      NEW.parent_identity, NEW.icon, NEW.attachments, NEW.total_bytes,
      NEW.reserved_bytes, NEW.prepared_by_user_id, NEW.prepared_by_name,
      NEW.preparation_intent_id, NEW.prepared_at
    ) IS DISTINCT FROM ROW(
      OLD.id, OLD.page_id, OLD.original_page_id, OLD.page_identity, OLD.version,
      OLD.content_revision, OLD.lifecycle_revision, OLD.manifest_version,
      OLD.manifest_digest, OLD.manifest, OLD.manifest_bytes, OLD.title,
      OLD.body_html, OLD.body_storage, OLD.body_text, OLD.labels,
      OLD.parent_identity, OLD.icon, OLD.attachments, OLD.total_bytes,
      OLD.reserved_bytes, OLD.prepared_by_user_id, OLD.prepared_by_name,
      OLD.preparation_intent_id, OLD.prepared_at
    ) THEN
      RAISE EXCEPTION 'immutable baseline preparation fields cannot change';
    END IF;
    IF NEW.status = 'prepared'
       AND to_jsonb(NEW) - 'status' <> to_jsonb(OLD) - 'status'
    THEN
      RAISE EXCEPTION 'preparation completion may only change status';
    END IF;
    IF NEW.status = 'abandoned'
       AND to_jsonb(NEW) - ARRAY['status', 'abandoned_at']::text[]
           <> to_jsonb(OLD) - ARRAY['status', 'abandoned_at']::text[]
    THEN
      RAISE EXCEPTION 'preparation abandonment may only set its timestamp';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'page baseline transition is immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER page_baselines_immutable
  BEFORE UPDATE OR DELETE ON page_baselines
  FOR EACH ROW EXECUTE FUNCTION protect_page_baseline_row();

CREATE OR REPLACE FUNCTION protect_page_baseline_history_row() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.page_id IS NOT DISTINCT FROM OLD.page_id
          OR (OLD.page_id IS NOT NULL AND NEW.page_id IS NULL))
     AND (NEW.actor_user_id IS NOT DISTINCT FROM OLD.actor_user_id
          OR (OLD.actor_user_id IS NOT NULL AND NEW.actor_user_id IS NULL))
     AND (
       to_jsonb(NEW) - ARRAY['page_id', 'actor_user_id']::text[]
       =
       to_jsonb(OLD) - ARRAY['page_id', 'actor_user_id']::text[]
     )
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'page baseline history is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER page_baseline_history_append_only
  BEFORE UPDATE OR DELETE ON page_baseline_history
  FOR EACH ROW EXECUTE FUNCTION protect_page_baseline_history_row();
