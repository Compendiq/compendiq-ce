-- #2034: server-owned identity of a collaborative document lineage.
--
-- A lineage starts when a row is inserted (the HTML seed of the first writable
-- join) and ends when that row is deleted; nothing rewrites a row into another
-- lineage. The database generates the value, so a row inserted by a process
-- that predates this column still gets its own epoch.
--
-- gen_random_uuid() is volatile: PostgreSQL cannot add this default as
-- metadata only. The statement rewrites the table once under an ACCESS
-- EXCLUSIVE lock and evaluates the default per row, which is what gives every
-- existing row its own epoch.
ALTER TABLE page_collaborative_docs
  ADD COLUMN doc_epoch UUID NOT NULL DEFAULT gen_random_uuid();
