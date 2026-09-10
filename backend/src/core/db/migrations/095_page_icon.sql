-- Page identity mark (emoji / Lucide id / uploaded image sha).
-- Compendiq-local: sync never writes these columns. Unset is both-null.
ALTER TABLE pages
  ADD COLUMN IF NOT EXISTS icon_kind TEXT,
  ADD COLUMN IF NOT EXISTS icon_value TEXT;

ALTER TABLE pages
  DROP CONSTRAINT IF EXISTS pages_icon_pair_check;

ALTER TABLE pages
  ADD CONSTRAINT pages_icon_pair_check CHECK (
    (icon_kind IS NULL AND icon_value IS NULL)
    OR (
      icon_kind IN ('emoji', 'lucide', 'image')
      AND icon_value IS NOT NULL
      AND length(icon_value) BETWEEN 1 AND 128
    )
  );
