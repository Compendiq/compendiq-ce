-- #362: extend page_relationships.relationship_type to allow 'parent_child'.
--
-- Migration 020 declared the original CHECK constraint with three values
-- (embedding_similarity, label_overlap, explicit_link). #362 adds parent_child
-- as a new edge type so the page hierarchy is visible in the knowledge graph.
--
-- We drop and re-add the constraint rather than ALTER it because Postgres
-- doesn't support ALTER CONSTRAINT ... CHECK; the drop+add cycle is cheap on
-- a table this size and atomic inside this single migration transaction.
--
-- Note: 'cluster_relationship' is computed in code at request time
-- (pages-embeddings.ts:409 buildClusteredGraph) and never stored, so it is
-- intentionally NOT in the CHECK list.

ALTER TABLE page_relationships
  DROP CONSTRAINT IF EXISTS page_relationships_relationship_type_check;

ALTER TABLE page_relationships
  ADD CONSTRAINT page_relationships_relationship_type_check
  CHECK (relationship_type IN (
    'embedding_similarity',
    'label_overlap',
    'explicit_link',
    'parent_child'
  ));
