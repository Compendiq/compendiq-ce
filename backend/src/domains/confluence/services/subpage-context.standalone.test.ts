/**
 * Sub-page context standalone/local-space descent against a REAL PostgreSQL.
 *
 * Regression (#886): `fetchSubPages` queued the child's `confluence_id` for the
 * next BFS level. Standalone (local-space) pages have `confluence_id = NULL` and
 * are keyed on `parent_id = <parent DB id as text>` (see pages-crud.ts:1090 /
 * :952 `COALESCE(confluence_id, id::text)`). Queuing NULL made the next
 * iteration run `WHERE parent_id = NULL` (matches nothing), so any standalone
 * descendant below depth 1 was silently dropped from the LLM context. The fix
 * queues `row.confluence_id ?? String(row.id)`, mirroring the recursive-CTE
 * keying used by the page-tree endpoint.
 *
 * The resolver (`getUserAccessibleSpacesMemoized`) is mocked at the boundary;
 * standalone+shared pages are visible regardless of accessible spaces, so it
 * can return [].
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

async function insertStandalone(
  title: string,
  parentId: string | null,
  createdBy: string,
): Promise<number> {
  const res = await query<{ id: number }>(
    `INSERT INTO pages (title, source, visibility, space_key, confluence_id, parent_id,
                        body_text, body_storage, body_html, embedding_dirty, created_by_user_id)
     VALUES ($1, 'standalone', 'shared', NULL, NULL, $2, 'text', '', '<p>x</p>', FALSE, $3)
     RETURNING id`,
    [title, parentId, createdBy],
  );
  return res.rows[0]!.id;
}

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('fetchSubPages — standalone/local-space descent (DB)', () => {
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
    caller = await insertUser('subpage_standalone_caller');
    // Accessible spaces are irrelevant: standalone+shared pages are always visible.
    mockGetSpaces.mockResolvedValue([]);
  });

  it('descends a standalone tree keyed by DB id past depth 1', async () => {
    // handbook -> policies -> vacation, all local-space (confluence_id NULL).
    const handbook = await insertStandalone('Handbook', null, caller);
    const policies = await insertStandalone('Policies', String(handbook), caller);
    await insertStandalone('Vacation Policy', String(policies), caller);

    const result = await fetchSubPages(caller, String(handbook));

    expect(result.map((p) => p.title)).toEqual(['Policies', 'Vacation Policy']);
  });
});
