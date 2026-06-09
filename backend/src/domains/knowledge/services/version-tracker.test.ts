import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../test-db-helper.js';
import { query } from '../../../core/db/postgres.js';
import {
  saveVersionSnapshot,
  saveVersionSnapshotByPageId,
  getVersionHistory,
  getVersion,
  restoreVersion,
} from './version-tracker.js';

const dbAvailable = await isDbAvailable();

const TEST_SPACE = 'VT_SPACE';
const TEST_CONFLUENCE_ID = 'vt-page-1';

describe.skipIf(!dbAvailable)('VersionTracker', () => {
  let pageId: number;

  beforeAll(async () => {
    await setupTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();

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
  });

  describe('saveVersionSnapshot (confluence_id-keyed)', () => {
    it('should save a version snapshot resolved from confluence_id', async () => {
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
  });

  describe('saveVersionSnapshotByPageId', () => {
    it('should save multiple versions for the same page by page_id', async () => {
      await saveVersionSnapshotByPageId(pageId, 1, 'Version 1', '<p>v1</p>', 'v1');
      await saveVersionSnapshotByPageId(pageId, 2, 'Version 2', '<p>v2</p>', 'v2');
      await saveVersionSnapshotByPageId(pageId, 3, 'Version 3', '<p>v3</p>', 'v3');

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
      const versions = await getVersionHistory(pageId);
      expect(versions).toEqual([]);
    });

    it('should return versions in descending order', async () => {
      await saveVersionSnapshotByPageId(pageId, 1, 'V1', null, null);
      await saveVersionSnapshotByPageId(pageId, 2, 'V2', null, null);
      await saveVersionSnapshotByPageId(pageId, 3, 'V3', null, null);

      const versions = await getVersionHistory(pageId);

      expect(versions).toHaveLength(3);
      expect(versions[0].versionNumber).toBe(3);
      expect(versions[1].versionNumber).toBe(2);
      expect(versions[2].versionNumber).toBe(1);
    });

    it('should not include bodyHtml or bodyText in list response', async () => {
      await saveVersionSnapshotByPageId(pageId, 1, 'V1', '<p>body</p>', 'body');

      const versions = await getVersionHistory(pageId);

      expect(versions).toHaveLength(1);
      expect(versions[0]).toHaveProperty('versionNumber');
      expect(versions[0]).toHaveProperty('title');
      expect(versions[0]).toHaveProperty('syncedAt');
      expect(versions[0]).not.toHaveProperty('bodyHtml');
      expect(versions[0]).not.toHaveProperty('bodyText');
    });

    it('should surface history for standalone/local pages (no confluence_id)', async () => {
      const local = await query<{ id: number }>(
        `INSERT INTO pages (title, body_html, body_text, version, source, visibility)
         VALUES ('Local', '<p>x</p>', 'x', 1, 'standalone', 'shared')
         RETURNING id`,
      );
      const localId = local.rows[0].id;
      await saveVersionSnapshotByPageId(localId, 1, 'Local v1', '<p>x</p>', 'x');

      const versions = await getVersionHistory(localId);
      expect(versions).toHaveLength(1);
      expect(versions[0].confluenceId).toBeNull();
    });
  });

  describe('getVersion', () => {
    it('should return null for nonexistent version', async () => {
      const version = await getVersion(pageId, 999);
      expect(version).toBeNull();
    });

    it('should return full version content', async () => {
      await saveVersionSnapshotByPageId(pageId, 1, 'Test Title', '<p>HTML content</p>', 'Plain text');

      const version = await getVersion(pageId, 1);

      expect(version).not.toBeNull();
      expect(version!.versionNumber).toBe(1);
      expect(version!.title).toBe('Test Title');
      expect(version!.bodyHtml).toBe('<p>HTML content</p>');
      expect(version!.bodyText).toBe('Plain text');
      expect(version!.confluenceId).toBe(TEST_CONFLUENCE_ID);
    });

    it('should handle null body fields', async () => {
      await saveVersionSnapshotByPageId(pageId, 1, 'Title Only', null, null);

      const version = await getVersion(pageId, 1);

      expect(version).not.toBeNull();
      expect(version!.bodyHtml).toBeNull();
      expect(version!.bodyText).toBeNull();
    });
  });

  describe('restoreVersion', () => {
    it('returns null when the target version does not exist', async () => {
      const result = await restoreVersion(pageId, 42);
      expect(result).toBeNull();
    });

    it('snapshots the current live state before applying the old version', async () => {
      // Live page is at version 1 ("Test Page"). Seed an older snapshot v0-ish
      // is not possible (v1 is current); simulate prior history: page advanced
      // to v3 with new content, leaving v2 in history to restore.
      await query(
        `UPDATE pages SET version = 3, title = 'Current Title', body_html = '<p>current</p>', body_text = 'current' WHERE id = $1`,
        [pageId],
      );
      await saveVersionSnapshotByPageId(pageId, 2, 'Old Title', '<p>old body</p>', 'old body');

      const result = await restoreVersion(pageId, 2);

      expect(result).not.toBeNull();
      expect(result!.newVersion).toBe(4); // 3 + 1
      expect(result!.title).toBe('Old Title');
      expect(result!.bodyHtml).toBe('<p>old body</p>');

      // 1. The CURRENT live state (v3) is now snapshotted in history.
      const snap = await query<{ title: string; body_html: string }>(
        'SELECT title, body_html FROM page_versions WHERE page_id = $1 AND version_number = 3',
        [pageId],
      );
      expect(snap.rows).toHaveLength(1);
      expect(snap.rows[0].title).toBe('Current Title');

      // 2. The live page now holds the OLD content at the bumped version, and
      //    is marked dirty for re-embedding.
      const live = await query<{ version: number; title: string; body_html: string; body_text: string; embedding_dirty: boolean }>(
        'SELECT version, title, body_html, body_text, embedding_dirty FROM pages WHERE id = $1',
        [pageId],
      );
      expect(live.rows[0].version).toBe(4);
      expect(live.rows[0].title).toBe('Old Title');
      expect(live.rows[0].body_html).toBe('<p>old body</p>');
      expect(live.rows[0].body_text).toBe('old body');
      expect(live.rows[0].embedding_dirty).toBe(true);

      // 3. Older versions remain in history (non-destructive).
      const v2still = await query('SELECT 1 FROM page_versions WHERE page_id = $1 AND version_number = 2', [pageId]);
      expect(v2still.rows).toHaveLength(1);
    });

    it('derives body_text from body_html when the snapshot lacks body_text', async () => {
      await query(`UPDATE pages SET version = 2 WHERE id = $1`, [pageId]);
      await saveVersionSnapshotByPageId(pageId, 1, 'HTML Only', '<p>Hello <strong>world</strong></p>', null);

      const result = await restoreVersion(pageId, 1);

      expect(result).not.toBeNull();
      expect(result!.bodyText).toContain('Hello');
      expect(result!.bodyText).toContain('world');
    });
  });
});
