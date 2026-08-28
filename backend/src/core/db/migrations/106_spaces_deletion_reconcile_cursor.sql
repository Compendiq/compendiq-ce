-- #1439: preserve bounded deletion-reconciliation progress across sync cycles.
--
-- The cursor records the last pages.id whose upstream existence was attempted.
-- Advancing it for every outcome (404, trashed, current, or inconclusive) keeps
-- restricted/temporarily failing pages from permanently starving later rows.

ALTER TABLE spaces
  ADD COLUMN IF NOT EXISTS deletion_reconcile_cursor INTEGER NOT NULL DEFAULT 0;
