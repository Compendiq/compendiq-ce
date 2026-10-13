-- Article AI policy: frozen label table (SPEC-CORE-002, #280 review).
-- Forward migration on top of 135 (published; not rewritten). Replaces the
-- regex-based `ai_policy_from_labels` with the exact synonym table and adds
-- the canonical-label writer twin. Idempotent.
--
-- Table (lowercase + trim only — no regex, no fuzzy forms):
--   all-ai | ai:all                       → all
--   local-ai-only | local_only | ai:local → local_only
--   no-ai | no_ai | ai:none               → none
-- Canonical mirrored labels: all-ai, local-ai-only, no-ai.
-- The TypeScript twin is `AI_POLICY_LABEL_SYNONYMS` in
-- packages/contracts/src/schemas/ai-policy.ts; keep both in step.

CREATE OR REPLACE FUNCTION ai_policy_label_value(l TEXT) RETURNS TEXT
  LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE lower(btrim(l))
           WHEN 'all-ai' THEN 'all'
           WHEN 'ai:all' THEN 'all'
           WHEN 'local-ai-only' THEN 'local_only'
           WHEN 'local_only' THEN 'local_only'
           WHEN 'ai:local' THEN 'local_only'
           WHEN 'no-ai' THEN 'none'
           WHEN 'no_ai' THEN 'none'
           WHEN 'ai:none' THEN 'none'
         END
$$;

-- Strictest RESTRICTIVE policy any reserved label spells out; 'all' when
-- none does. `all-ai` is never a tighten, so it contributes nothing here
-- (the creation trigger only ever tightens — SPEC-CORE-002).
CREATE OR REPLACE FUNCTION ai_policy_from_labels(labels TEXT[]) RETURNS TEXT
  LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(
    (SELECT p FROM (
       SELECT ai_policy_label_value(l) AS p
         FROM unnest(COALESCE(labels, ARRAY[]::TEXT[])) AS l
     ) s WHERE p IS NOT NULL AND p <> 'all' ORDER BY ai_policy_rank(p) DESC LIMIT 1),
    'all')
$$;

-- Rewrites the reserved labels so exactly one canonical label spells the
-- policy ('all' carries no label). Twin of `applyCanonicalAiPolicyLabel`.
CREATE OR REPLACE FUNCTION ai_policy_apply_label(labels TEXT[], policy TEXT) RETURNS TEXT[]
  LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(
    (SELECT array_agg(l ORDER BY ord)
       FROM unnest(COALESCE(labels, ARRAY[]::TEXT[])) WITH ORDINALITY AS u(l, ord)
      WHERE ai_policy_label_value(l) IS NULL),
    ARRAY[]::TEXT[])
  || CASE policy
       WHEN 'local_only' THEN ARRAY['local-ai-only']
       WHEN 'none' THEN ARRAY['no-ai']
       ELSE ARRAY[]::TEXT[]
     END
$$;

-- Repair: the pre-freeze CE code mirrored `ai-local-only` as the canonical
-- local_only label (and accepted fuzzy spellings such as `ai-none`,
-- `ai_local`). Rows carrying ONLY those spellings would read as unlabelled
-- under the frozen table while `pages.ai_policy` (the single authority)
-- still says otherwise. Rewrite those spellings onto the canonical label of
-- the policy they named, WITHOUT touching `ai_policy` or its revision: the
-- policy is never relaxed and never tightened by this migration. Labels that
-- the frozen table already recognises are left as they are.
UPDATE pages
   SET labels = (
     SELECT COALESCE(array_agg(
       CASE regexp_replace(lower(btrim(l)), '[\s_:]+', '-', 'g')
         WHEN 'ai-none' THEN 'no-ai'
         WHEN 'ai-local-only' THEN 'local-ai-only'
         WHEN 'ai-local' THEN 'local-ai-only'
         WHEN 'ai-all' THEN 'all-ai'
         ELSE l
       END ORDER BY ord), ARRAY[]::TEXT[])
       FROM unnest(pages.labels) WITH ORDINALITY AS u(l, ord)
   )
 WHERE labels IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM unnest(pages.labels) AS l
      WHERE ai_policy_label_value(l) IS NULL
        AND regexp_replace(lower(btrim(l)), '[\s_:]+', '-', 'g')
            IN ('ai-none', 'ai-local-only', 'ai-local', 'ai-all')
   );
