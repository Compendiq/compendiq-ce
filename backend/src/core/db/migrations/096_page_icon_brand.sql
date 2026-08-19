-- Allow Simple Icons brand slugs as a fourth page-mark kind.
ALTER TABLE pages
  DROP CONSTRAINT IF EXISTS pages_icon_pair_check;

ALTER TABLE pages
  ADD CONSTRAINT pages_icon_pair_check CHECK (
    (icon_kind IS NULL AND icon_value IS NULL)
    OR (
      icon_kind IN ('emoji', 'lucide', 'image', 'brand')
      AND icon_value IS NOT NULL
      AND length(icon_value) BETWEEN 1 AND 128
    )
  );
