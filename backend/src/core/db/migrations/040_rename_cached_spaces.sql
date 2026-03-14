-- Migration 040: Rename cached_spaces -> spaces (#354)
-- Mirrors migration 028 that renamed cached_pages -> pages.
-- The table is no longer just a cache: local spaces are the source of truth.

-- Rename the core table
ALTER TABLE cached_spaces RENAME TO spaces;

-- Rename sequence
ALTER SEQUENCE IF EXISTS cached_spaces_id_seq RENAME TO spaces_id_seq;

-- Rename primary key index
ALTER INDEX IF EXISTS cached_spaces_pkey RENAME TO spaces_pkey;

-- Rename unique constraint on space_key
ALTER INDEX IF EXISTS cached_spaces_space_key_key RENAME TO spaces_space_key_key;

-- Rename the source check constraint
ALTER TABLE spaces RENAME CONSTRAINT cached_spaces_source_check TO spaces_source_check;
