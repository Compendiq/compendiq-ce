/**
 * Cross-domain extension point for deterministic relationship materialization.
 *
 * The `llm` domain owns the shared deterministic engine; Connections/focused
 * graph reads and embedding recomputation both call it inside a transaction.
 * Some edge types are owned by `knowledge` (`explicit_link` parses body_html),
 * and ESLint boundaries forbid `llm → knowledge`, so knowledge registers its
 * producer here at startup.
 *
 * Producers MUST:
 *   - Use only the provided `client` (no separate pool connection — they're
 *     inside the caller's transaction).
 *   - Honour `changedPageIds` for incremental scoping when non-null.
 *   - Use `ON CONFLICT (page_id_1, page_id_2, relationship_type) DO NOTHING`
 *     and the canonical `(LEAST, GREATEST)` page-id ordering, since the shared
 *     engine already issued the DELETE for affected deterministic rows.
 *   - Return the number of edges they newly inserted.
 *
 * Producers MUST NOT swallow failures: errors roll back relationships and dirty
 * consumption together in the caller's transaction.
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
 * Register a producer that runs inside the deterministic engine's transaction.
 * Idempotent on `name` — re-registering replaces. Knowledge calls this at bootstrap.
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
