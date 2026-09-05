import type { PoolClient } from 'pg';
import { getPool, query } from '../../../core/db/postgres.js';
import { RELATIONSHIP_ADVISORY_LOCK_ID } from '../../../core/db/advisory-locks.js';
import { listRelationshipProducers } from './embedding-relationship-hooks.js';


interface DirtyRelationship {
  page_id: number;
  revision: string;
  full_rebuild: boolean;
}

/**
 * Caller owns BEGIN/COMMIT/ROLLBACK. The lock serializes all relationship
 * materializers, not page writes. Revision compare-and-delete keeps mutations
 * committed during production pending, even when they touch an already dirty row.
 * undefined = pending work only; null = explicit full rebuild.
 */
export async function materializeDeterministicRelationships(
  client: PoolClient,
  requestedPageIds?: readonly number[] | null,
): Promise<number> {
  await client.query('SELECT pg_advisory_xact_lock($1)', [RELATIONSHIP_ADVISORY_LOCK_ID]);
  const pending = await client.query<DirtyRelationship>(
    'SELECT page_id, revision, full_rebuild FROM deterministic_relationship_dirty',
  );
  const full = requestedPageIds === null || pending.rows.some((row) => row.full_rebuild);
  const changedPageIds = full ? null : [...new Set([
    ...(requestedPageIds ?? []), ...pending.rows.map((row) => row.page_id),
  ])];
  if (!full && changedPageIds!.length === 0) return 0;

  await client.query(
    `DELETE FROM page_relationships
     WHERE relationship_type <> 'embedding_similarity'
       AND ($1::int[] IS NULL OR page_id_1 = ANY($1) OR page_id_2 = ANY($1))`,
    [changedPageIds],
  );
  // Compute label-overlap edges: pages sharing at least one label.
  // When changedPageIds is provided, only compute for pairs involving at least one changed page.
  const labelResult = await client.query<{ page_id_1: number; page_id_2: number; score: number }>(
    `WITH label_overlaps AS (
       SELECT
         a.id AS page_id_1,
         b.id AS page_id_2,
         CASE
           WHEN array_length(a.labels, 1) IS NULL OR array_length(b.labels, 1) IS NULL THEN 0
           ELSE (
             SELECT COUNT(*)::real FROM (
               SELECT unnest(a.labels) INTERSECT SELECT unnest(b.labels)
             ) x
           ) / GREATEST(
             array_length(a.labels, 1)::real,
             array_length(b.labels, 1)::real
           )
         END AS score
       FROM pages a
       JOIN pages b ON a.id < b.id
       WHERE a.deleted_at IS NULL AND b.deleted_at IS NULL
         AND a.labels IS NOT NULL AND array_length(a.labels, 1) > 0
         AND b.labels IS NOT NULL AND array_length(b.labels, 1) > 0
         AND a.labels && b.labels
         AND ($1::int[] IS NULL OR a.id = ANY($1) OR b.id = ANY($1))
     )
     INSERT INTO page_relationships (page_id_1, page_id_2, relationship_type, score)
     SELECT page_id_1, page_id_2, 'label_overlap', score
     FROM label_overlaps
     WHERE score > 0
     ON CONFLICT (page_id_1, page_id_2, relationship_type) DO UPDATE
       SET score = EXCLUDED.score, created_at = NOW()
     RETURNING page_id_1, page_id_2, score`,
    [changedPageIds],
  );

  const parentChildResult = await client.query(
    `WITH parent_links AS (
       SELECT child.id AS child_id, relationship_parent_id(child.parent_id) AS parent_id
       FROM pages child
       WHERE child.deleted_at IS NULL AND child.parent_id IS NOT NULL
         AND ($1::int[] IS NULL OR child.id = ANY($1) OR child.parent_id IN (
           SELECT relationship_parent_key(source, id, confluence_id)
           FROM pages WHERE id = ANY($1) AND deleted_at IS NULL
         ))
     )
     INSERT INTO page_relationships (page_id_1, page_id_2, relationship_type, score)
     SELECT LEAST(child_id, parent_id), GREATEST(child_id, parent_id), 'parent_child', 1.0
     FROM parent_links
     WHERE parent_id IS NOT NULL AND child_id <> parent_id
       AND ($1::int[] IS NULL OR child_id = ANY($1) OR parent_id = ANY($1))
     ON CONFLICT (page_id_1, page_id_2, relationship_type) DO NOTHING`,
    [changedPageIds],
  );

  let edges = labelResult.rows.length + (parentChildResult.rowCount ?? 0);
  for (const producer of listRelationshipProducers()) {
    edges += await producer.fn(client, changedPageIds);
  }

  if (pending.rows.length > 0) {
    await client.query(
      `DELETE FROM deterministic_relationship_dirty dirty
       USING unnest($1::int[], $2::bigint[]) AS consumed(page_id, revision)
       WHERE dirty.page_id = consumed.page_id AND dirty.revision = consumed.revision`,
      [pending.rows.map((row) => row.page_id), pending.rows.map((row) => row.revision)],
    );
  }
  return edges;
}

/** Authorized Connections/focused graph reads settle durable evidence, no provider. */
export async function ensureDeterministicRelationships(): Promise<void> {
  // Clean reads do not check out a transaction or invoke any producer.
  const pending = await query<{ pending: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM deterministic_relationship_dirty) AS pending',
  );
  if (!pending.rows[0]!.pending) return;

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL statement_timeout = 120000');
    await materializeDeterministicRelationships(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
