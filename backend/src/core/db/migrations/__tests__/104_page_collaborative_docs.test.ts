import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../../test-db-helper.js';
import { query } from '../../postgres.js';

const dbAvailable = await isDbAvailable();

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const architectureDir = path.resolve(migrationsDir, '../../../../../docs/architecture');

/**
 * #1443 / #1411 PR 1 — unused CRDT persistence table + flag default off.
 * The gateway does not exist yet; this migration is the schema the later
 * PRs persist into. `version` is a BYTEA write generation, not pages.version.
 */
describe('Migration 104 filename (#1443)', () => {
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));

  it('is 104_page_collaborative_docs.sql — 102 is Notion on origin/dev', () => {
    expect(files).toContain('104_page_collaborative_docs.sql');
    expect(files.filter((f) => /^102_.*collab/.test(f))).toEqual([]);
    expect(files.filter((f) => /^099_.*collab/.test(f))).toEqual([]);
  });
});

describe('docs/architecture index for collab (#1443)', () => {
  it('lists 12-realtime-collaboration.md in the README index and maintenance table', () => {
    const readme = fs.readFileSync(path.join(architectureDir, 'README.md'), 'utf8');
    expect(readme).toContain('[`12-realtime-collaboration.md`](./12-realtime-collaboration.md)');
    expect(readme).toMatch(/page_collaborative_docs/);
    expect(readme).toMatch(/collab_editing_enabled|collab gateway/);
    expect(fs.existsSync(path.join(architectureDir, '12-realtime-collaboration.md'))).toBe(true);
  });
});

const specPath = path.resolve(
  architectureDir,
  '../superpowers/specs/2026-08-24-realtime-collaborative-editing-design.md',
);

/**
 * #1450 review locks — these sentences are the contract later PRs implement.
 * A silent delete from the spec or from diagram 12 would reopen the BYTEA
 * stale-join hole, the empty-room 409 gap, the read-mode WS, or the
 * awareness API name mix-up.
 */
describe('collab design locks (#1443 / #1450 review)', () => {
  const spec = fs.readFileSync(specPath, 'utf8');
  const arch = fs.readFileSync(path.join(architectureDir, '12-realtime-collaboration.md'), 'utf8');

  it('invalidates BYTEA after empty-room body_html writes via DELETE', () => {
    expect(spec).toMatch(/DELETE FROM page_collaborative_docs/);
    expect(spec).toMatch(/BYTEA is valid only while it still corresponds to live `body_html`/);
    expect(spec).not.toMatch(/BYTEA rows can stay/);
    expect(arch).toMatch(/DELETE FROM page_collaborative_docs/);
    expect(arch).toMatch(/empty-room/);
  });

  it('delays SREM of the last collab:active member until empty-room grace fires', () => {
    expect(spec).toMatch(/Do \*\*not\*\* `SREM` the last `collab:active` member/);
    expect(spec).toMatch(/assertNoLiveCollabRoom.*heap|heap.*assertNoLiveCollabRoom/s);
    expect(arch).toMatch(/SREM/);
    expect(arch).toMatch(/empty-room grace/);
  });

  it('mounts the collab provider only in edit mode', () => {
    expect(spec).toMatch(/only in edit mode/);
    expect(arch).toMatch(/only in edit mode/);
    expect(spec).not.toMatch(/Flag on: PageViewPage opens the provider/);
    expect(arch).not.toMatch(/Flag on: PageViewPage opens the provider/);
  });

  it('names awareness applyAwarenessUpdate, not awareness.applyUpdate', () => {
    expect(spec).toMatch(/applyAwarenessUpdate/);
    expect(spec).toMatch(/encodeAwarenessUpdate/);
    expect(spec).not.toMatch(/Awareness: `awareness\.applyUpdate`/);
  });
});

function collabFlagSeedSql(): string {
  const migrationSql = fs.readFileSync(
    path.join(migrationsDir, '104_page_collaborative_docs.sql'),
    'utf8',
  );
  const seedSql = migrationSql.match(
    /INSERT INTO admin_settings[\s\S]*?ON CONFLICT \(setting_key\) DO NOTHING/,
  )?.[0];
  if (!seedSql) throw new Error('migration 104 must seed collab_editing_enabled');
  return seedSql;
}

describe.skipIf(!dbAvailable)('Migration 104 — page_collaborative_docs (#1443)', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => { await truncateAllTables(); });

  async function seedPage(version = 1): Promise<number> {
    const res = await query<{ id: number }>(
      `INSERT INTO pages (
         space_key, title, body_html, body_text, version, source,
         embedding_dirty, embedding_status
       ) VALUES ('TEST', 'Collab page', '<p>v1</p>', 'v1', $1, 'standalone', FALSE, 'not_embedded')
       RETURNING id`,
      [version],
    );
    return res.rows[0]!.id;
  }

  it('is recorded in _migrations and seeds collab_editing_enabled to 0', async () => {
    const applied = await query<{ name: string }>(
      `SELECT name FROM _migrations WHERE name = '104_page_collaborative_docs.sql'`,
    );
    expect(applied.rows).toHaveLength(1);

    const src = fs.readFileSync(path.join(migrationsDir, '104_page_collaborative_docs.sql'), 'utf8');
    expect(src).toMatch(/VALUES\s*\(\s*'collab_editing_enabled',\s*'0'/);

    await query(collabFlagSeedSql());
    const { rows } = await query<{ setting_value: string }>(
      `SELECT setting_value FROM admin_settings WHERE setting_key = 'collab_editing_enabled'`,
    );
    expect(rows).toEqual([{ setting_value: '0' }]);
  });

  it('creates the table with page_id PK/FK, BYTEA state, and persistence version', async () => {
    const { rows } = await query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
      `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'page_collaborative_docs'
        ORDER BY column_name`,
    );
    const byName = Object.fromEntries(rows.map((r) => [r.column_name, r]));

    expect(Object.keys(byName).sort()).toEqual([
      'created_at', 'doc_state', 'page_id', 'state_vector', 'updated_at', 'version',
    ]);
    expect(byName.page_id).toMatchObject({ data_type: 'integer', is_nullable: 'NO' });
    expect(byName.doc_state).toMatchObject({ data_type: 'bytea', is_nullable: 'NO' });
    expect(byName.state_vector).toMatchObject({ data_type: 'bytea', is_nullable: 'YES' });
    expect(byName.version).toMatchObject({ data_type: 'integer', is_nullable: 'NO' });
    expect(byName.version!.column_default).toMatch(/1/);
    expect(byName.created_at).toMatchObject({ data_type: 'timestamp with time zone', is_nullable: 'NO' });
    expect(byName.updated_at).toMatchObject({ data_type: 'timestamp with time zone', is_nullable: 'NO' });
  });

  it('uses page_id as PRIMARY KEY referencing pages(id) ON DELETE CASCADE', async () => {
    const { rows: pk } = await query<{ column_name: string }>(
      `SELECT kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
        WHERE tc.table_name = 'page_collaborative_docs'
          AND tc.constraint_type = 'PRIMARY KEY'`,
    );
    expect(pk.map((r) => r.column_name)).toEqual(['page_id']);

    const { rows: fk } = await query<{ delete_rule: string; foreign_table: string; foreign_column: string }>(
      `SELECT rc.delete_rule, ccu.table_name AS foreign_table, ccu.column_name AS foreign_column
         FROM information_schema.referential_constraints rc
         JOIN information_schema.key_column_usage kcu
           ON rc.constraint_name = kcu.constraint_name
         JOIN information_schema.constraint_column_usage ccu
           ON rc.unique_constraint_name = ccu.constraint_name
        WHERE kcu.table_name = 'page_collaborative_docs'
          AND kcu.column_name = 'page_id'`,
    );
    expect(fk).toEqual([
      { delete_rule: 'CASCADE', foreign_table: 'pages', foreign_column: 'id' },
    ]);
  });

  it('indexes updated_at', async () => {
    const { rows } = await query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'page_collaborative_docs'
          AND indexname = 'idx_page_collaborative_docs_updated'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.indexdef).toMatch(/updated_at/);
  });

  it('defaults version to 1 independently of pages.version', async () => {
    const pageId = await seedPage(7);
    await query(
      `INSERT INTO page_collaborative_docs (page_id, doc_state) VALUES ($1, $2)`,
      [pageId, Buffer.from([0x01, 0x02])],
    );
    const { rows } = await query<{ version: number; pages_version: number }>(
      `SELECT d.version, p.version AS pages_version
         FROM page_collaborative_docs d
         JOIN pages p ON p.id = d.page_id
        WHERE d.page_id = $1`,
      [pageId],
    );
    expect(rows[0]).toEqual({ version: 1, pages_version: 7 });
  });

  it('stores BYTEA and leaves state_vector nullable', async () => {
    const pageId = await seedPage();
    const payload = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    await query(
      `INSERT INTO page_collaborative_docs (page_id, doc_state) VALUES ($1, $2)`,
      [pageId, payload],
    );
    const { rows } = await query<{ doc_state: Buffer; state_vector: Buffer | null }>(
      `SELECT doc_state, state_vector FROM page_collaborative_docs WHERE page_id = $1`,
      [pageId],
    );
    expect(Buffer.isBuffer(rows[0]!.doc_state)).toBe(true);
    expect(Buffer.from(rows[0]!.doc_state)).toEqual(payload);
    expect(rows[0]!.state_vector).toBeNull();
  });

  it('refuses a row without doc_state', async () => {
    const pageId = await seedPage();
    await expect(
      query(`INSERT INTO page_collaborative_docs (page_id) VALUES ($1)`, [pageId]),
    ).rejects.toThrow(/null value|not-null|not null/i);
  });

  it('CASCADEs when its page is deleted', async () => {
    const pageId = await seedPage();
    await query(
      `INSERT INTO page_collaborative_docs (page_id, doc_state) VALUES ($1, $2)`,
      [pageId, Buffer.from([0x00])],
    );
    await query('DELETE FROM pages WHERE id = $1', [pageId]);
    const { rows } = await query(
      'SELECT 1 FROM page_collaborative_docs WHERE page_id = $1',
      [pageId],
    );
    expect(rows).toHaveLength(0);
  });

  it('is one row per page — a second insert on the same page_id fails', async () => {
    const pageId = await seedPage();
    await query(
      `INSERT INTO page_collaborative_docs (page_id, doc_state) VALUES ($1, $2)`,
      [pageId, Buffer.from([0x01])],
    );
    await expect(
      query(
        `INSERT INTO page_collaborative_docs (page_id, doc_state) VALUES ($1, $2)`,
        [pageId, Buffer.from([0x02])],
      ),
    ).rejects.toThrow(/duplicate|unique|primary key/i);
  });

  it('re-seeds collab_editing_enabled = 0 without overwriting a set value', async () => {
    const seedSql = collabFlagSeedSql();
    await query(seedSql);
    const first = await query<{ setting_value: string }>(
      `SELECT setting_value FROM admin_settings WHERE setting_key = 'collab_editing_enabled'`,
    );
    expect(first.rows[0]!.setting_value).toBe('0');

    await query(
      `UPDATE admin_settings SET setting_value = '1' WHERE setting_key = 'collab_editing_enabled'`,
    );
    await query(seedSql);
    const after = await query<{ setting_value: string }>(
      `SELECT setting_value FROM admin_settings WHERE setting_key = 'collab_editing_enabled'`,
    );
    expect(after.rows[0]!.setting_value).toBe('1');
  });
});
