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

  it('is idempotent: after two runs the root and parented shapes are accepted and malformed labels refused', async () => {
    await query(sql);
    await query(sql);
    expect(await tryInsert({ kind: 'pages.create.confluence', pageIds: [], effect: rootEffect() })).toEqual({ ok: true });
    const parent = await insertPage();
    expect(await tryInsert({
      kind: 'pages.create.confluence',
      pageIds: [parent],
      revisions: { [parent]: { contentRevision: '1', lifecycleRevision: '1' } },
      effect: rootEffect({ parentPageId: parent, parentConfluenceId: '123' }),
    })).toEqual({ ok: true });
    const bad = await tryInsert({
      kind: 'pages.create.confluence', pageIds: [], effect: rootEffect({ initialLabels: [null, 7, { x: 1 }] }),
    });
    expect(bad).toMatchObject({ ok: false, code: '23514' });
  });

  it('upgrades a constraint produced by the first revision (no element rule) in place', async () => {
    await query(sql);
    // Reproduce the first revision's constraint: 125's expression OR the
    // old root branch (array + length only).
    const current = await query<{ condef: string }>(
      `SELECT pg_get_constraintdef(oid) AS condef FROM pg_constraint
        WHERE conrelid = 'page_write_intents'::regclass AND conname = 'page_write_intents_effect_policy_check'`,
    );
    expect(current.rows[0]!.condef).toContain('page_write_intent_initial_labels_valid');
    const oldDef = current.rows[0]!.condef.replace(
      /page_write_intent_initial_labels_valid\(([^)]*\))\)/,
      "(jsonb_typeof($1) = 'array'::text AND jsonb_array_length($1) <= 50)",
    );
    expect(oldDef).not.toContain('page_write_intent_initial_labels_valid');
    await query('ALTER TABLE page_write_intents DROP CONSTRAINT page_write_intents_effect_policy_check');
    await query(`ALTER TABLE page_write_intents ADD CONSTRAINT page_write_intents_effect_policy_check ${oldDef}`);
    // Old revision admits a non-string label element…
    expect(await tryInsert({
      kind: 'pages.create.confluence', pageIds: [], effect: rootEffect({ initialLabels: [7] }),
    })).toEqual({ ok: true });
    await query('DELETE FROM page_write_intents');
    // …the re-run tightens it without touching the parented shape.
    await query(sql);
    expect(await tryInsert({
      kind: 'pages.create.confluence', pageIds: [], effect: rootEffect({ initialLabels: [7] }),
    })).toMatchObject({ ok: false, code: '23514' });
    expect(await tryInsert({ kind: 'pages.create.confluence', pageIds: [], effect: rootEffect() })).toEqual({ ok: true });
    const parent = await insertPage();
    expect(await tryInsert({
      kind: 'pages.create.confluence',
      pageIds: [parent],
      revisions: { [parent]: { contentRevision: '1', lifecycleRevision: '1' } },
      effect: rootEffect({ parentPageId: parent, parentConfluenceId: '123', initialLabels: [7] }),
    })).toEqual({ ok: true });
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
