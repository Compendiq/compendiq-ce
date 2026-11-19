-- Canonical reserved slot for every policy, including all (SPEC-CORE-002).
-- Forward-only repair of 136. Existing rows and pending write-intent label
-- snapshots are not rewritten by schema installation. Application writers
-- must perform authorized normalization under their lifecycle fences.
CREATE OR REPLACE FUNCTION ai_policy_apply_label(labels TEXT[], policy TEXT) RETURNS TEXT[]
  LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(
    (SELECT array_agg(l ORDER BY ord)
       FROM unnest(COALESCE(labels, ARRAY[]::TEXT[])) WITH ORDINALITY AS u(l, ord)
      WHERE ai_policy_label_value(l) IS NULL),
    ARRAY[]::TEXT[])
  || CASE policy
       WHEN 'all' THEN ARRAY['all-ai']
       WHEN 'local_only' THEN ARRAY['local-ai-only']
       WHEN 'none' THEN ARRAY['no-ai']
       ELSE ARRAY[]::TEXT[]
     END
$$;
