-- Migration 053: Per-use-case LLM provider/model assignments.
-- Seeds summary/quality use-case model rows from deprecated env vars on upgrade
-- so existing deployments don't regress. Provider defaults to inheriting the
-- shared default (row absent), which matches pre-migration behavior.
--
-- Idempotent via ON CONFLICT DO NOTHING — reruns are safe.

-- SUMMARY_MODEL -> llm_usecase_summary_model (env only, checked via current_setting
-- pattern is not available in migrations; seeded by app on first boot instead).
-- This migration intentionally does NOT read env vars — seeding from env is the
-- responsibility of the bootstrap path in admin-settings-service.ts (§2), which
-- runs every startup and is safe to rerun. Keeping env-to-DB seeding in TS means
-- we can log it, audit it, and test it.

-- No-op migration: documents the four new use-case key pairs but creates no rows.
-- The resolver (§2) treats missing rows as "inherit shared default".
SELECT 1; -- placeholder; the migration file exists to reserve slot 053 and
          -- document the new key namespace for schema reviewers.
