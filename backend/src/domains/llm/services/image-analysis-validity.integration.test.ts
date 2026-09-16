import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isDbAvailable, setupTestDb, teardownTestDb } from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import { IMAGE_ANALYSIS_PROMPT_VERSION, IMAGE_ANALYSIS_SCHEMA_VERSION } from './image-analysis-provider.js';
import { isValidAnalysisRow, validityParamValues, validitySql, type ValidityRow } from './image-analysis-validity.js';

/**
 * ADR-027 D5 — the SQL predicate and its in-memory twin must agree on every
 * row on their own, including rows migration 115's CHECKs would refuse (an
 * `analyzed` row with a NULL hash or version): neither form may lean on the
 * constraint, and the sweep's `NOT (…)` must be the exact complement, so no
 * term may evaluate to SQL NULL. The rows are a VALUES list, not the table,
 * precisely so the CHECK cannot pre-filter the matrix.
 */
const dbAvailable = await isDbAvailable();

const HASH = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

const rows: ValidityRow[] = [];
for (const status of ['analyzed', 'pending', 'failed', 'failed_terminal', 'skipped']) {
  for (const identity_hash of [HASH, OTHER, null]) {
    for (const prompt_version of [IMAGE_ANALYSIS_PROMPT_VERSION, IMAGE_ANALYSIS_PROMPT_VERSION + 1, null]) {
      for (const schema_version of [IMAGE_ANALYSIS_SCHEMA_VERSION, IMAGE_ANALYSIS_SCHEMA_VERSION + 1, null]) {
        rows.push({ status, identity_hash, prompt_version, schema_version });
      }
    }
  }
}

describe.skipIf(!dbAvailable)('validitySql vs isValidAnalysisRow (ADR-027 D5, #1616)', () => {
  beforeAll(async () => setupTestDb());
  afterAll(async () => teardownTestDb());

  it.each([
    ['a retained identity', HASH],
    ['nothing retained', null],
  ])('agree on every row, and NOT (…) is the exact complement — %s', async (_label, identityHash) => {
    const params = validityParamValues({ identityHash });
    const r = await query<{ i: number; valid: boolean | null; invalid: boolean | null }>(
      `SELECT a.i, (${validitySql('a', 1, 2, 3)}) AS valid, (NOT (${validitySql('a', 1, 2, 3)})) AS invalid
         FROM jsonb_to_recordset($4::jsonb)
              AS a(i int, status text, identity_hash text, prompt_version int, schema_version int)
        ORDER BY a.i`,
      [...params, JSON.stringify(rows.map((row, i) => ({ i, ...row })))],
    );
    expect(r.rows).toHaveLength(rows.length);
    const valid = rows.filter((row) => isValidAnalysisRow(row, { identityHash })).length;
    expect(valid).toBe(identityHash === null ? 0 : 1);
    for (const { i, valid: sqlValid, invalid } of r.rows) {
      const expected = isValidAnalysisRow(rows[i]!, { identityHash });
      // Never NULL on either side: `NOT (…)` selects exactly the rejected rows.
      expect(sqlValid, JSON.stringify(rows[i])).toBe(expected);
      expect(invalid, JSON.stringify(rows[i])).toBe(!expected);
    }
  });
});
