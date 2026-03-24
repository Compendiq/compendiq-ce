import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import { saveVersionSnapshot, getVersionHistory, getVersion } from './version-tracker.js';

const dbAvailable = await isDbAvailable();

const TEST_SPACE = 'VT_SPACE';
const TEST_CONFLUENCE_ID = 'vt-page-1';

describe.skipIf(!dbAvailable)('VersionTracker', () => {
  let userId: string;
  let pageId: number;

  beforeAll(async () => {
    await setupTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();

    // Create a test user
    const userResult = await query<{ id: string }>(
      "INSERT INTO users (username, password_hash) VALUES ('version_test_user', 'hash') RETURNING id",
    );
    userId = userResult.rows[0].id;

    // Create the space
    await query(
      "INSERT INTO spaces (space_key, space_name) VALUES ($1, 'Version Test Space')",
      [TEST_SPACE],
    );

    // Create a page in the pages table (required FK for page_versions)
    const pageResult = await query<{ id: number }>(
      `INSERT INTO pages (confluence_id, space_key, title, body_html, body_text, version)
       VALUES ($1, $2, 'Test Page', '<p>Hello</p>', 'Hello', 1)
       RETURNING id`,
      [TEST_CONFLUENCE_ID, TEST_SPACE],
    );
    pageId = pageResult.rows[0].id;

    // Ensure roles are seeded (migrations do this, but guard for truncation)
    await query(
      `INSERT INTO roles (name, display_name, is_system, permissions)
       VALUES ('editor', 'Editor', TRUE, ARRAY['read','comment','edit','delete'])
       ON CONFLICT (name) DO NOTHING`,
    );

    // Grant RBAC access for the test user to the test space
    const editorRole = await query<{ id: number }>("SELECT id FROM roles WHERE name = 'editor' LIMIT 1");
    const roleId = editorRole.rows[0].id;
    await query(
      `INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
       VALUES ($1, 'user', $2, $3) ON CONFLICT DO NOTHING`,
      [TEST_SPACE, userId, roleId],
    );
  });

  describe('saveVersionSnapshot', () => {
    it('should save a version snapshot', async () => {
      await saveVersionSnapshot(TEST_CONFLUENCE_ID, 1, 'Test Page', '<p>Hello</p>', 'Hello');

      const result = await query<{ version_number: number; title: string }>(
        'SELECT version_number, title FROM page_versions WHERE page_id = $1',
        [pageId],
      );

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].version_number).toBe(1);
      expect(result.rows[0].title).toBe('Test Page');
    });

    it('should not fail on duplicate version (ON CONFLICT DO NOTHING)', async () => {
      await saveVersionSnapshot(TEST_CONFLUENCE_ID, 1, 'Test Page v1', '<p>Hello</p>', 'Hello');
      // Saving the same version again should not throw
      await saveVersionSnapshot(TEST_CONFLUENCE_ID, 1, 'Test Page v1 Updated', '<p>Updated</p>', 'Updated');

      const result = await query<{ title: string }>(
        'SELECT title FROM page_versions WHERE page_id = $1 AND version_number = $2',
        [pageId, 1],
      );

      // Should keep the original (DO NOTHING)
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].title).toBe('Test Page v1');
    });

    it('should save multiple versions for the same page', async () => {
      await saveVersionSnapshot(TEST_CONFLUENCE_ID, 1, 'Version 1', '<p>v1</p>', 'v1');
      await saveVersionSnapshot(TEST_CONFLUENCE_ID, 2, 'Version 2', '<p>v2</p>', 'v2');
      await saveVersionSnapshot(TEST_CONFLUENCE_ID, 3, 'Version 3', '<p>v3</p>', 'v3');

      const result = await query<{ version_number: number }>(
        'SELECT version_number FROM page_versions WHERE page_id = $1 ORDER BY version_number',
        [pageId],
      );

      expect(result.rows).toHaveLength(3);
      expect(result.rows.map((r) => r.version_number)).toEqual([1, 2, 3]);
    });
  });

  describe('getVersionHistory', () => {
    it('should return empty array for page with no versions', async () => {
      const versions = await getVersionHistory(userId, 'nonexistent');
      expect(versions).toEqual([]);
    });

    it('should return versions in descending order', async () => {
      await saveVersionSnapshot(TEST_CONFLUENCE_ID, 1, 'V1', null, null);
      await saveVersionSnapshot(TEST_CONFLUENCE_ID, 2, 'V2', null, null);
      await saveVersionSnapshot(TEST_CONFLUENCE_ID, 3, 'V3', null, null);

      const versions = await getVersionHistory(userId, TEST_CONFLUENCE_ID);

      expect(versions).toHaveLength(3);
      expect(versions[0].versionNumber).toBe(3);
      expect(versions[1].versionNumber).toBe(2);
      expect(versions[2].versionNumber).toBe(1);
    });

    it('should not include bodyHtml or bodyText in list response', async () => {
      await saveVersionSnapshot(TEST_CONFLUENCE_ID, 1, 'V1', '<p>body</p>', 'body');

      const versions = await getVersionHistory(userId, TEST_CONFLUENCE_ID);

      expect(versions).toHaveLength(1);
      expect(versions[0]).toHaveProperty('versionNumber');
      expect(versions[0]).toHaveProperty('title');
      expect(versions[0]).toHaveProperty('syncedAt');
      expect(versions[0]).not.toHaveProperty('bodyHtml');
      expect(versions[0]).not.toHaveProperty('bodyText');
    });
  });

  describe('getVersion', () => {
    it('should return null for nonexistent version', async () => {
      const version = await getVersion(userId, TEST_CONFLUENCE_ID, 999);
      expect(version).toBeNull();
    });

    it('should return full version content', async () => {
      await saveVersionSnapshot(TEST_CONFLUENCE_ID, 1, 'Test Title', '<p>HTML content</p>', 'Plain text');

      const version = await getVersion(userId, TEST_CONFLUENCE_ID, 1);

      expect(version).not.toBeNull();
      expect(version!.versionNumber).toBe(1);
      expect(version!.title).toBe('Test Title');
      expect(version!.bodyHtml).toBe('<p>HTML content</p>');
      expect(version!.bodyText).toBe('Plain text');
      expect(version!.confluenceId).toBe(TEST_CONFLUENCE_ID);
    });

    it('should handle null body fields', async () => {
      await saveVersionSnapshot(TEST_CONFLUENCE_ID, 1, 'Title Only', null, null);

      const version = await getVersion(userId, TEST_CONFLUENCE_ID, 1);

      expect(version).not.toBeNull();
      expect(version!.bodyHtml).toBeNull();
      expect(version!.bodyText).toBeNull();
    });
  });
});
