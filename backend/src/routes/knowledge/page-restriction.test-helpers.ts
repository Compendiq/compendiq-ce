/**
 * Shared real-PostgreSQL fixture for page-restriction read tests.
 *
 * One Confluence space `DOCS` holds:
 * - `Open Root` (inherits space permissions) with the restricted child
 *   `Hushed Leaf`;
 * - the restricted `Hushed Parent` with an inheriting child `Visible Child`;
 * - a shared standalone note, and a private standalone note owned by R.
 *
 * Principals: R has a DOCS role and no ACE. G has a DOCS role and reads the
 * restricted pages through a group ACE. The administrator has no role.
 */
import { randomUUID } from 'node:crypto';
import { query } from '../../core/db/postgres.js';

export const SEARCH_TERM = 'zephyrquartz';
export const RESTRICTED_TITLES = ['Hushed Leaf', 'Hushed Parent'] as const;
/** Unique body/label tokens only a restricted page carries. */
export const RESTRICTED_TOKENS = ['hushleafbody', 'hushparentbody', 'hush-label'] as const;

export interface RestrictionFixture {
  readerId: string;
  groupReaderId: string;
  adminId: string;
  groupId: number;
  groupAceIds: number[];
  pages: {
    openRoot: number;
    hushedLeaf: number;
    hushedParent: number;
    visibleChild: number;
    sharedNote: number;
    readerPrivate: number;
  };
}

async function insertFixtureUser(prefix: string, role: 'user' | 'admin'): Promise<string> {
  const username = `${prefix}-${randomUUID()}`;
  const res = await query<{ id: string }>(
    `INSERT INTO users (username, email, password_hash, role)
     VALUES ($1, $2, 'x', $3) RETURNING id`,
    [username, `${username}@test`, role],
  );
  return res.rows[0]!.id;
}

export async function grantSpaceRole(userId: string, spaceKey: string): Promise<void> {
  const role = await query<{ id: number }>(
    `INSERT INTO roles (name, display_name, permissions)
     VALUES ($1, 'Restriction fixture reader', ARRAY['read'])
     RETURNING id`,
    [`restriction-reader-${randomUUID()}`],
  );
  await query(
    `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
     VALUES ($1, 'user', $2, $3)`,
    [spaceKey, userId, role.rows[0]!.id],
  );
}

async function insertConfluenceFixturePage(
  confluenceId: string,
  title: string,
  body: string,
  opts: { parentId?: string; inheritPerms?: boolean; labels?: string[] } = {},
): Promise<number> {
  const res = await query<{ id: number }>(
    `INSERT INTO pages (confluence_id, source, space_key, title, body_text, body_storage,
                        body_html, inherit_perms, embedding_dirty, parent_id, labels, author)
     VALUES ($1, 'confluence', 'DOCS', $2, $3, '', $4, $5, FALSE, $6, $7, 'fixture-author')
     RETURNING id`,
    [
      confluenceId,
      title,
      body,
      `<p>${body}</p>`,
      opts.inheritPerms ?? true,
      opts.parentId ?? null,
      opts.labels ?? [],
    ],
  );
  return res.rows[0]!.id;
}

async function insertStandaloneFixturePage(
  title: string,
  body: string,
  visibility: 'shared' | 'private',
  ownerId: string,
): Promise<number> {
  const res = await query<{ id: number }>(
    `INSERT INTO pages (source, space_key, title, body_text, body_html, visibility,
                        created_by_user_id, embedding_dirty, labels)
     VALUES ('standalone', 'DOCS', $1, $2, $3, $4, $5, FALSE, '{}')
     RETURNING id`,
    [title, body, `<p>${body}</p>`, visibility, ownerId],
  );
  return res.rows[0]!.id;
}

export async function insertPageAce(
  pageId: number,
  principalType: 'user' | 'group',
  principalId: string,
): Promise<number> {
  const res = await query<{ id: number }>(
    `INSERT INTO access_control_entries
       (resource_type, resource_id, principal_type, principal_id, permission)
     VALUES ('page', $1, $2, $3, 'read')
     RETURNING id`,
    [pageId, principalType, principalId],
  );
  return res.rows[0]!.id;
}

export async function seedRestrictionFixture(): Promise<RestrictionFixture> {
  const readerId = await insertFixtureUser('restriction-r', 'user');
  const groupReaderId = await insertFixtureUser('restriction-g', 'user');
  const adminId = await insertFixtureUser('restriction-admin', 'admin');

  await query(
    `INSERT INTO spaces (space_key, space_name, source, homepage_id, last_synced)
     VALUES ('DOCS', 'Docs', 'confluence', 'c-hushed-parent', NOW())`,
  );
  await grantSpaceRole(readerId, 'DOCS');
  await grantSpaceRole(groupReaderId, 'DOCS');

  const group = await query<{ id: number }>(
    `INSERT INTO groups (name) VALUES ($1) RETURNING id`,
    [`restriction-legal-${randomUUID()}`],
  );
  const groupId = group.rows[0]!.id;
  await query('INSERT INTO group_memberships (group_id, user_id) VALUES ($1, $2)', [groupId, groupReaderId]);

  const openRoot = await insertConfluenceFixturePage(
    'c-open-root', 'Open Root', `${SEARCH_TERM} openrootbody`, { labels: ['open-label'] },
  );
  const hushedLeaf = await insertConfluenceFixturePage(
    'c-hushed-leaf', 'Hushed Leaf', `${SEARCH_TERM} hushleafbody`,
    { parentId: 'c-open-root', labels: ['hush-label'] },
  );
  const hushedParent = await insertConfluenceFixturePage(
    'c-hushed-parent', 'Hushed Parent', `${SEARCH_TERM} hushparentbody`,
  );
  const visibleChild = await insertConfluenceFixturePage(
    'c-visible-child', 'Visible Child', `${SEARCH_TERM} visiblechildbody`,
    { parentId: 'c-hushed-parent' },
  );
  const sharedNote = await insertStandaloneFixturePage(
    'Shared Note', `${SEARCH_TERM} sharednotebody`, 'shared', groupReaderId,
  );
  const readerPrivate = await insertStandaloneFixturePage(
    'Reader Private', `${SEARCH_TERM} readerprivatebody`, 'private', readerId,
  );

  // Restrict both pages: inherit_perms off plus a group ACE for G only.
  await query(
    'UPDATE pages SET inherit_perms = FALSE WHERE id = ANY($1::int[])',
    [[hushedLeaf, hushedParent]],
  );
  const groupAceIds = [
    await insertPageAce(hushedLeaf, 'group', String(groupId)),
    await insertPageAce(hushedParent, 'group', String(groupId)),
  ];

  return {
    readerId,
    groupReaderId,
    adminId,
    groupId,
    groupAceIds,
    pages: { openRoot, hushedLeaf, hushedParent, visibleChild, sharedNote, readerPrivate },
  };
}

/** Assert a serialized response discloses no restricted title, body or label. */
export function restrictedLeaks(body: string): string[] {
  return [...RESTRICTED_TITLES, ...RESTRICTED_TOKENS].filter((token) => body.includes(token));
}
