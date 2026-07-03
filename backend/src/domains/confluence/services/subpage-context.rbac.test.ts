/**
 * Sub-page context RBAC / soft-delete filtering against a REAL PostgreSQL.
 *
 * Regression (#814): `fetchSubPages` walked the page tree purely by
 * `parent_id`, ignoring the `userId` it was handed and omitting
 * `deleted_at IS NULL`. That let /llm/ask (and improve/quality/summarize via
 * `assembleContextIfNeeded`) pull the body of any descendant page — including
 * pages in Confluence spaces the caller has no RBAC access to, and
 * soft-deleted pages — straight into the LLM prompt (cross-space IDOR).
 *
 * The resolver (`getUserAccessibleSpacesMemoized`) is mocked at the boundary;
 * the space/visibility predicate itself runs against real rows.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  setupTestDb,
  truncateAllTables,
  teardownTestDb,
  isDbAvailable,
} from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';

// --- Boundary mock: the accessible-space resolver (tested elsewhere) ---
const mockGetSpaces = vi.fn();
vi.mock('../../../core/services/rbac-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../core/services/rbac-service.js')>()),
  getUserAccessibleSpacesMemoized: (...args: unknown[]) => mockGetSpaces(...args),
}));

import { fetchSubPages } from './subpage-context.js';

async function insertUser(username: string): Promise<string> {
  const res = await query<{ id: string }>(
    "INSERT INTO users (username, email, password_hash, role) VALUES ($1, $2, 'x', 'user') RETURNING id",
    [username, `${username}@test`],
  );
  return res.rows[0]!.id;
}

async function insertConfluenceChild(
  confluenceId: string,
  title: string,
  spaceKey: string,
  parentId: string,
  opts: { deletedAt?: Date } = {},
): Promise<void> {
  await query(
    `INSERT INTO pages (confluence_id, source, space_key, title, body_text,
                        body_storage, body_html, parent_id, inherit_perms,
                        embedding_dirty, deleted_at)
     VALUES ($1, 'confluence', $2, $3, 'text', '', '<p>secret</p>', $4, TRUE, FALSE, $5)`,
    [confluenceId, spaceKey, title, parentId, opts.deletedAt ?? null],
  );
}

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('fetchSubPages — RBAC + soft-delete filtering (DB)', () => {
  let caller: string;

  beforeAll(async () => {
    await setupTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await truncateAllTables();
    caller = await insertUser('subpage_rbac_caller');
    // Caller can read the ALLOWED space only.
    mockGetSpaces.mockResolvedValue(['ALLOWED']);
  });

  it('excludes children in inaccessible spaces and soft-deleted children', async () => {
    await insertConfluenceChild('child-allowed', 'Child Allowed', 'ALLOWED', 'parent-1');
    await insertConfluenceChild('child-secret', 'Child Secret', 'SECRET', 'parent-1');
    await insertConfluenceChild('child-deleted', 'Child Deleted', 'ALLOWED', 'parent-1', {
      deletedAt: new Date(),
    });

    const result = await fetchSubPages(caller, 'parent-1');

    expect(result.map((p) => p.title)).toEqual(['Child Allowed']);
    expect(mockGetSpaces).toHaveBeenCalledWith(caller);
  });

  it('does not descend into subtrees rooted at an inaccessible page', async () => {
    // Parent -> secret child -> grandchild in an ALLOWED space. Because the
    // secret child is filtered out it is never queued, so its otherwise-
    // readable grandchild must not surface either.
    await insertConfluenceChild('child-secret', 'Child Secret', 'SECRET', 'parent-1');
    await insertConfluenceChild('grandchild-allowed', 'Grandchild Allowed', 'ALLOWED', 'child-secret');

    const result = await fetchSubPages(caller, 'parent-1');

    expect(result).toHaveLength(0);
  });
});
