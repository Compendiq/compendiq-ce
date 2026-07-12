-- Migration 082: add description column to roles (#935)
--
-- Custom roles carry a human-readable description entered in the role editor.
-- Without a persisted column the editor could not round-trip the value: it
-- showed an empty Description on edit and saving overwrote the stored text
-- with ''. The column is nullable and harmless in CE (system roles leave it
-- NULL); the enterprise advanced-RBAC create/update routes write it.

ALTER TABLE roles ADD COLUMN description TEXT;
