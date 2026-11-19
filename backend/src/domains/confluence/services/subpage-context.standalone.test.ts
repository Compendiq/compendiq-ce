import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import { assembleContextIfNeeded } from '../../../routes/llm/_helpers.js';
import { assembleSubPageContext, fetchSubPages } from './subpage-context.js';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('source-aware sub-page context (real PostgreSQL)', () => {
  let caller: string;
  let other: string;

  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => {
    await truncateAllTables();
    const users = await query<{ id: string }>(
      `INSERT INTO users (username, email, password_hash, role)
       VALUES ('context-caller', 'caller@test', 'x', 'user'), ('context-other', 'other@test', 'x', 'user') RETURNING id`,
    );
    caller = users.rows[0]!.id;
    other = users.rows[1]!.id;
  });

  async function insertPage(title: string, parentId: string | null, options: {
    source?: 'standalone' | 'confluence'; confluenceId?: string | null; owner?: string; visibility?: 'private' | 'shared'; body?: string;
  } = {}): Promise<number> {
    const result = await query<{ id: number }>(
      `INSERT INTO pages (title, source, visibility, space_key, confluence_id, parent_id,
                          body_text, body_storage, body_html, embedding_dirty, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, '', $8, FALSE, $9) RETURNING id`,
      [title, options.source ?? 'standalone', options.visibility ?? 'shared', options.source === 'confluence' ? 'DOCS' : null,
        options.confluenceId ?? null, parentId, options.body ?? title, `<p>${options.body ?? title}</p>`, options.owner ?? caller],
    );
    return result.rows[0]!.id;
  }

  for (const historical of [false, true]) {
    it(`assembles and recurses through standalone pages with ${historical ? 'historical' : 'null'} Confluence IDs`, async () => {
      const root = await insertPage('Root', null, { confluenceId: historical ? 'historic-root' : null });
      const child = await insertPage('Child', String(root), { confluenceId: historical ? 'historic-child' : null });
      await insertPage('Grandchild', String(child));
      await insertPage('Hidden', String(child), { owner: other, visibility: 'private' });
      await insertPage('Wrong alias', 'historic-root');
      await insertPage('Wrong recursion alias', 'historic-child');

      const assembled = await assembleContextIfNeeded(caller, String(root), '<p>Root</p>', true);
      expect(assembled.markdown).toContain('Child');
      expect(assembled.markdown).toContain('Grandchild');
      expect(assembled.markdown).not.toContain('Hidden');
      expect(assembled.markdown).not.toContain('Wrong alias');
      expect(assembled.markdown).not.toContain('Wrong recursion alias');
      expect(assembled.multiPageSuffix).not.toBe('');
      expect((await fetchSubPages(caller, String(child))).map((p) => p.title)).toEqual(['Grandchild']);
    });
  }

  it('retains Confluence keys and descendant visibility', async () => {
    await query("INSERT INTO spaces (space_key, space_name, source, last_synced) VALUES ('DOCS', 'Docs', 'confluence', NOW())");
    const role = await query<{ id: number }>("INSERT INTO roles (name, display_name, permissions) VALUES ('context-reader', 'Reader', ARRAY['read']) RETURNING id");
    await query("INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id) VALUES ('DOCS', 'user', $1, $2)", [caller, role.rows[0]!.id]);
    const root = await insertPage('Synced root', null, { source: 'confluence', confluenceId: 'c-root' });
    await insertPage('Synced child', 'c-root', { source: 'confluence', confluenceId: 'c-child' });
    await insertPage('Synced grandchild', 'c-child', { source: 'confluence', confluenceId: 'c-grandchild' });
    await insertPage('Wrong internal key', String(root));
    const context = await assembleContextIfNeeded(caller, String(root), '<p>Root</p>', true);
    expect(context.markdown).toContain('Synced child');
    expect(context.markdown).toContain('Synced grandchild');
    expect(context.markdown).not.toContain('Wrong internal key');
  });

  it('preserves depth and character limits', async () => {
    const root = await insertPage('Root', null, { confluenceId: 'old-root' });
    let parent = root;
    for (let depth = 1; depth <= 6; depth++) {
      parent = await insertPage(`Level ${depth}`, String(parent), { confluenceId: `old-${depth}`, body: 'z'.repeat(500) });
    }
    const descendants = await fetchSubPages(caller, String(root));
    expect(descendants.map((p) => p.depth)).toEqual([1, 2, 3, 4, 5]);
    const context = await assembleSubPageContext(caller, String(root), '<p>Root</p>', 'Root', 300);
    expect(context.wasTruncated).toBe(true);
    expect(context.markdown).not.toContain('Level 2');
  });

  it('stops on a short cycle and limits the number of descendants', async () => {
    const root = await insertPage('Cycle root', null, { confluenceId: 'old-cycle-root' });
    const child = await insertPage('Cycle child', String(root), { confluenceId: 'old-cycle-child' });
    await query('UPDATE pages SET parent_id = $1 WHERE id = $2', [String(child), root]);
    expect((await fetchSubPages(caller, String(root))).map((p) => p.title)).toEqual(['Cycle child', 'Cycle root']);

    const wideRoot = await insertPage('Wide root', null, { confluenceId: 'old-wide' });
    for (let i = 0; i < 51; i++) await insertPage(`Wide ${i}`, String(wideRoot));
    expect(await fetchSubPages(caller, String(wideRoot))).toHaveLength(50);
  });
});
