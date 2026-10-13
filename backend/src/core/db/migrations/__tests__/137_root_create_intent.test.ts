import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../../test-db-helper.js';
import { query } from '../../postgres.js';

const dbAvailable = await isDbAvailable();
const sql = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '137_root_create_intent.sql'),
  'utf8',
);

const SHA = 'a'.repeat(64);
const RUNTIME = 'test-runtime-137';

async function ensureRuntime(): Promise<void> {
  await query(
    `INSERT INTO page_writer_runtimes (runtime_id, deployment_identity, enforcement_version)
     VALUES ($1, '{"test": true}'::jsonb, 1)
     ON CONFLICT (runtime_id) DO NOTHING`,
    [RUNTIME],
  );
}

async function insertPage(): Promise<number> {
  const r = await query<{ id: number }>(
    `INSERT INTO pages (title, body_html, body_storage, body_text, version, labels, source, visibility,
                        embedding_dirty, embedding_status)
     VALUES ('parent', '<p>x</p>', '<p>x</p>', 'x', 1, '{}', 'confluence', 'shared', TRUE, 'not_embedded')
     RETURNING id`,
  );
  return r.rows[0]!.id;
}

function rootEffect(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    effectClass: 'remote',
    parentPageId: null,
    parentConfluenceId: null,
    spaceKey: 'DOCS',
    titleSha256: SHA,
    storageSha256: SHA,
    initialPolicy: 'local_only',
    initialLabels: ['local-ai-only'],
    ...overrides,
  };
}

async function tryInsert(input: {
  kind: string; pageIds: number[]; revisions?: unknown; recoveryMode?: string; effect: unknown;
}): Promise<{ ok: true } | { ok: false; code: string; constraint: string | null }> {
  try {
    await query(
      `INSERT INTO page_write_intents (runtime_id, kind, actor_id, page_ids, revisions, recovery_mode, effect)
       VALUES ($1, $2, NULL, $3::integer[], $4::jsonb, $5, $6::jsonb)`,
      [RUNTIME, input.kind, input.pageIds, JSON.stringify(input.revisions ?? {}),
        input.recoveryMode ?? 'remote_terminal_only', JSON.stringify(input.effect)],
    );
    return { ok: true };
  } catch (err) {
    const e = err as { code?: string; constraint?: string };
    return { ok: false, code: e.code ?? '', constraint: e.constraint ?? null };
  }
}

describe.skipIf(!dbAvailable)('Migration 137 — root pages.create.confluence intent (#280)', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => {
    await truncateAllTables();
    await ensureRuntime();
  });

  it('is idempotent and keeps the constraint names', async () => {
    await query(sql);
    await query(sql);
    const r = await query<{ conname: string; condef: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS condef FROM pg_constraint
        WHERE conrelid = 'page_write_intents'::regclass
          AND conname IN ('page_write_intents_effect_policy_check', 'page_write_intents_page_ids_check')
        ORDER BY conname`,
    );
    expect(r.rows.map((x) => x.conname)).toEqual([
      'page_write_intents_effect_policy_check', 'page_write_intents_page_ids_check',
    ]);
    // Root branch present exactly once (no duplication on re-run).
    const policy = r.rows[0]!.condef;
    expect(policy.split(`'{}'::integer[]`).length - 1).toBe(1);
    expect(policy.startsWith('CHECK (COALESCE(')).toBe(true);
  });

  it('accepts the root create shape', async () => {
    const r = await tryInsert({ kind: 'pages.create.confluence', pageIds: [], effect: rootEffect() });
    expect(r).toEqual({ ok: true });
  });

  it('still accepts the parented create shape', async () => {
    const parent = await insertPage();
    const r = await tryInsert({
      kind: 'pages.create.confluence',
      pageIds: [parent],
      revisions: { [parent]: { contentRevision: '1', lifecycleRevision: '1' } },
      effect: rootEffect({ parentPageId: parent, parentConfluenceId: '123' }),
    });
    expect(r).toEqual({ ok: true });
  });

  it('refuses empty targets for every other kind', async () => {
    for (const kind of ['pages.update.confluence', 'page.labels', 'pages.delete.standalone', 'pages.create.labels']) {
      const r = await tryInsert({
        kind,
        pageIds: [],
        recoveryMode: kind === 'pages.delete.standalone' ? 'local_verified' : 'remote_terminal_only',
        effect: rootEffect({ effectClass: kind === 'pages.delete.standalone' ? 'local' : 'remote' }),
      });
      expect(r.ok, kind).toBe(false);
      expect((r as { code: string }).code).toBe('23514');
    }
  });

  it('refuses malformed root rows', async () => {
    const bad: Array<[string, Parameters<typeof tryInsert>[0]]> = [
      ['missing spaceKey', { kind: 'pages.create.confluence', pageIds: [], effect: rootEffect({ spaceKey: '' }) }],
      ['bad initialPolicy', { kind: 'pages.create.confluence', pageIds: [], effect: rootEffect({ initialPolicy: 'no_ai' }) }],
      ['no initialLabels', { kind: 'pages.create.confluence', pageIds: [], effect: rootEffect({ initialLabels: undefined }) }],
      ['too many labels', { kind: 'pages.create.confluence', pageIds: [], effect: rootEffect({ initialLabels: Array(51).fill('x') }) }],
      ['bad digest', { kind: 'pages.create.confluence', pageIds: [], effect: rootEffect({ titleSha256: 'zz' }) }],
      ['local effect class', { kind: 'pages.create.confluence', pageIds: [], recoveryMode: 'local_verified', effect: rootEffect({ effectClass: 'local' }) }],
      ['conditional recovery', { kind: 'pages.create.confluence', pageIds: [], recoveryMode: 'remote_conditional', effect: rootEffect() }],
      ['non-empty revisions', { kind: 'pages.create.confluence', pageIds: [], revisions: { 1: {} }, effect: rootEffect() }],
      ['parent id with empty targets', { kind: 'pages.create.confluence', pageIds: [], effect: rootEffect({ parentPageId: 5 }) }],
      ['null parent with targets', { kind: 'pages.create.confluence', pageIds: [1], effect: rootEffect() }],
    ];
    for (const [label, input] of bad) {
      const r = await tryInsert(input);
      expect(r.ok, label).toBe(false);
      expect((r as { code: string }).code, label).toBe('23514');
    }
  });
});
