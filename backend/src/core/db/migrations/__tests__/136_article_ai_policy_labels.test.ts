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

  it('folds ASCII case only: a non-ASCII letter never matches a reserved label (locale-independent, twin of toLowerCase)', async () => {
    // U+0130 LATIN CAPITAL LETTER I WITH DOT ABOVE folds to `i` under some
    // locales' lower(); JavaScript folds it to `i̇` and matches nothing.
    const r = await query<{ a: string | null; b: string | null; c: string | null; d: string | null }>(
      `SELECT ai_policy_label_value(U&'NO-A\\0130') AS a,
              ai_policy_label_value(U&'A\\0130:LOCAL') AS b,
              ai_policy_label_value('NO-AI') AS c,
              ai_policy_label_value('AI:LOCAL') AS d`,
    );
    expect(r.rows[0]).toEqual({ a: null, b: null, c: 'none', d: 'local_only' });
    expect(['NO-A\u0130', 'A\u0130:LOCAL'].map((l) => l.trim().toLowerCase())).toEqual(['no-ai\u0307', 'ai\u0307:local']);
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

  it('trims exactly what JavaScript trim() trims (tab, NBSP, BOM, ideographic space) — twin of normalizeAiPolicyLabel', async () => {
    await query(sql);
    const cases: Array<[string, string | null]> = [
      ['\tno-ai\t', 'none'], ['\u00a0ai:local\u00a0', 'local_only'], ['\ufeffall-ai', 'all'],
      ['\u3000no_ai\u3000', 'none'], ['\r\nai:none\n', 'none'], ['\u2003local_only\u2003', 'local_only'],
      // Not whitespace to JS trim(): zero-width space, inner space.
      ['\u200bno-ai', null], ['no ai', null],
    ];
    for (const [label, expected] of cases) {
      const r = await query<{ v: string | null }>(`SELECT ai_policy_label_value($1) AS v`, [label]);
      expect(r.rows[0]!.v, JSON.stringify(label)).toBe(expected);
      expect(label.trim().toLowerCase() === label.toLowerCase().trim()).toBe(true);
    }
  });

  it('rewrites legacy spellings to canonical labels without moving the policy, never duplicating a label', async () => {
    const id = await insertPage('legacy', ['keep', 'ai-local-only'], 'local_only');
    await query(`UPDATE pages SET labels = ARRAY['keep','ai-local-only'] WHERE id = $1`, [id]);
    const dup = await insertPage('dup', ['x'], 'local_only');
    await query(`UPDATE pages SET labels = ARRAY['ai-local-only','x','local-ai-only',' ai_local '] WHERE id = $1`, [dup]);
    const before = await query<{ ai_policy_revision: string }>(`SELECT ai_policy_revision FROM pages WHERE id = $1`, [id]);
    await query(sql);
    const after = await query<{ labels: string[]; ai_policy: string; ai_policy_revision: string }>(
      `SELECT labels, ai_policy, ai_policy_revision FROM pages WHERE id = $1`, [id],
    );
    expect(after.rows[0]!.labels).toEqual(['keep', 'local-ai-only']);
    expect(after.rows[0]!.ai_policy).toBe('local_only');
    expect(after.rows[0]!.ai_policy_revision).toBe(before.rows[0]!.ai_policy_revision);
    const deduped = await query<{ labels: string[] }>(`SELECT labels FROM pages WHERE id = $1`, [dup]);
    expect(deduped.rows[0]!.labels).toEqual(['local-ai-only', 'x']);
  });

  it('leaves every spelling the frozen table already recognises exactly as stored (only unrecognised legacy forms are mapped)', async () => {
    const id = await insertPage('recognised', ['x'], 'none');
    await query(`UPDATE pages SET labels = ARRAY['ai:none','AI:Local','ai:all','NO_AI','ai-none','x'] WHERE id = $1`, [id]);
    await query(sql);
    const after = await query<{ labels: string[]; ai_policy: string }>(`SELECT labels, ai_policy FROM pages WHERE id = $1`, [id]);
    // `ai-none` (unrecognised) → `no-ai`; everything else untouched, order kept.
    expect(after.rows[0]!.labels).toEqual(['ai:none', 'AI:Local', 'ai:all', 'NO_AI', 'no-ai', 'x']);
    expect(after.rows[0]!.ai_policy).toBe('none');
    const untouched = await insertPage('untouched', ['x'], 'none');
    await query(`UPDATE pages SET labels = ARRAY['ai:none','AI:Local'] WHERE id = $1`, [untouched]);
    await query(sql);
    const same = await query<{ labels: string[] }>(`SELECT labels FROM pages WHERE id = $1`, [untouched]);
    expect(same.rows[0]!.labels).toEqual(['ai:none', 'AI:Local']);
  });

  it('applies on an upgrade with FROZEN pages carrying legacy spellings (labels are protected; the row is skipped, the policy stays)', async () => {
    const frozen = await insertPage('frozen', ['ai-local-only'], 'local_only');
    const live = await insertPage('live', ['ai-local-only'], 'local_only');
    await query(`UPDATE pages SET labels = ARRAY['ai-local-only'] WHERE id = ANY($1::int[])`, [[frozen, live]]);
    // A published baseline freezes the page (migration 121 shape).
    await query(
      `INSERT INTO page_writer_runtimes (runtime_id, deployment_identity, enforcement_version)
       VALUES ('rt-136', '{"test":true}'::jsonb, 1) ON CONFLICT (runtime_id) DO NOTHING`,
    );
    const intent = await query<{ id: string }>(
      `INSERT INTO page_write_intents (runtime_id, kind, actor_id, page_ids, revisions, recovery_mode, effect)
       VALUES ('rt-136', 'baseline.prepare', NULL, ARRAY[$1]::integer[], '{}'::jsonb, 'local_verified',
               '{"effectClass":"local"}'::jsonb)
       RETURNING id`,
      [frozen],
    );
    const baseline = await query<{ id: string }>(
      `INSERT INTO page_baselines
         (id, page_id, original_page_id, page_identity, version, content_revision, lifecycle_revision,
          manifest_digest, manifest, manifest_bytes, title, labels, total_bytes, reserved_bytes, status,
          prepared_by_name, preparation_intent_id, published_by_name, published_at, provenance, freeze_reason)
       VALUES (gen_random_uuid(), $1, $1, '[]'::jsonb, 1, 0, 0, repeat('a', 64), '[]'::jsonb, '\\x00'::bytea,
               'frozen', ARRAY['ai-local-only'], 0, 0, 'published', 'tester', $2, 'tester', NOW(),
               'manual_assertion', 'audit')
       RETURNING id`,
      [frozen, intent.rows[0]!.id],
    );
    await query(
      `UPDATE pages SET baseline_id = $2, frozen_version = 1, frozen_at = NOW(), frozen_by_name = 'tester',
              freeze_reason = 'audit', freeze_provenance = 'manual_assertion', freeze_reported_signatories = '[]'::jsonb
        WHERE id = $1`,
      [frozen, baseline.rows[0]!.id],
    );

    await expect(query(sql)).resolves.toBeDefined();
    const rows = await query<{ id: number; labels: string[]; ai_policy: string }>(
      `SELECT id, labels, ai_policy FROM pages WHERE id = ANY($1::int[]) ORDER BY id`, [[frozen, live]],
    );
    expect(rows.rows).toEqual([
      { id: frozen, labels: ['ai-local-only'], ai_policy: 'local_only' },
      { id: live, labels: ['local-ai-only'], ai_policy: 'local_only' },
    ]);
  });
});
