-- Migration 028: Rename cached_pages → pages
-- Part of #353: Standalone KB Articles
-- This table is no longer just a cache — standalone articles are the source of truth.

-- Rename the core table
ALTER TABLE cached_pages RENAME TO pages;

-- Rename sequences
ALTER SEQUENCE IF EXISTS cached_pages_id_seq RENAME TO pages_id_seq;

-- Rename indexes (PostgreSQL auto-renames some with table, but be explicit)
ALTER INDEX IF EXISTS cached_pages_pkey RENAME TO pages_pkey;

-- Rename the unique constraint on confluence_id (will be modified in 029)
ALTER INDEX IF EXISTS cached_pages_confluence_id_key RENAME TO pages_confluence_id_key;
