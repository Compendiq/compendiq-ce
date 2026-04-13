-- Bridge migration: map old migration filenames to new ones after
-- the deduplication renumbering in PR #334.
--
-- Before PR #334, there were duplicate migration numbers (two 015s, two 017s,
-- two 018s). The fix renumbered 017-024 → 018-026 and deleted the duplicate
-- 015_llm_provider_settings.sql. Existing databases have the OLD filenames
-- in _migrations; this bridge inserts the NEW filenames so the runner skips
-- migrations that were already applied under their old names.
--
-- For fresh installations: no old names exist → nothing inserted → no-op.

INSERT INTO _migrations (name)
SELECT new_name
FROM (VALUES
  ('017_pinned_pages.sql',             '018_pinned_pages.sql'),
  ('018_embedding_error.sql',          '019_embedding_error.sql'),
  ('018_page_relationships.sql',       '020_page_relationships.sql'),
  ('019_add_performance_indexes.sql',  '021_add_performance_indexes.sql'),
  ('020_embedding_chunk_settings.sql', '022_embedding_chunk_settings.sql'),
  ('021_shared_tables.sql',            '023_shared_tables.sql'),
  ('022_custom_prompts.sql',           '024_custom_prompts.sql'),
  ('023_quality_scores.sql',           '025_quality_scores.sql'),
  ('024_article_summaries.sql',        '026_article_summaries.sql')
) AS mapping(old_name, new_name)
WHERE EXISTS (SELECT 1 FROM _migrations WHERE name = mapping.old_name)
  AND NOT EXISTS (SELECT 1 FROM _migrations WHERE name = mapping.new_name);
