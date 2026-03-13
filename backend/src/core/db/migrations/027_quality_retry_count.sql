ALTER TABLE cached_pages ADD COLUMN IF NOT EXISTS quality_retry_count integer NOT NULL DEFAULT 0;
