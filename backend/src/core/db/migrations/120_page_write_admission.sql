-- Shared page-write serialization and durable recovery state (#275 / #279).
--
-- Runtime-epoch row locks serialize fencing before sorted per-page advisory
-- locks. All page and subsystem row locks follow those two gates. The trigger
-- below remains defense in depth: it cannot establish cross-row lock order.

ALTER TABLE pages
  ADD COLUMN IF NOT EXISTS content_revision BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lifecycle_revision BIGINT NOT NULL DEFAULT 0;

ALTER TABLE pages
  DROP CONSTRAINT IF EXISTS pages_content_revision_nonnegative,
  DROP CONSTRAINT IF EXISTS pages_lifecycle_revision_nonnegative;

ALTER TABLE pages
  ADD CONSTRAINT pages_content_revision_nonnegative CHECK (content_revision >= 0),
  ADD CONSTRAINT pages_lifecycle_revision_nonnegative CHECK (lifecycle_revision >= 0);

-- One row is one backend-process epoch. A restart always registers a fresh
-- runtime id and immutable deployment identity. Graceful fencing uses the
-- owning process's quiescence acknowledgement. Crash fencing is allowed only
-- from the server-owned durable no-start marker or independently verified
-- local process termination; an operator assertion is never sufficient.
CREATE TABLE IF NOT EXISTS page_writer_runtimes (
  runtime_id            TEXT PRIMARY KEY,
  deployment_identity   JSONB NOT NULL,
  started_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  quiesced_at           TIMESTAMPTZ,
  quiescence_ack        UUID,
  fenced_at             TIMESTAMPTZ,
  fenced_by             UUID REFERENCES users(id) ON DELETE SET NULL,
  fence_reason          TEXT,
  fence_proof           JSONB,
  CHECK (length(runtime_id) BETWEEN 1 AND 200),
  CHECK (jsonb_typeof(deployment_identity) = 'object'),
  CHECK (
    (quiesced_at IS NULL AND quiescence_ack IS NULL)
    OR (quiesced_at IS NOT NULL AND quiescence_ack IS NOT NULL)
  ),
  CHECK (
    (fenced_at IS NULL AND fence_reason IS NULL AND fence_proof IS NULL)
    OR
    (fenced_at IS NOT NULL
      AND fence_reason IS NOT NULL
      AND length(fence_reason) BETWEEN 10 AND 1000
      AND fence_proof IS NOT NULL
      AND jsonb_typeof(fence_proof) = 'object'
      -- CHECK accepts UNKNOWN; an absent/null kind must be explicitly false.
      AND fence_proof->>'kind' IS NOT NULL
      AND fence_proof->>'kind' IN (
        'owner_quiescence_ack',
        'durable_no_started_effects',
        'verified_local_termination'
      )
      AND (
        fence_proof->>'kind' <> 'owner_quiescence_ack'
        OR quiescence_ack IS NOT NULL
      ))
  )
);

-- Writable room tokens are durable and remain active until a clean flush and
-- disconnect, or until a server-proven runtime fence retires them. Rows are
-- retained so recovery has an audit trail.
CREATE TABLE IF NOT EXISTS page_runtime_admissions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  runtime_id         TEXT NOT NULL REFERENCES page_writer_runtimes(runtime_id) ON DELETE RESTRICT,
  page_id            INTEGER NOT NULL,
  actor_id            UUID REFERENCES users(id) ON DELETE SET NULL,
  lifecycle_revision BIGINT NOT NULL CHECK (lifecycle_revision >= 0),
  admitted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  released_at        TIMESTAMPTZ,
  release_kind       TEXT CHECK (release_kind IN ('clean_disconnect', 'runtime_fenced')),
  CHECK (
    (released_at IS NULL AND release_kind IS NULL)
    OR (released_at IS NOT NULL AND release_kind IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS page_runtime_admissions_active_page_idx
  ON page_runtime_admissions(page_id)
  WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS page_runtime_admissions_active_runtime_idx
  ON page_runtime_admissions(runtime_id)
  WHERE released_at IS NULL;

-- External/file operations reserve one pending row before performing I/O.
-- Settlement rows are retained with their proof; only status='pending' blocks
-- writes and freeze.  Unknown outcomes therefore remain pending indefinitely.
CREATE TABLE IF NOT EXISTS page_write_intents (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  runtime_id            TEXT NOT NULL REFERENCES page_writer_runtimes(runtime_id) ON DELETE RESTRICT,
  kind                  TEXT NOT NULL,
  actor_id              UUID REFERENCES users(id) ON DELETE SET NULL,
  page_ids              INTEGER[] NOT NULL,
  revisions             JSONB NOT NULL,
  deleted_page_ids      INTEGER[] NOT NULL DEFAULT '{}',
  recovery_mode         TEXT NOT NULL
                          CHECK (recovery_mode IN ('local_verified', 'remote_conditional', 'remote_terminal_only')),
  effect                 JSONB NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'completed', 'cancelled', 'reconciled_applied', 'reconciled_not_applied')),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  effect_started_at     TIMESTAMPTZ,
  effect_finished_at    TIMESTAMPTZ,
  remote_effect_started_at TIMESTAMPTZ,
  remote_effects_completed_at TIMESTAMPTZ,
  remote_terminal_result  JSONB,
  recovery_started_at   TIMESTAMPTZ,
  cache_invalidation_pending BOOLEAN NOT NULL DEFAULT FALSE,
  recovery_history       JSONB NOT NULL DEFAULT '[]'::jsonb,
  settled_at             TIMESTAMPTZ,
  settled_by             UUID REFERENCES users(id) ON DELETE SET NULL,
  settlement_reason      TEXT,
  settlement_proof       JSONB,
  CHECK (kind ~ '^[a-z0-9][a-z0-9._:-]{0,99}$'),
  CHECK (cardinality(page_ids) > 0),
  CHECK (array_position(page_ids, NULL) IS NULL),
  CHECK (array_position(deleted_page_ids, NULL) IS NULL),
  CHECK (deleted_page_ids <@ page_ids),
  CHECK (jsonb_typeof(revisions) = 'object'),
  CHECK (jsonb_typeof(recovery_history) = 'array'),
  CHECK (jsonb_array_length(recovery_history) <= 32),
  CHECK (octet_length(recovery_history::text) <= 65536),
  CHECK (
    jsonb_array_length(recovery_history) = 0
    OR effect_started_at IS NOT NULL
    OR remote_effect_started_at IS NOT NULL
    OR recovery_started_at IS NOT NULL
  ),
  CHECK (jsonb_typeof(effect) = 'object'),
  CHECK (effect->>'effectClass' IN ('local', 'remote')),
  -- Closed policy: adding an intent kind is a schema/security decision, not a
  -- caller-controlled label. Remote kinds below use provider APIs without a
  -- durable idempotency/conditional primitive and therefore cannot be replayed
  -- after an unknown response.
  CHECK (
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
      kind IN ('page.ai_apply', 'page.version_restore')
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
    )
  ),
  CHECK (octet_length(effect::text) <= 32768),
  CHECK (effect_finished_at IS NULL OR effect_started_at IS NOT NULL),
  CHECK (remote_effects_completed_at IS NULL OR remote_effect_started_at IS NOT NULL),
  CHECK (remote_terminal_result IS NULL OR remote_effects_completed_at IS NOT NULL),
  CHECK (remote_terminal_result IS NULL OR jsonb_typeof(remote_terminal_result) = 'object'),
  CHECK (remote_terminal_result IS NULL OR octet_length(remote_terminal_result::text) <= 32768),
  CHECK (
    (status = 'pending'
      AND settled_at IS NULL
      AND settled_by IS NULL
      AND settlement_reason IS NULL
      AND settlement_proof IS NULL)
    OR
    (status <> 'pending'
      AND settled_at IS NOT NULL
      AND settlement_reason IS NOT NULL
      AND settlement_proof IS NOT NULL
      AND jsonb_typeof(settlement_proof) = 'object')
  )
);

CREATE INDEX IF NOT EXISTS page_write_intents_pending_pages_idx
  ON page_write_intents USING GIN(page_ids)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS page_write_intents_pending_runtime_idx
  ON page_write_intents(runtime_id)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_page_write_intents_cache_invalidation_queue
  ON page_write_intents (settled_at, id)
  WHERE cache_invalidation_pending = TRUE
    AND status IN ('completed', 'reconciled_applied', 'reconciled_not_applied');

-- Exact operation-owned recovery state, not payload in the generic intent.
-- Original actor identity survives account deletion; recovery still requires
-- the original live actor from the intent. Terminal settlement removes this
-- preparation in the same transaction, releasing its page deletion guard.
CREATE TABLE IF NOT EXISTS page_relocation_preparations (
  intent_id UUID PRIMARY KEY REFERENCES page_write_intents(id) ON DELETE RESTRICT,
  page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE RESTRICT,
  direction TEXT NOT NULL CHECK (direction IN ('to_confluence', 'to_local')),
  actor_id UUID NOT NULL,
  target_space_key TEXT,
  target_visibility TEXT CHECK (target_visibility IS NULL OR target_visibility IN ('private', 'shared')),
  original_source TEXT NOT NULL,
  original_confluence_id TEXT,
  original_space_key TEXT,
  original_title TEXT NOT NULL,
  original_body_html TEXT,
  original_body_storage TEXT,
  original_body_text TEXT,
  original_version INTEGER NOT NULL,
  original_visibility TEXT NOT NULL,
  original_created_by_user_id UUID,
  original_inherit_perms BOOLEAN NOT NULL,
  original_local_modified_at TIMESTAMPTZ,
  original_local_modified_by UUID,
  original_embedding_dirty BOOLEAN NOT NULL,
  original_image_analysis_dirty BOOLEAN NOT NULL,
  original_embedding_status TEXT,
  original_embedded_at TIMESTAMPTZ,
  original_key TEXT NOT NULL,
  child_ids INTEGER[] NOT NULL CHECK (array_position(child_ids, NULL) IS NULL),
  access_control_entries JSONB NOT NULL CHECK (jsonb_typeof(access_control_entries) = 'array'),
  attachments JSONB NOT NULL CHECK (jsonb_typeof(attachments) = 'array'),
  expected_remote_title_sha256 TEXT CHECK (
    expected_remote_title_sha256 IS NULL OR expected_remote_title_sha256 ~ '^[a-f0-9]{64}$'
  ),
  expected_remote_body_storage_sha256 TEXT CHECK (
    expected_remote_body_storage_sha256 IS NULL OR expected_remote_body_storage_sha256 ~ '^[a-f0-9]{64}$'
  ),
  parent_confluence_id TEXT,
  -- Bounded provider receipts are operation-owned progress. A successful
  -- create/upload is never compensated merely because later work failed.
  created_confluence_id TEXT CHECK (
    created_confluence_id IS NULL OR length(created_confluence_id) BETWEEN 1 AND 1000
  ),
  created_page_receipt JSONB CHECK (
    created_page_receipt IS NULL
    OR (
      jsonb_typeof(created_page_receipt) = 'object'
      AND octet_length(created_page_receipt::text) <= 4096
    )
  ),
  attachment_receipts JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (
    jsonb_typeof(attachment_receipts) = 'array'
    AND jsonb_array_length(attachment_receipts) <= jsonb_array_length(attachments)
    -- Receipt fields are bounded to 1000/1000/255 UTF-16 code units. Even
    -- JSON-escaped control characters fit 16 KiB per admitted attachment.
    -- Capacity scales with the original inventory, never an arbitrary count cap.
    AND octet_length(attachment_receipts::text)
      <= 2 + 16384::bigint * jsonb_array_length(attachments)
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (direction = 'to_confluence'
      AND expected_remote_title_sha256 IS NOT NULL
      AND expected_remote_body_storage_sha256 IS NOT NULL)
    OR (
      direction = 'to_local'
      AND created_confluence_id IS NULL
      AND created_page_receipt IS NULL
      AND attachment_receipts = '[]'::jsonb
    )
  ),
  CHECK (
    created_page_receipt IS NULL
    OR (
      created_page_receipt->>'id' IS NOT NULL
      AND created_page_receipt->>'id' = created_confluence_id
    )
  )
);
CREATE INDEX IF NOT EXISTS page_relocation_preparations_page_idx
  ON page_relocation_preparations(page_id);

CREATE OR REPLACE FUNCTION enforce_page_protected_write() RETURNS trigger AS $$
DECLARE
  protected_change BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- baseline_id is added by 121_page_baselines.sql.  Migrations finish before
    -- application startup, so every execution of this trigger sees that field.
    IF OLD.baseline_id IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'page_is_frozen',
        DETAIL = 'Protected page deletion requires an editable lifecycle state.';
    END IF;
    RETURN OLD;
  END IF;

  protected_change :=
       NEW.title IS DISTINCT FROM OLD.title
    OR NEW.body_html IS DISTINCT FROM OLD.body_html
    OR NEW.body_storage IS DISTINCT FROM OLD.body_storage
    OR NEW.body_text IS DISTINCT FROM OLD.body_text
    OR NEW.version IS DISTINCT FROM OLD.version
    OR NEW.labels IS DISTINCT FROM OLD.labels
    OR NEW.parent_id IS DISTINCT FROM OLD.parent_id
    OR NEW.confluence_id IS DISTINCT FROM OLD.confluence_id
    OR NEW.source IS DISTINCT FROM OLD.source
    OR NEW.space_key IS DISTINCT FROM OLD.space_key
    OR NEW.page_type IS DISTINCT FROM OLD.page_type
    OR NEW.path IS DISTINCT FROM OLD.path
    OR NEW.depth IS DISTINCT FROM OLD.depth
    OR NEW.sort_order IS DISTINCT FROM OLD.sort_order
    OR NEW.icon_kind IS DISTINCT FROM OLD.icon_kind
    OR NEW.icon_value IS DISTINCT FROM OLD.icon_value
    OR NEW.icon_color IS DISTINCT FROM OLD.icon_color
    OR NEW.icon_filled IS DISTINCT FROM OLD.icon_filled
    OR NEW.draft_body_html IS DISTINCT FROM OLD.draft_body_html
    OR NEW.draft_body_storage IS DISTINCT FROM OLD.draft_body_storage
    OR NEW.draft_body_text IS DISTINCT FROM OLD.draft_body_text
    OR NEW.draft_updated_at IS DISTINCT FROM OLD.draft_updated_at
    OR NEW.draft_updated_by IS DISTINCT FROM OLD.draft_updated_by
    OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
    OR NEW.content_revision IS DISTINCT FROM OLD.content_revision;

  IF protected_change AND OLD.baseline_id IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'page_is_frozen',
      DETAIL = 'Protected page content cannot change while a baseline is active.';
  END IF;

  IF protected_change THEN
    -- Override a caller-supplied value so a protected UPDATE advances exactly
    -- once.  Attachment-only writers explicitly update content_revision while
    -- holding the shared lifecycle lock and therefore take this same branch.
    NEW.content_revision := OLD.content_revision + 1;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pages_protected_write_trigger ON pages;
CREATE TRIGGER pages_protected_write_trigger
  BEFORE UPDATE OR DELETE ON pages
  FOR EACH ROW EXECUTE FUNCTION enforce_page_protected_write();

-- SQL-only writers have no external-effect intent. Coalesce their committed
-- read-model changes per page rather than retaining an audit row per autosave.
-- No FK: a hard deletion must remain publishable after the page is gone.
CREATE TABLE IF NOT EXISTS page_cache_invalidation_queue (
  page_id INTEGER PRIMARY KEY,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS page_cache_invalidation_queue_order_idx
  ON page_cache_invalidation_queue(queued_at, page_id);

CREATE OR REPLACE FUNCTION enqueue_page_cache_invalidation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.content_revision IS NOT DISTINCT FROM OLD.content_revision
     AND NEW.lifecycle_revision IS NOT DISTINCT FROM OLD.lifecycle_revision
     AND NEW.visibility IS NOT DISTINCT FROM OLD.visibility
     AND NEW.created_by_user_id IS NOT DISTINCT FROM OLD.created_by_user_id
     AND NEW.inherit_perms IS NOT DISTINCT FROM OLD.inherit_perms THEN
    RETURN NULL;
  END IF;
  INSERT INTO page_cache_invalidation_queue (page_id)
    VALUES (CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END)
    -- The no-op update retains the conflicting tuple lock until this writer
    -- commits. DO NOTHING releases it early, allowing a publisher to delete
    -- the queue row before the page change becomes visible.
    ON CONFLICT (page_id) DO UPDATE
      SET queued_at = page_cache_invalidation_queue.queued_at;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pages_cache_invalidation_trigger ON pages;
CREATE TRIGGER pages_cache_invalidation_trigger
  AFTER INSERT OR UPDATE OR DELETE ON pages
  FOR EACH ROW EXECUTE FUNCTION enqueue_page_cache_invalidation();
