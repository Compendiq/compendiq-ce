-- Migration 073: llm_audit_log table (Compendiq/compendiq-ee#115 P0f)
--
-- Backing store for the LLM Usage & Safety Attestation (Report 5) of the
-- compliance report generator. The CE default writer registered via
-- `setLlmAuditHook(...)` persists each `LlmAuditEntry` here as a single row;
-- writes are fire-and-forget so the LLM call path never blocks on the insert.
--
-- Acceptance criteria from #115:
--   * `prompt_injection_detected` boolean — set TRUE when the heuristic
--     in `core/utils/sanitize-llm-input.ts` flagged the prompt before the
--     upstream call.
--   * `sanitized` boolean — set TRUE when the sanitizer rewrote the prompt
--     (i.e. `wasModified` returned TRUE from `sanitizeLlmInput`).
--   * Plaintext prompts MUST NOT be persisted; only `prompt_hash`
--     (SHA-256 hex) is stored. EE writers that override this hook may
--     introduce additional encrypted-at-rest columns; CE keeps only the hash.
--
-- This table is intentionally separate from the generic `audit_log`
-- (migration 010) because LLM events have a different schema (per-row PII
-- columns, token counts, latency) and the bulk-query patterns Report 5
-- needs (per-time-window, per-user, "all PII incidents") are distinct
-- from the auth/RBAC events that flow into `audit_log`.

CREATE TABLE IF NOT EXISTS llm_audit_log (
  id                          BIGSERIAL    PRIMARY KEY,

  -- Nullable: background workers (summary, auto-tag) and other system
  -- jobs run without a user context. ON DELETE SET NULL preserves the
  -- audit trail when a user is hard-deleted (mirrors the policy applied
  -- to `audit_log.user_id` in migration 062).
  user_id                     UUID         NULL REFERENCES users(id) ON DELETE SET NULL,

  -- Nullable: provider rows can be deleted (RESTRICT-protected only when
  -- referenced from llm_usecase_assignments, not from this audit table).
  -- We snapshot `provider_name` and `model` separately so historical
  -- rows remain meaningful after a provider is removed.
  provider_id                 UUID         NULL REFERENCES llm_providers(id) ON DELETE SET NULL,
  provider_name               TEXT         NULL,
  model                       TEXT         NULL,

  -- usecase taxonomy mirrors `llm_usecase_assignments.usecase`
  -- (`chat | summary | quality | auto_tag | embedding`) plus the call-site
  -- actions in `LlmAuditEntry.action` (`ask | improve | generate | …`).
  -- Kept TEXT (not enum) so EE writers can extend without a schema change.
  usecase                     TEXT         NULL,

  -- SHA-256 hex of the concatenated prompt content. Plaintext prompts
  -- MUST NOT be stored here; the writer hashes before INSERT.
  prompt_hash                 TEXT         NOT NULL,

  prompt_token_count          INTEGER      NULL,
  completion_token_count      INTEGER      NULL,

  prompt_injection_detected   BOOLEAN      NOT NULL DEFAULT FALSE,
  sanitized                   BOOLEAN      NOT NULL DEFAULT FALSE,

  latency_ms                  INTEGER      NULL,
  error                       TEXT         NULL,

  created_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Time-window scans: Report 5 selects rows in a fixed `created_at` range.
CREATE INDEX IF NOT EXISTS idx_llm_audit_log_created_at
  ON llm_audit_log (created_at DESC);

-- Per-user attestation. Partial index keeps it small — system-job rows
-- (user_id IS NULL) don't need this lookup path.
CREATE INDEX IF NOT EXISTS idx_llm_audit_log_user_id
  ON llm_audit_log (user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

-- "All PII incidents in window" — small partial index, only the rows that
-- tripped the prompt-injection heuristic.
CREATE INDEX IF NOT EXISTS idx_llm_audit_log_pii
  ON llm_audit_log (created_at DESC)
  WHERE prompt_injection_detected = TRUE;

-- Per-usecase breakdown for Report 5's per-action volumes.
CREATE INDEX IF NOT EXISTS idx_llm_audit_log_usecase
  ON llm_audit_log (usecase, created_at DESC);
