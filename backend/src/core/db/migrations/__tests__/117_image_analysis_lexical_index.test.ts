import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { setupTestDb, teardownTestDb, isDbAvailable } from '../../../../test-db-helper.js';
import { query } from '../../postgres.js';

const dbAvailable = await isDbAvailable();

const DERIVED_TSV_IDX = 'page_embeddings_derived_chunk_tsv_idx';
const FULL_TSV_IDX = 'page_embeddings_chunk_tsv_idx';
const DERIVED_PAGE_IDX = 'page_embeddings_derived_idx';

interface IndexRow {
  indexname: string;
  indexdef: string;
  reloptions: string[] | null;
}

async function indexesOnPageEmbeddings(): Promise<Map<string, IndexRow>> {
  const res = await query<IndexRow>(
    `SELECT i.relname AS indexname,
            pg_get_indexdef(i.oid) AS indexdef,
            i.reloptions
       FROM pg_class i
       JOIN pg_index x ON x.indexrelid = i.oid
      WHERE x.indrelid = 'page_embeddings'::regclass
      ORDER BY i.relname`,
  );
  return new Map(res.rows.map((r) => [r.indexname, r]));
}

/**
 * ADR-027 migration 117 (#1617, review r1 W2): the derived lexical arm's own
 * index. This file exists because **the reloption IS the fix** (review r2
 * finding 1): a partial `gin (chunk_tsv)` alone is a large win whose cost
 * still tracks the GIN pending list, and `WITH (fastupdate = off)` is what
 * makes the arm's plan independent of a derived write burst. 116 already
 * ships a full `chunk_tsv` GIN and a `page_id` btree partial over the same
 * derived predicate, which makes this file look redundant — `IF NOT EXISTS`
 * even makes deleting it look safe. Dropping either the file or the reloption
 * restores a measured 8–9 ms steady-state cost per keyword query plus an
 * 18–74 ms tail, so both are asserted here rather than left to a plan
 * reading.
 */
describe.skipIf(!dbAvailable)('Migration 117 — derived lexical index (#1617)', () => {
  beforeAll(async () => { await setupTestDb(); }, 60_000);
  afterAll(async () => { await teardownTestDb(); });

  it('adds a PARTIAL gin(chunk_tsv) over the derived rows, distinct from both of 116\'s indexes', async () => {
    const idx = await indexesOnPageEmbeddings();

    const derived = idx.get(DERIVED_TSV_IDX);
    expect(derived, `${DERIVED_TSV_IDX} is missing — migration 117 did not apply`).toBeDefined();
    expect(derived!.indexdef).toMatch(/USING gin \(chunk_tsv\)/i);
    expect(derived!.indexdef).toMatch(
      /WHERE \(\(metadata ->> 'source'::text\) = 'image_analysis'::text\)/i,
    );

    // 116's two stay and are three distinct objects: the full GIN serves
    // `bestChunkLateralSql`'s authored chunk resolution, the btree partial the
    // `page_id`-keyed composition read. Neither is this index.
    expect(idx.has(FULL_TSV_IDX)).toBe(true);
    expect(idx.has(DERIVED_PAGE_IDX)).toBe(true);
    expect(idx.get(FULL_TSV_IDX)!.indexdef).not.toMatch(/image_analysis/);
    expect(idx.get(DERIVED_PAGE_IDX)!.indexdef).not.toMatch(/USING gin/i);
  });

  it('pins fastupdate = off on the derived index, and charges the authored path nothing', async () => {
    const idx = await indexesOnPageEmbeddings();

    // The measured decision. Without it the planner prices this index's
    // pending list into the arm and falls back to `page_embeddings_derived_idx`
    // + a `chunk_tsv` filter over every derived chunk.
    expect(
      idx.get(DERIVED_TSV_IDX)!.reloptions,
      'fastupdate = off is the fix — a plain partial GIN still pends',
    ).toEqual(['fastupdate=off']);

    // The discriminating half: turning `fastupdate` off on 116's FULL GIN
    // would fix the same plan by taxing every authored chunk of every embed.
    // It must stay on there.
    expect(idx.get(FULL_TSV_IDX)!.reloptions ?? []).not.toContain('fastupdate=off');
  });

  it('is idempotent, and a replay does not drop the reloption', async () => {
    const before = await indexesOnPageEmbeddings();

    // `CREATE INDEX IF NOT EXISTS` is a NOTICE on the second application — it
    // does not re-create, so it also cannot repair an index built without the
    // reloption. Either way the state after a replay must still carry it.
    await query(migrationSql());

    const after = await indexesOnPageEmbeddings();
    expect(after.size).toBe(before.size);
    expect(after.get(DERIVED_TSV_IDX)!.reloptions).toEqual(['fastupdate=off']);
    expect(after.get(DERIVED_TSV_IDX)!.indexdef).toBe(before.get(DERIVED_TSV_IDX)!.indexdef);
  });
});

function migrationSql(): string {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  return fs.readFileSync(path.join(dir, '117_image_analysis_lexical_index.sql'), 'utf-8');
}
