ALTER TABLE pending_sync_versions
  ADD COLUMN IF NOT EXISTS title TEXT NULL;
