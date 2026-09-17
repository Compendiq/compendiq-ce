/**
 * #1636 — the shared page-subtree walk against a REAL PostgreSQL.
 *
 * `page-subtree.ts` is the one definition of "the subtree under a page": the
 * delete cascade, the restore batch, `descendantCount` and the ancestor guard
 * all read it, so drift between them is impossible by construction. Two of its
 * properties cannot be pinned with a mocked `query`:
 *
 *   1. the walk must TRAVERSE a trashed intermediate (a cascade that stops
 *      there leaves the live grandchildren it was supposed to trash orphaned
 *      at the tree root — the issue's bug, one level down), while only ever
 *      RETURNING the members the caller asked for;
 *   2. `UNION` is the cycle guard — a `parent_id` cycle (reachable through the
 *      relocate path) must terminate instead of hanging the request.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  setupTestDb,
  truncateAllTables,
  teardownTestDb,
  isDbAvailable,
} from '../../test-db-helper.js';
import { query } from '../db/postgres.js';
import {
  subtreeIds,
  activeDescendantCount,
  trashBatchIds,
  trashedAncestorOf,
} from './page-subtree.js';

const dbAvailable = await isDbAvailable();

let owner: string;

async function insertPage(
  title: string,
  opts: { parentId?: string | null; deletedAt?: Date | null; source?: 'standalone' | 'confluence'; confluenceId?: string | null } = {},
): Promise<number> {
  const res = await query<{ id: number }>(
    `INSERT INTO pages (title, body_text, body_html, version, source, confluence_id,
                        visibility, created_by_user_id, embedding_dirty, embedding_status,
                        deleted_at, parent_id)
     VALUES ($1, 'x', '<p>x</p>', 1, $2, $3, 'private', $4, FALSE, 'not_embedded', $5, $6)
     RETURNING id`,
    [
      title,
      opts.source ?? 'standalone',
      opts.confluenceId ?? null,
      owner,
      opts.deletedAt ?? null,
      opts.parentId ?? null,
    ],
  );
  return res.rows[0]!.id;
}

describe.skipIf(!dbAvailable)('page-subtree — real PostgreSQL (#1636)', () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    const res = await query<{ id: string }>(
      "INSERT INTO users (username, email, password_hash, role) VALUES ('subtree_owner', 'subtree@test', 'x', 'user') RETURNING id",
    );
    owner = res.rows[0]!.id;
  });

  it('walks through a trashed intermediate to the live grandchild', async () => {
    const root = await insertPage('Root');
    const trashed = await insertPage('Trashed child', {
      parentId: String(root),
      deletedAt: new Date('2020-01-01T00:00:00Z'),
    });
    const live = await insertPage('Live grandchild', { parentId: String(trashed) });

    expect((await subtreeIds(root)).sort()).toEqual([root, trashed, live].sort());
    // activeOnly answers the question the cascade asks: what will THIS request
    // change? The trashed member keeps its own stamp.
    expect(await subtreeIds(root, { activeOnly: true })).toEqual([root, live]);
  });

  it('counts only live descendants and never the page itself', async () => {
    const root = await insertPage('Root');
    const child = await insertPage('Child', { parentId: String(root) });
    await insertPage('Trashed child', { parentId: String(root), deletedAt: new Date() });
    await insertPage('Grandchild', { parentId: String(child) });
    const leaf = await insertPage('Leaf');

    expect(await activeDescendantCount(root)).toBe(2);
    expect(await activeDescendantCount(leaf)).toBe(0);
  });

  it('follows a synced child’s confluence_id link rather than its numeric parent', async () => {
    const parent = await insertPage('Synced parent', { source: 'confluence', confluenceId: 'conf-9' });
    const child = await insertPage('Synced child', {
      source: 'confluence',
      confluenceId: 'conf-10',
      parentId: 'conf-9',
    });

    expect((await subtreeIds(parent)).sort()).toEqual([parent, child].sort());
  });

  it('terminates on a parent_id cycle', async () => {
    const a = await insertPage('Cycle A');
    const b = await insertPage('Cycle B', { parentId: String(a) });
    await query('UPDATE pages SET parent_id = $1 WHERE id = $2', [String(b), a]);

    expect((await subtreeIds(a)).sort()).toEqual([a, b].sort());
  });

  it('returns the page plus the descendants sharing its delete stamp as one batch', async () => {
    const stamp = new Date('2021-05-05T05:05:05Z');
    const root = await insertPage('Root', { deletedAt: stamp });
    const withRoot = await insertPage('Trashed with root', { parentId: String(root), deletedAt: stamp });
    const separately = await insertPage('Trashed separately', {
      parentId: String(root),
      deletedAt: new Date('2021-01-01T00:00:00Z'),
    });

    expect((await trashBatchIds(root)).sort()).toEqual([root, withRoot].sort());
    expect(await trashBatchIds(separately)).toEqual([separately]);
  });

  it('names the nearest trashed ancestor, and nothing while the chain is live', async () => {
    const grandparent = await insertPage('Grandparent');
    const parent = await insertPage('Parent', { parentId: String(grandparent) });
    const child = await insertPage('Child', { parentId: String(parent) });

    expect(await trashedAncestorOf(child)).toBeNull();
    expect(await trashedAncestorOf(grandparent)).toBeNull();

    // The row travels with the fields a caller needs to decide whether it may
    // be NAMED in a refusal: the title belongs to a page the restoring user
    // does not necessarily own (a page can be created under another user's),
    // and `parent_id` holds no reader information of its own.
    const expected = {
      id: parent,
      title: 'Parent',
      source: 'standalone',
      spaceKey: null,
      visibility: 'private',
      createdByUserId: owner,
    };

    await query('UPDATE pages SET deleted_at = NOW() WHERE id = $1', [parent]);
    expect(await trashedAncestorOf(child)).toEqual(expected);

    // The NEAREST trashed ancestor is the actionable one — the caller can
    // restore it right now, and its own restore re-runs this guard one level up.
    await query('UPDATE pages SET deleted_at = NOW() WHERE id = $1', [grandparent]);
    expect(await trashedAncestorOf(child)).toEqual(expected);

    // The page's own state is the restore route's separate guard, never an
    // "ancestor" of itself.
    await query('UPDATE pages SET deleted_at = NOW() WHERE id = $1', [child]);
    expect(await trashedAncestorOf(child)).toEqual(expected);
  });

  it('terminates the ancestor walk on a cycle', async () => {
    const a = await insertPage('Cycle A');
    const b = await insertPage('Cycle B', { parentId: String(a) });
    await query('UPDATE pages SET parent_id = $1 WHERE id = $2', [String(b), a]);

    expect(await trashedAncestorOf(b)).toBeNull();
  });
});
