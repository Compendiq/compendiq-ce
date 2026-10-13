import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../../test-db-helper.js';
import { query } from '../../postgres.js';

const dbAvailable = await isDbAvailable();
const sql = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '136_article_ai_policy_labels.sql'),
  'utf8',
);

async function insertPage(title: string, labels: string[], aiPolicy = 'all'): Promise<number> {
  const r = await query<{ id: number }>(
    `INSERT INTO pages (title, body_html, body_storage, body_text, version, labels, source, visibility,
                        embedding_dirty, embedding_status, ai_policy)
     VALUES ($1, '<p>x</p>', '<p>x</p>', 'x', 1, $2, 'standalone', 'private', TRUE, 'not_embedded', $3)
     RETURNING id`,
    [title, labels, aiPolicy],
  );
  return r.rows[0]!.id;
}

describe.skipIf(!dbAvailable)('Migration 136 — frozen AI policy label table (#280)', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => { await truncateAllTables(); });

  it('is idempotent', async () => {
    await query(sql);
    await query(sql);
    const r = await query<{ v: string | null }>(`SELECT ai_policy_label_value('No-AI') AS v`);
    expect(r.rows[0]!.v).toBe('none');
  });

  it('matches exactly the frozen synonyms (lowercase + trim), nothing fuzzy', async () => {
    const cases: Array<[string, string | null]> = [
      ['all-ai', 'all'], ['AI:ALL', 'all'],
      ['local-ai-only', 'local_only'], ['local_only', 'local_only'], [' ai:local ', 'local_only'],
      ['no-ai', 'none'], ['NO_AI', 'none'], ['ai:none', 'none'],
      ['ai-none', null], ['ai-local-only', null], ['ai local', null], ['runbook', null],
    ];
    for (const [label, expected] of cases) {
      const r = await query<{ v: string | null }>(`SELECT ai_policy_label_value($1) AS v`, [label]);
      expect(r.rows[0]!.v, label).toBe(expected);
    }
  });

  it('ai_policy_from_labels takes the strictest restrictive label and ignores all-ai', async () => {
    const r = await query<{ a: string; b: string; c: string; d: string }>(
      `SELECT ai_policy_from_labels(ARRAY['x','ai:local','no_ai']) AS a,
              ai_policy_from_labels(ARRAY['all-ai']) AS b,
              ai_policy_from_labels(ARRAY['ai-none']) AS c,
              ai_policy_from_labels(NULL) AS d`,
    );
    expect(r.rows[0]).toEqual({ a: 'none', b: 'all', c: 'all', d: 'all' });
  });

  it('ai_policy_apply_label writes exactly one canonical label', async () => {
    const r = await query<{ a: string[]; b: string[] }>(
      `SELECT ai_policy_apply_label(ARRAY['x','no_ai','ai:none'], 'none') AS a,
              ai_policy_apply_label(ARRAY['x','no-ai'], 'all') AS b`,
    );
    expect(r.rows[0]!.a).toEqual(['x', 'no-ai']);
    expect(r.rows[0]!.b).toEqual(['x']);
  });

  it('creation trigger uses the frozen table', async () => {
    const strict = await insertPage('a', ['local-ai-only']);
    const fuzzy = await insertPage('b', ['ai-local-only']);
    const r = await query<{ id: number; ai_policy: string }>(
      `SELECT id, ai_policy FROM pages WHERE id = ANY($1::int[]) ORDER BY id`, [[strict, fuzzy]],
    );
    expect(r.rows.map((x) => x.ai_policy)).toEqual(['local_only', 'all']);
  });

  it('rewrites legacy spellings to canonical labels without moving the policy', async () => {
    const id = await insertPage('legacy', ['keep', 'ai-local-only'], 'local_only');
    await query(`UPDATE pages SET labels = ARRAY['keep','ai-local-only'] WHERE id = $1`, [id]);
    const before = await query<{ ai_policy_revision: string }>(`SELECT ai_policy_revision FROM pages WHERE id = $1`, [id]);
    await query(sql);
    const after = await query<{ labels: string[]; ai_policy: string; ai_policy_revision: string }>(
      `SELECT labels, ai_policy, ai_policy_revision FROM pages WHERE id = $1`, [id],
    );
    expect(after.rows[0]!.labels).toEqual(['keep', 'local-ai-only']);
    expect(after.rows[0]!.ai_policy).toBe('local_only');
    expect(after.rows[0]!.ai_policy_revision).toBe(before.rows[0]!.ai_policy_revision);
  });
});
