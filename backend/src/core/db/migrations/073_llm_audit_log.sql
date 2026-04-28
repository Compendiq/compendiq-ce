-- Migration 073: llm_audit_log table + P0f columns (Compendiq/compendiq-ee#115)
--
-- Backing store for the LLM Usage & Safety Attestation (Report 5) of the
-- compliance report generator. The CE default writer registered via
-- `setLlmAuditHook(...)` persists each `LlmAuditEntry` here as a single row;
-- writes are fire-and-forget so the LLM call path never blocks on the insert.
--
-- ── Why this migration is "create OR augment" shaped ──────────────
-- The Enterprise Edition (compendiq-ee) ships its own
-- `overlay/backend/src/core/db/migrations/060_llm_audit_log.sql` which
-- already creates `llm_audit_log` with a slightly different column set
-- (no prompt_hash, no prompt_injection_detected, no sanitized — those
-- are exactly the gaps #115 P0f asks for). When the EE merged build runs
-- migrations, 060 lands first, then this 073 must NOT collide. So:
--
--   CREATE TABLE IF NOT EXISTS — no-ops in EE deployments
--   ALTER TABLE ADD COLUMN IF NOT EXISTS — adds the P0f delta in either
--                                          deployment
--   CREATE INDEX IF NOT EXISTS — idempotent
--
-- The result: CE-only deployments get a freshly-created table with the
-- full schema; EE deployments keep their existing 060 table augmented
-- with the three new columns the writer + Report 5 need.
--
-- ── Acceptance criteria from #115 P0f ─────────────────────────────
--   * `prompt_injection_detected` boolean — set TRUE when the heuristic
--     in `core/utils/sanitize-llm-input.ts` flagged the prompt before the
--     upstream call.
--   * `sanitized` boolean — set TRUE when the sanitizer rewrote the prompt.
--   * `prompt_hash` SHA-256 hex — required so Report 5 can attest "we
--     captured the prompt fingerprint" without persisting plaintext.
--     EE writers that elect to store plaintext (gated by an admin
--     setting) write to the existing input_text/output_text columns
--     introduced by EE 060; this migration does not change that policy.

-- 1. CE-only deployments: create the table with the columns Report 5 needs.
--    The shape mirrors the canonical CE-side LlmAuditEntry contract and is
--    intentionally a SUBSET of the EE 060 column set (which has additional
--    plaintext storage columns gated by an admin setting in EE only).
CREATE TABLE IF NOT EXISTS llm_audit_log (
  id                          BIGSERIAL    PRIMARY KEY,

  -- Nullable: background workers (summary, auto-tag) and other system
  -- jobs run without a user context. ON DELETE SET NULL preserves the
  -- audit trail when a user is hard-deleted.
  user_id                     UUID         NULL REFERENCES users(id) ON DELETE SET NULL,

  -- Action taxonomy (matches LlmAuditEntry.action: chat | ask | improve
  -- | generate | summarize | embed | quality | tag | diagram). Kept TEXT
  -- (not enum) so EE writers can extend without a schema change.
  action                      TEXT         NULL,

  model                       TEXT         NULL,
  provider                    TEXT         NULL,

  input_tokens                INTEGER      NOT NULL DEFAULT 0,
  output_tokens               INTEGER      NOT NULL DEFAULT 0,

  duration_ms                 INTEGER      NOT NULL DEFAULT 0,
  status                      TEXT         NOT NULL DEFAULT 'success',
  error_message               TEXT         NULL,

  created_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- 2. P0f delta — add the three columns the LLM Usage attestation needs,
--    in BOTH deployments. ADD COLUMN IF NOT EXISTS is idempotent on
--    re-runs and on the EE-already-created table.
ALTER TABLE llm_audit_log
  ADD COLUMN IF NOT EXISTS prompt_hash               TEXT,
  ADD COLUMN IF NOT EXISTS prompt_injection_detected BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS sanitized                 BOOLEAN NOT NULL DEFAULT FALSE;

-- 3. Time-window scans: Report 5 selects rows in a fixed `created_at` range.
CREATE INDEX IF NOT EXISTS idx_llm_audit_log_created_at
  ON llm_audit_log (created_at DESC);

-- 4. Per-user attestation. Partial index keeps it small.
CREATE INDEX IF NOT EXISTS idx_llm_audit_log_user_id
  ON llm_audit_log (user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

-- 5. "All PII incidents in window" — small partial index, only the rows
--    that tripped the prompt-injection heuristic.
CREATE INDEX IF NOT EXISTS idx_llm_audit_log_pii
  ON llm_audit_log (created_at DESC)
  WHERE prompt_injection_detected = TRUE;

-- 6. Per-action breakdown for Report 5's per-action volumes.
CREATE INDEX IF NOT EXISTS idx_llm_audit_log_action
  ON llm_audit_log (action, created_at DESC);
