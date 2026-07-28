/**
 * Migration 086 — seed `pages:relocate` onto the default system roles (#1123).
 *
 * The seed is the ONLY way this permission reaches a role in CE:
 * `permission_definitions` and `GET /api/admin/permissions` are EE-only
 * overlays, so a community admin cannot grant it by hand. That makes the exact
 * set of roles it lands on a correctness property, not a convenience — an
 * over-broad seed hands a destructive cross-system action to viewers.
 *
 * `truncateAllTables()` wipes `roles`, so each test re-seeds the five system
 * roles exactly as migration 039 does and then executes the migration SQL.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../../test-db-helper.js';
import { query } from '../../postgres.js';

const dbAvailable = await isDbAvailable();

const migrationSql = readFileSync(
  fileURLToPath(new URL('../086_seed_pages_relocate_permission.sql', import.meta.url)),
  'utf8',
);

async function seedSystemRoles(): Promise<void> {
  await query(
    `INSERT INTO roles (name, display_name, is_system, permissions) VALUES
       ('system_admin', 'System Administrator', TRUE, ARRAY['read','comment','edit','delete','manage','admin']),
       ('space_admin',  'Space Administrator',  TRUE, ARRAY['read','comment','edit','delete','manage']),
       ('editor',       'Editor',               TRUE, ARRAY['read','comment','edit','delete']),
       ('commenter',    'Commenter',            TRUE, ARRAY['read','comment']),
       ('viewer',       'Viewer',               TRUE, ARRAY['read'])`,
  );
}

async function permissionsOf(role: string): Promise<string[]> {
  const res = await query<{ permissions: string[] }>('SELECT permissions FROM roles WHERE name = $1', [role]);
  return res.rows[0]?.permissions ?? [];
}

describe.skipIf(!dbAvailable)('Migration 086 — seed pages:relocate (#1123)', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => {
    await truncateAllTables();
    await seedSystemRoles();
  });

  it('grants pages:relocate to editor and space_admin', async () => {
    await query(migrationSql);

    expect(await permissionsOf('editor')).toContain('pages:relocate');
    expect(await permissionsOf('space_admin')).toContain('pages:relocate');
  });

  it('does NOT grant it to viewer or commenter', async () => {
    await query(migrationSql);

    expect(await permissionsOf('viewer')).not.toContain('pages:relocate');
    expect(await permissionsOf('commenter')).not.toContain('pages:relocate');
  });

  it('preserves the permissions each role already had', async () => {
    await query(migrationSql);

    // array_cat appends; it must not replace the coarse legacy permissions the
    // rest of the RBAC layer still checks.
    expect(await permissionsOf('editor')).toEqual(
      expect.arrayContaining(['read', 'comment', 'edit', 'delete']),
    );
    expect(await permissionsOf('viewer')).toEqual(['read']);
  });

  it('is idempotent — a second run does not duplicate the entry', async () => {
    await query(migrationSql);
    await query(migrationSql);
    await query(migrationSql);

    const editor = await permissionsOf('editor');
    expect(editor.filter((p) => p === 'pages:relocate')).toHaveLength(1);
  });

  it('leaves a custom role that already holds the permission untouched', async () => {
    await query(
      `INSERT INTO roles (name, display_name, is_system, permissions)
       VALUES ('editor_clone', 'Editor Clone', FALSE, ARRAY['read','pages:relocate'])`,
    );

    await query(migrationSql);

    // Only the two named system roles are targeted; custom roles are never
    // rewritten by the seed.
    expect(await permissionsOf('editor_clone')).toEqual(['read', 'pages:relocate']);
  });

  it('does not fail when a target role is absent', async () => {
    await query("DELETE FROM roles WHERE name = 'space_admin'");

    await expect(query(migrationSql)).resolves.toBeDefined();
    expect(await permissionsOf('editor')).toContain('pages:relocate');
  });
});
