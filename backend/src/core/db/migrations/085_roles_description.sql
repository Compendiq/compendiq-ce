-- Migration 085: add description column to roles (#935)
--
-- Custom roles carry a human-readable description entered in the role editor.
-- Without a persisted column the editor could not round-trip the value: it
-- showed an empty Description on edit and saving overwrote the stored text
-- with ''. The column is nullable and harmless in CE (system roles leave it
-- NULL); the enterprise advanced-RBAC create/update routes write it.
--
-- IF NOT EXISTS is required, not defensive style: the EE overlay merges its
-- own migrations into this sequence, and EE 063_named_permissions.sql already
-- does `ALTER TABLE roles ADD COLUMN IF NOT EXISTS description TEXT`. 063
-- sorts before 085, so in an EE build the column exists by the time this runs
-- and a bare ADD COLUMN aborts startup with 42701.

ALTER TABLE roles ADD COLUMN IF NOT EXISTS description TEXT;
