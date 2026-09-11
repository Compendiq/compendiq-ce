-- Optional tint for lucide/brand page marks. Emoji and image marks stay uncolored.
ALTER TABLE pages
  ADD COLUMN IF NOT EXISTS icon_color TEXT;

ALTER TABLE pages
  DROP CONSTRAINT IF EXISTS pages_icon_pair_check;

ALTER TABLE pages
  ADD CONSTRAINT pages_icon_pair_check CHECK (
    (icon_kind IS NULL AND icon_value IS NULL AND icon_color IS NULL)
    OR (
      icon_kind IN ('emoji', 'lucide', 'image', 'brand')
      AND icon_value IS NOT NULL
      AND length(icon_value) BETWEEN 1 AND 128
      AND (
        icon_color IS NULL
        OR (
          icon_kind IN ('lucide', 'brand')
          AND icon_color IN (
            '#6b7280', '#b45309', '#f97316', '#eab308', '#22c55e',
            '#0d9488', '#3b82f6', '#a855f7', '#ec4899', '#ef4444'
          )
        )
      )
    )
  );
