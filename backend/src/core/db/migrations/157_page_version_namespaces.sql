-- #1918 slice 1. The next slice starts maintaining remote_version.
ALTER TABLE pages ADD COLUMN remote_version INTEGER;
UPDATE pages SET remote_version = version WHERE source = 'confluence';

ALTER TABLE page_versions ADD COLUMN source TEXT;
UPDATE page_versions AS history
   SET source = CASE WHEN page.source = 'confluence' THEN 'confluence' ELSE 'local' END
  FROM pages AS page
 WHERE page.id = history.page_id;

ALTER TABLE page_versions
  ALTER COLUMN source SET NOT NULL,
  ADD CONSTRAINT page_versions_source_check CHECK (source IN ('local', 'confluence'));

CREATE UNIQUE INDEX page_versions_page_id_source_version_unique
  ON page_versions (page_id, source, version_number);
DROP INDEX page_versions_page_id_version_unique;
