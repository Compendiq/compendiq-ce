import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../test-db-helper.js';
import { query } from '../../core/db/postgres.js';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('Templates (DB)', () => {
  let userId: string;
  let adminUserId: string;

  beforeAll(async () => {
    await setupTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await truncateAllTables();

    // Create sentinel system user for built-in templates
    await query(
      "INSERT INTO users (id, username, password_hash, role) VALUES ('00000000-0000-0000-0000-000000000000', '__system__', 'nologin', 'admin')",
    );

    // Create a regular test user
    const userResult = await query<{ id: string }>(
      "INSERT INTO users (username, password_hash) VALUES ('tpl_user', 'hash') RETURNING id",
    );
    userId = userResult.rows[0].id;

    // Create an admin test user
    const adminResult = await query<{ id: string }>(
      "INSERT INTO users (username, password_hash, role) VALUES ('tpl_admin', 'hash', 'admin') RETURNING id",
    );
    adminUserId = adminResult.rows[0].id;
  });

  it('should create templates table via migration', async () => {
    const result = await query<{ exists: boolean }>(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'templates'
      ) AS exists`,
    );
    expect(result.rows[0].exists).toBe(true);
  });

  it('should have correct columns', async () => {
    const result = await query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'templates'
       ORDER BY ordinal_position`,
    );
    const cols = result.rows.map((r) => r.column_name);
    expect(cols).toContain('id');
    expect(cols).toContain('title');
    expect(cols).toContain('description');
    expect(cols).toContain('category');
    expect(cols).toContain('icon');
    expect(cols).toContain('body_json');
    expect(cols).toContain('body_html');
    expect(cols).toContain('variables');
    expect(cols).toContain('created_by');
    expect(cols).toContain('is_global');
    expect(cols).toContain('space_key');
    expect(cols).toContain('use_count');
    expect(cols).toContain('created_at');
    expect(cols).toContain('updated_at');
  });

  it('should insert and retrieve a user template', async () => {
    await query(
      `INSERT INTO templates (title, description, category, icon, body_json, body_html, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      ['My Template', 'A test template', 'docs', '📄',
       '{"type":"doc","content":[]}', '<p>empty</p>', userId],
    );

    const result = await query<{
      title: string;
      description: string;
      category: string;
      is_global: boolean;
      use_count: number;
      created_by: string;
    }>(
      'SELECT title, description, category, is_global, use_count, created_by FROM templates WHERE created_by = $1',
      [userId],
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].title).toBe('My Template');
    expect(result.rows[0].description).toBe('A test template');
    expect(result.rows[0].category).toBe('docs');
    expect(result.rows[0].is_global).toBe(false);
    expect(result.rows[0].use_count).toBe(0);
  });

  it('should insert global templates with sentinel user', async () => {
    await query(
      `INSERT INTO templates (title, body_json, body_html, created_by, is_global)
       VALUES ($1, $2, $3, $4, $5)`,
      ['Global Template', '{"type":"doc","content":[]}', '<p>global</p>',
       '00000000-0000-0000-0000-000000000000', true],
    );

    const result = await query<{ title: string; is_global: boolean }>(
      'SELECT title, is_global FROM templates WHERE is_global = TRUE',
    );

    expect(result.rows.length).toBeGreaterThanOrEqual(1);
    const tpl = result.rows.find((r) => r.title === 'Global Template');
    expect(tpl).toBeDefined();
    expect(tpl!.is_global).toBe(true);
  });

  it('should enforce FK constraint on created_by', async () => {
    await expect(
      query(
        `INSERT INTO templates (title, body_json, body_html, created_by)
         VALUES ($1, $2, $3, $4)`,
        ['Bad Template', '{}', '<p></p>', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'],
      ),
    ).rejects.toThrow();
  });

  it('should increment use_count', async () => {
    const ins = await query<{ id: number }>(
      `INSERT INTO templates (title, body_json, body_html, created_by)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      ['Counter Template', '{}', '<p></p>', userId],
    );
    const templateId = ins.rows[0].id;

    await query('UPDATE templates SET use_count = use_count + 1 WHERE id = $1', [templateId]);
    await query('UPDATE templates SET use_count = use_count + 1 WHERE id = $1', [templateId]);

    const result = await query<{ use_count: number }>(
      'SELECT use_count FROM templates WHERE id = $1',
      [templateId],
    );
    expect(result.rows[0].use_count).toBe(2);
  });

  it('should support JSONB variables column', async () => {
    const variables = [
      { name: 'projectName', placeholder: '{{projectName}}', description: 'Project name' },
    ];

    await query(
      `INSERT INTO templates (title, body_json, body_html, created_by, variables)
       VALUES ($1, $2, $3, $4, $5)`,
      ['Var Template', '{}', '<p></p>', userId, JSON.stringify(variables)],
    );

    const result = await query<{ variables: unknown }>(
      'SELECT variables FROM templates WHERE title = $1',
      ['Var Template'],
    );

    expect(result.rows[0].variables).toEqual(variables);
  });

  it('should delete template and not cascade to unrelated data', async () => {
    const ins = await query<{ id: number }>(
      `INSERT INTO templates (title, body_json, body_html, created_by)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      ['Delete Me', '{}', '<p></p>', userId],
    );

    await query('DELETE FROM templates WHERE id = $1', [ins.rows[0].id]);

    const result = await query<{ count: string }>(
      'SELECT COUNT(*) as count FROM templates WHERE id = $1',
      [ins.rows[0].id],
    );
    expect(parseInt(result.rows[0].count, 10)).toBe(0);
  });

  it('should list only global and own templates for a user', async () => {
    // Insert a global template
    await query(
      `INSERT INTO templates (title, body_json, body_html, created_by, is_global)
       VALUES ($1, $2, $3, $4, $5)`,
      ['Global One', '{}', '<p></p>', '00000000-0000-0000-0000-000000000000', true],
    );

    // Insert own template
    await query(
      `INSERT INTO templates (title, body_json, body_html, created_by)
       VALUES ($1, $2, $3, $4)`,
      ['My Own', '{}', '<p></p>', userId],
    );

    // Insert another user's private template (should not be visible)
    await query(
      `INSERT INTO templates (title, body_json, body_html, created_by)
       VALUES ($1, $2, $3, $4)`,
      ['Other Private', '{}', '<p></p>', adminUserId],
    );

    // Query for userId's visible templates
    const result = await query<{ title: string }>(
      'SELECT title FROM templates WHERE is_global = TRUE OR created_by = $1 ORDER BY title',
      [userId],
    );

    const titles = result.rows.map((r) => r.title);
    expect(titles).toContain('Global One');
    expect(titles).toContain('My Own');
    expect(titles).not.toContain('Other Private');
  });

  it('should filter by category', async () => {
    await query(
      `INSERT INTO templates (title, body_json, body_html, created_by, category)
       VALUES ($1, $2, $3, $4, $5)`,
      ['Eng Template', '{}', '<p></p>', userId, 'engineering'],
    );
    await query(
      `INSERT INTO templates (title, body_json, body_html, created_by, category)
       VALUES ($1, $2, $3, $4, $5)`,
      ['Ops Template', '{}', '<p></p>', userId, 'operations'],
    );

    const result = await query<{ title: string }>(
      'SELECT title FROM templates WHERE created_by = $1 AND category = $2',
      [userId, 'engineering'],
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].title).toBe('Eng Template');
  });
});
