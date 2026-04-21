-- Migration 056: per-user concurrent SSE-stream cap (#268)
--
-- Seeds the admin-configurable cap for the per-user SSE-stream limiter
-- (backend/src/core/services/sse-stream-limiter.ts). Without this bound, a
-- single user opening many simultaneous streams can saturate the upstream
-- LLM.
--
-- Range (enforced by Zod at the API boundary): [1, 20]. Default: 3.
--
-- Read cascade:
--   admin_settings.llm_max_concurrent_streams_per_user   (authoritative)
--     -> env LLM_MAX_CONCURRENT_STREAMS_PER_USER         (deprecated fallback)
--     -> 3                                               (hard default)
--
-- Additive and idempotent — existing installations that already have the
-- row from a prior rollout or manual INSERT keep their chosen value.

INSERT INTO admin_settings (setting_key, setting_value, updated_at)
VALUES ('llm_max_concurrent_streams_per_user', '3', NOW())
ON CONFLICT (setting_key) DO NOTHING;
