-- #276: unknown historical runtimes are not silently certified as enforcing.
ALTER TABLE page_writer_runtimes
  ADD COLUMN IF NOT EXISTS enforcement_version INTEGER NOT NULL DEFAULT 0
    CHECK (enforcement_version >= 0);

-- Older #275 binaries omit the column and therefore register as version 0.
-- Activation takes this feature row FOR UPDATE before checking runtimes. An
-- incompatible registration holds SHARE through its INSERT, closing the
-- check-then-activate race. Once evidence exists, disabling new creation does
-- not make rollback to an unenforcing binary safe.
CREATE OR REPLACE FUNCTION guard_page_writer_enforcement_registration()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  creation_enabled_now BOOLEAN;
BEGIN
  IF NEW.enforcement_version = 1 THEN
    RETURN NEW;
  END IF;

  SELECT creation_enabled INTO creation_enabled_now
    FROM page_baseline_feature_state
   WHERE singleton = TRUE
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Page baseline activation state is unavailable';
  END IF;

  IF creation_enabled_now OR EXISTS (
    SELECT 1 FROM page_baselines WHERE status = 'published'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'This writer does not support the installed page baseline enforcement protocol';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS page_writer_enforcement_registration ON page_writer_runtimes;
CREATE TRIGGER page_writer_enforcement_registration
  BEFORE INSERT OR UPDATE OF enforcement_version ON page_writer_runtimes
  FOR EACH ROW EXECUTE FUNCTION guard_page_writer_enforcement_registration();
