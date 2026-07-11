import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  setupTestDb,
  truncateAllTables,
  teardownTestDb,
  isDbAvailable,
} from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import pgvector from 'pgvector';
import { findDuplicates } from './duplicate-detector.js';

// Deterministic 1024-dim vector. All fixture pages share the same vector so
// every candidate sits at cosine distance 0 from the source — well inside the
// default 0.15 threshold. What separates results is purely the RBAC filter.
function fakeVec(seed: number): number[] {
  return Array.from({ length: 1024 }, (_, i) => Math.sin((i + 1) * seed) * 0.01);
}

const USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; // viewer on TEAMA only
const USER_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'; // owner of a private standalone page
const ADMIN = '99999999-9999-9999-9999-999999999999'; // system admin

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('duplicate-detector integration — RBAC kNN filter (#733)', () => {
  beforeAll(async () => {
    await setupTestDb();
  }, 30_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();
    // Re-seed system roles that migration 039 inserts on fresh install;
    // truncateAllTables wipes them, so restore the ones we reference below.
    await query(
      `INSERT INTO roles (name, display_name, is_system, permissions) VALUES
         ('viewer', 'Viewer', TRUE, ARRAY['read'])
       ON CONFLICT (name) DO NOTHING`,
    );
    await query(
      `INSERT INTO users (id, username, email, role, password_hash) VALUES
         ($1::uuid, 'user-a', 'a@test', 'user', 'x'),
         ($2::uuid, 'user-b', 'b@test', 'user', 'x'),
         ($3::uuid, 'admin', 'admin@test', 'admin', 'x')`,
      [USER_A, USER_B, ADMIN],
    );
    await query(
      `INSERT INTO spaces (space_key, space_name) VALUES ('TEAMA', 'Team A'), ('SECRET', 'Secret')`,
    );
    // USER_A may only read TEAMA
    const role = await query<{ id: number }>(`SELECT id FROM roles WHERE name = 'viewer'`);
    await query(
      `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
       VALUES ('TEAMA', 'user', $1, $2)`,
      [USER_A, role.rows[0]!.id],
    );
  });

  async function seedPage(opts: {
    confluenceId: string | null;
    source: 'confluence' | 'standalone';
    spaceKey: string | null;
    title: string;
    visibility?: string;
    createdBy?: string;
    vec: number[];
  }): Promise<number> {
    const page = await query<{ id: number }>(
      `INSERT INTO pages (confluence_id, source, space_key, title, body_text, body_storage, body_html,
                          visibility, created_by_user_id)
       VALUES ($1, $2, $3, $4, $4, '', '', $5, $6)
       RETURNING id`,
      [opts.confluenceId, opts.source, opts.spaceKey, opts.title,
       opts.visibility ?? 'shared', opts.createdBy ?? null],
    );
    const pageId = page.rows[0]!.id;
    await query(
      `INSERT INTO page_embeddings (page_id, chunk_index, chunk_text, embedding, metadata)
       VALUES ($1, 0, $2, $3, '{}'::jsonb)`,
      [pageId, opts.title, pgvector.toSql(opts.vec)],
    );
    return pageId;
  }

  it('excludes near-duplicates from inaccessible spaces and others-private standalone pages', async () => {
    const vec = fakeVec(7);
    await seedPage({ confluenceId: 'src-1', source: 'confluence', spaceKey: 'TEAMA', title: 'Deploy guide', vec });
    await seedPage({ confluenceId: 'dup-a', source: 'confluence', spaceKey: 'TEAMA', title: 'Deploy guide copy', vec });
    await seedPage({ confluenceId: 'dup-secret', source: 'confluence', spaceKey: 'SECRET', title: 'Secret deploy guide', vec });
    await seedPage({ confluenceId: null, source: 'standalone', spaceKey: null, title: 'Shared note', visibility: 'shared', createdBy: USER_B, vec });
    await seedPage({ confluenceId: null, source: 'standalone', spaceKey: null, title: 'Private note', visibility: 'private', createdBy: USER_B, vec });

    const results = await findDuplicates(USER_A, 'src-1');
    const ids = results.map((r) => r.confluenceId);
    const titles = results.map((r) => r.title);

    // Accessible candidates are returned…
    expect(ids).toContain('dup-a');
    expect(titles).toContain('Shared note');
    // …but nothing from the SECRET space and no foreign private articles.
    expect(ids).not.toContain('dup-secret');
    expect(titles).not.toContain('Secret deploy guide');
    expect(titles).not.toContain('Private note');
  });

  it('surfaces a near-duplicate whose page id sorts after the candidate cap (#866)', async () => {
    // With limit:1 the candidate query over-fetches limit*3 = 3 pages. Seed 3
    // low-id NON-duplicates (opposite vector → cosine distance ~2, far past the
    // 0.15 threshold) first, then the real near-duplicate LAST so it holds the
    // highest id. If candidates are truncated by id instead of by distance, the
    // near-duplicate is dropped before the distance-threshold filter runs and
    // findDuplicates wrongly returns [].
    const vec = fakeVec(7);
    const opposite = vec.map((x) => -x);
    await seedPage({ confluenceId: 'src-1', source: 'confluence', spaceKey: 'TEAMA', title: 'Deploy guide', vec });
    await seedPage({ confluenceId: 'far-1', source: 'confluence', spaceKey: 'TEAMA', title: 'Unrelated one', vec: opposite });
    await seedPage({ confluenceId: 'far-2', source: 'confluence', spaceKey: 'TEAMA', title: 'Unrelated two', vec: opposite });
    await seedPage({ confluenceId: 'far-3', source: 'confluence', spaceKey: 'TEAMA', title: 'Unrelated three', vec: opposite });
    await seedPage({ confluenceId: 'dup-far-id', source: 'confluence', spaceKey: 'TEAMA', title: 'Deploy guide copy', vec });

    const results = await findDuplicates(USER_A, 'src-1', { limit: 1 });

    expect(results.map((r) => r.confluenceId)).toContain('dup-far-id');
    expect(results).not.toEqual([]);
  });

  it('returns [] when the source page itself is in an inaccessible space (no existence oracle)', async () => {
    const vec = fakeVec(11);
    await seedPage({ confluenceId: 'secret-src', source: 'confluence', spaceKey: 'SECRET', title: 'Secret source', vec });
    await seedPage({ confluenceId: 'secret-dup', source: 'confluence', spaceKey: 'SECRET', title: 'Secret source copy', vec });

    const results = await findDuplicates(USER_A, 'secret-src');

    // Identical response to a nonexistent page — no metadata leak.
    expect(results).toEqual([]);
  });

  it('still returns cross-space duplicates for system admins', async () => {
    const vec = fakeVec(13);
    await seedPage({ confluenceId: 'src-1', source: 'confluence', spaceKey: 'TEAMA', title: 'Deploy guide', vec });
    await seedPage({ confluenceId: 'dup-secret', source: 'confluence', spaceKey: 'SECRET', title: 'Secret deploy guide', vec });

    const results = await findDuplicates(ADMIN, 'src-1');

    expect(results.map((r) => r.confluenceId)).toContain('dup-secret');
  });

  it('excludes soft-deleted (trashed) pages from duplicate candidates', async () => {
    const vec = fakeVec(19);
    await seedPage({ confluenceId: 'src-1', source: 'confluence', spaceKey: 'TEAMA', title: 'Deploy guide', vec });
    await seedPage({ confluenceId: 'dup-live', source: 'confluence', spaceKey: 'TEAMA', title: 'Deploy guide copy', vec });
    const trashedId = await seedPage({ confluenceId: 'dup-trashed', source: 'confluence', spaceKey: 'TEAMA', title: 'Deploy guide trashed copy', vec });
    await query(`UPDATE pages SET deleted_at = NOW() WHERE id = $1`, [trashedId]);

    const results = await findDuplicates(USER_A, 'src-1');
    const ids = results.map((r) => r.confluenceId);

    // Live near-duplicates still surface…
    expect(ids).toContain('dup-live');
    // …but trashed pages must never be offered as duplicate candidates.
    expect(ids).not.toContain('dup-trashed');
  });

  it('returns [] when the source page itself is trashed', async () => {
    const vec = fakeVec(23);
    const srcId = await seedPage({ confluenceId: 'src-trashed', source: 'confluence', spaceKey: 'TEAMA', title: 'Deploy guide', vec });
    await seedPage({ confluenceId: 'dup-a', source: 'confluence', spaceKey: 'TEAMA', title: 'Deploy guide copy', vec });
    await query(`UPDATE pages SET deleted_at = NOW() WHERE id = $1`, [srcId]);

    const results = await findDuplicates(USER_A, 'src-trashed');

    // A trashed source behaves like a nonexistent one.
    expect(results).toEqual([]);
  });

  it('includes the caller-owned private standalone pages as candidates', async () => {
    const vec = fakeVec(17);
    await seedPage({ confluenceId: 'src-1', source: 'confluence', spaceKey: 'TEAMA', title: 'Deploy guide', vec });
    await seedPage({ confluenceId: null, source: 'standalone', spaceKey: null, title: 'My private draft', visibility: 'private', createdBy: USER_A, vec });

    const results = await findDuplicates(USER_A, 'src-1');

    expect(results.map((r) => r.title)).toContain('My private draft');
  });

  it('surfaces every accessible standalone near-duplicate, each with a distinct non-null id', async () => {
    // Two accessible standalone near-duplicates both inside the threshold. They
    // both have confluence_id IS NULL, so keying dedup on confluence_id would
    // collapse them into a single row (Postgres treats NULLs as equal in
    // DISTINCT ON). Keying on the page PK keeps both.
    const vec = fakeVec(29);
    await seedPage({ confluenceId: 'src-1', source: 'confluence', spaceKey: 'TEAMA', title: 'Deploy guide', vec });
    const sharedId = await seedPage({
      confluenceId: null, source: 'standalone', spaceKey: null,
      title: 'Standalone deploy notes', visibility: 'shared', createdBy: USER_B, vec,
    });
    const ownPrivateId = await seedPage({
      confluenceId: null, source: 'standalone', spaceKey: null,
      title: 'My private deploy draft', visibility: 'private', createdBy: USER_A, vec,
    });

    const results = await findDuplicates(USER_A, 'src-1');
    const standalone = results.filter((r) => r.confluenceId === null);

    // Both standalone duplicates surface — not collapsed into one.
    expect(standalone).toHaveLength(2);
    expect(standalone.map((r) => r.title).sort()).toEqual([
      'My private deploy draft',
      'Standalone deploy notes',
    ]);
    // Every candidate carries a stable, non-null id usable as a nav target.
    expect(results.every((r) => typeof r.id === 'number' && Number.isInteger(r.id))).toBe(true);
    const ids = standalone.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length); // distinct
    expect(ids).toContain(sharedId);
    expect(ids).toContain(ownPrivateId);
  });
});
