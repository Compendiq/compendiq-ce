-- #1402 (phase 1/3): per-user onboarding checklist state.
--
-- Deliberately narrow: only what can't be safely derived from existing live
-- state is persisted here. `patConfigured` and `spacesSelected` are computed
-- client-side from `hasConfluencePat` / `selectedSpaces.length > 0` (both
-- already returned by GET /settings) rather than stored — a redundant stored
-- boolean would drift from the truth the moment a user disconnects their PAT
-- (see merged PR #1142, "remove derived, fabricated and unreadable UI from
-- the app surfaces").
--
-- An empty object, not the full Zod-defaulted shape: the API layer fills
-- defaults on read via OnboardingStateSchema.parse(row.onboarding_state ?? {}),
-- the same pattern already used for custom_prompts.
ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS onboarding_state JSONB NOT NULL DEFAULT '{}'::jsonb;
