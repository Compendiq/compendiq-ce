/**
 * `visiblePagesPredicate` against real PostgreSQL: the non-RAG list
 * definition must equal today's space-level list visibility intersected with
 * `userCanAccessPage` for every non-admin, and must equal today's listing for
 * administrators. `ragRetrievalPagesPredicate` must stay space-level.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query } from '../db/postgres.js';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../test-db-helper.js';
import { ragRetrievalPagesPredicate, visiblePagesPredicate } from './page-visibility.js';
import { getUserAccessibleSpaces, invalidateRbacCache, userCanAccessPage } from './rbac-service.js';

const dbAvailable = await isDbAvailable();

async function insertUser(role: 'user' | 'admin'): Promise<string> {
  const name = `visibility-${randomUUID()}`;
  const res = await query<{ id: string }>(
    `INSERT INTO users (username, email, password_hash, role) VALUES ($1, $1 || '@test', 'x', $2) RETURNING id`,
    [name, role],
  );
  return res.rows[0]!.id;
}

async function insertPage(
  title: string,
  opts: { source?: 'confluence' | 'standalone'; space?: string; inherit?: boolean; visibility?: string; owner?: string },
): Promise<number> {
  const res = await query<{ id: number }>(
    `INSERT INTO pages (confluence_id, source, space_key, title, body_text, body_html, inherit_perms,
                        visibility, created_by_user_id)
     VALUES ($1, $2, $3, $4, 'x', '<p>x</p>', $5, $6, $7) RETURNING id`,
    [
      opts.source === 'standalone' ? null : `c-${randomUUID()}`,
      opts.source ?? 'confluence',
      opts.space ?? 'DOCS',
      title,
      opts.inherit ?? true,
      opts.visibility ?? 'shared',
      opts.owner ?? null,
    ],
  );
  return res.rows[0]!.id;
}

async function addAce(pageId: number, principalType: 'user' | 'group', principalId: string): Promise<void> {
  await query(
    `INSERT INTO access_control_entries (resource_type, resource_id, principal_type, principal_id, permission)
     VALUES ('page', $1, $2, $3, 'read')`,
    [pageId, principalType, principalId],
  );
}

async function visibleTitles(userId: string, predicate: typeof visiblePagesPredicate): Promise<string[]> {
  const spaces = await getUserAccessibleSpaces(userId);
  const res = await query<{ title: string }>(
    `SELECT cp.title FROM pages cp WHERE cp.deleted_at IS NULL AND ${predicate(1, 2)} ORDER BY cp.title`,
    [spaces, userId],
  );
  return res.rows.map((row) => row.title);
}

describe.skipIf(!dbAvailable)('visiblePagesPredicate — page restrictions (real PostgreSQL)', () => {
  let reader: string;
  let groupReader: string;
  let aceWithoutSpace: string;
  let admin: string;
  let owner: string;

  beforeAll(async () => {
    await setupTestDb();
  });

  afterAll(async () => {
    await truncateAllTables();
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    await invalidateRbacCache();
    [reader, groupReader, aceWithoutSpace, admin, owner] = await Promise.all([
      insertUser('user'), insertUser('user'), insertUser('user'), insertUser('admin'), insertUser('user'),
    ]);
    await query(
      `INSERT INTO spaces (space_key, space_name, source) VALUES ('DOCS', 'Docs', 'confluence'),
                                                               ('OTHER', 'Other', 'confluence')`,
    );
    const role = await query<{ id: number }>(
      `INSERT INTO roles (name, display_name, permissions) VALUES ($1, 'Reader', ARRAY['read']) RETURNING id`,
      [`visibility-reader-${randomUUID()}`],
    );
    for (const userId of [reader, groupReader]) {
      await query(
        `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
         VALUES ('DOCS', 'user', $1, $2)`,
        [userId, role.rows[0]!.id],
      );
    }
    const group = await query<{ id: number }>(`INSERT INTO groups (name) VALUES ($1) RETURNING id`, [
      `visibility-group-${randomUUID()}`,
    ]);
    const groupId = group.rows[0]!.id;
    await query('INSERT INTO group_memberships (group_id, user_id) VALUES ($1, $2)', [groupId, groupReader]);

    await insertPage('open', {});
    await insertPage('other-space', { space: 'OTHER' });
    const userAce = await insertPage('restricted-user-ace', { inherit: false });
    await addAce(userAce, 'user', reader);
    await addAce(userAce, 'user', aceWithoutSpace);
    const groupAce = await insertPage('restricted-group-ace', { inherit: false });
    await addAce(groupAce, 'group', String(groupId));
    const noAce = await insertPage('restricted-no-ace', { inherit: false });
    await addAce(noAce, 'group', 'not-a-number');
    await insertPage('standalone-shared-restricted', { source: 'standalone', inherit: false });
    await insertPage('standalone-private-own', {
      source: 'standalone', visibility: 'private', owner: reader, inherit: false,
    });
    await insertPage('standalone-private-foreign', { source: 'standalone', visibility: 'private', owner });
  });

  it('matches space-level list visibility intersected with userCanAccessPage for non-admins', async () => {
    for (const userId of [reader, groupReader, aceWithoutSpace, owner]) {
      const listed = await visibleTitles(userId, ragRetrievalPagesPredicate);
      const all = await query<{ id: number; title: string }>('SELECT id, title FROM pages ORDER BY title');
      const expected: string[] = [];
      for (const page of all.rows) {
        if (listed.includes(page.title) && await userCanAccessPage(userId, page.id)) expected.push(page.title);
      }
      expect(await visibleTitles(userId, visiblePagesPredicate)).toEqual(expected);
    }
    expect(await visibleTitles(reader, visiblePagesPredicate)).toEqual([
      'open',
      'restricted-user-ace',
      'standalone-private-own',
      'standalone-shared-restricted',
    ]);
    expect(await visibleTitles(groupReader, visiblePagesPredicate)).toEqual([
      'open',
      'restricted-group-ace',
      'standalone-shared-restricted',
    ]);
    // An ACE alone does not add a page to lists without a role on its space.
    expect(await visibleTitles(aceWithoutSpace, visiblePagesPredicate)).toEqual(['standalone-shared-restricted']);
  });

  it('denies, without erroring, a group principal too large for an integer group id', async () => {
    const oversized = await insertPage('restricted-oversized-principal', { inherit: false });
    await addAce(oversized, 'group', '99999999999');
    expect(await visibleTitles(groupReader, visiblePagesPredicate)).not.toContain('restricted-oversized-principal');
  });

  it('keeps administrator listings unchanged: restricted pages yes, foreign private pages no', async () => {
    const adminListing = await visibleTitles(admin, visiblePagesPredicate);
    expect(adminListing).toEqual(await visibleTitles(admin, ragRetrievalPagesPredicate));
    expect(adminListing).toContain('restricted-no-ace');
    expect(adminListing).not.toContain('standalone-private-foreign');
  });

  it('keeps the RAG retrieval predicate space-level', async () => {
    expect(await visibleTitles(reader, ragRetrievalPagesPredicate)).toEqual([
      'open',
      'restricted-group-ace',
      'restricted-no-ace',
      'restricted-user-ace',
      'standalone-private-own',
      'standalone-shared-restricted',
    ]);
  });
});
