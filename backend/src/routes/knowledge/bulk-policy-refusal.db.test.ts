import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query } from '../../core/db/postgres.js';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../test-db-helper.js';
import { publishBulkPolicyLabels } from './bulk-policy-labels.js';

const available = await isDbAvailable();
describe.skipIf(!available)('bulk policy label refusal contract', () => {
  beforeAll(async () => { await setupTestDb(); });
  beforeEach(async () => { await truncateAllTables(); });
  afterAll(async () => { await teardownTestDb(); });
  it('refuses a visible read-only Confluence target before changing any selected labels', async () => {
    const user = (await query(`INSERT INTO users (username, email, password_hash, display_name)
      VALUES ('reader', 'reader@example.test', 'unused', 'Reader') RETURNING id`)).rows[0];
    await query("INSERT INTO spaces (space_key, space_name) VALUES ('READONLY', 'Read only')");
    const pages = await query(`INSERT INTO pages (title, source, confluence_id, visibility, labels, space_key)
      VALUES ('First', 'standalone', NULL, 'shared', ARRAY['all-ai'], NULL),
             ('Second', 'confluence', 'remote-second', 'shared', ARRAY['all-ai'], 'READONLY')
      RETURNING id, source, confluence_id, labels, content_revision::text, lifecycle_revision::text`);
    await query('UPDATE pages SET inherit_perms = FALSE WHERE id = $1', [pages.rows[1].id]);
    await query("INSERT INTO access_control_entries (resource_type, resource_id, principal_type, principal_id, permission) VALUES ('page', $1, 'user', $2, 'read')", [pages.rows[1].id, user.id]);
    await expect(publishBulkPolicyLabels(user.id, pages.rows.map((row) => ({
      id: row.id, source: row.source, confluenceId: row.confluence_id, labels: row.labels,
      contentRevision: row.content_revision, lifecycleRevision: row.lifecycle_revision,
    })), () => ['no-ai'], 'pages.bulk.tags')).rejects.toMatchObject({
      statusCode: 403, body: { error: 'ai_policy_denied', pageIds: [pages.rows[1].id] },
    });
    const after = await query('SELECT ai_policy, labels FROM pages ORDER BY id');
    expect(after.rows).toEqual([{ ai_policy: 'all', labels: ['all-ai'] }, { ai_policy: 'all', labels: ['all-ai'] }]);
  });
});
