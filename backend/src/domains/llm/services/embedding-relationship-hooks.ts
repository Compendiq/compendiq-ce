/**
 * Cross-domain extension point for `computePageRelationships()`.
 *
 * The `llm` domain owns the page-relationship producer transaction (so the
 * graph is never visible as half-deleted, and `processDirtyPages` runs the
 * full recompute on the post-embed incremental path). But some edge types
 * are owned by `knowledge` (`explicit_link` parses `body_html` via JSDOM,
 * which doesn't belong in the embedding service).
 *
 * ESLint boundaries forbid `llm → knowledge`. To respect that, knowledge
 * registers its producer here at startup; `computePageRelationships()`
 * iterates the registry inside its own BEGIN/COMMIT so cross-domain edges
 * are still atomic with similarity / label_overlap / parent_child.
 *
 * Producers MUST:
 *   - Use only the provided `client` (no separate pool connection — they're
 *     inside the caller's transaction).
 *   - Honour `changedPageIds` for incremental scoping when non-null.
 *   - Use `ON CONFLICT (page_id_1, page_id_2, relationship_type) DO NOTHING`
 *     and the canonical `(LEAST, GREATEST)` page-id ordering, since
 *     `computePageRelationships` already issued the DELETE for the affected
 *     rows up-front.
 *   - Return the number of edges they newly inserted.
 *
 * Producers MUST NOT throw partial state — any error propagates to
 * `computePageRelationships`, which ROLLs the whole transaction back.
 */
import type { PoolClient } from 'pg';

export type RelationshipProducer = (
  client: PoolClient,
  changedPageIds?: readonly number[] | null,
) => Promise<number>;

interface RegisteredProducer {
  /** Stable identifier used in logs ("explicit_link", etc.). */
  name: string;
  fn: RelationshipProducer;
}

const _producers: RegisteredProducer[] = [];

/**
 * Register a producer that runs inside `computePageRelationships()`'s
 * transaction. Idempotent on `name` — re-registering replaces. Knowledge
 * calls this at app bootstrap.
 */
export function registerRelationshipProducer(name: string, fn: RelationshipProducer): void {
  const existing = _producers.findIndex((p) => p.name === name);
  if (existing >= 0) {
    _producers[existing] = { name, fn };
  } else {
    _producers.push({ name, fn });
  }
}

/**
 * Read-only snapshot of registered producers — for the embedding service
 * to iterate. Returns a fresh array so callers can't mutate the registry.
 */
export function listRelationshipProducers(): readonly RegisteredProducer[] {
  return _producers.slice();
}

/**
 * Test-only: clear all registered producers. Not exported from the package
 * surface, only consumed inside the test files in this folder.
 */
export function _resetRelationshipProducersForTests(): void {
  _producers.length = 0;
}
