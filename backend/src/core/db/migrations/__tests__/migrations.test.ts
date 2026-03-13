import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, truncateAllTables, teardownTestDb, isDbAvailable } from '../../../../test-db-helper.js';
import { query } from '../../postgres.js';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('Database migrations', () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  it('should run all migrations on a fresh DB', async () => {
    const result = await query<{ name: string }>(
      'SELECT name FROM _migrations ORDER BY name',
    );
    // At minimum we have 001-008 plus 011-013 (009/010 may exist from another agent)
    expect(result.rows.length).toBeGreaterThanOrEqual(11);

    const names = result.rows.map((r) => r.name);
    // Verify core migrations are present
    expect(names).toContain('001_extensions.sql');
    expect(names).toContain('002_users.sql');
    expect(names).toContain('003_user_settings.sql');
    expect(names).toContain('004_cached_spaces.sql');
    expect(names).toContain('005_cached_pages.sql');
    expect(names).toContain('006_page_embeddings.sql');
    expect(names).toContain('007_llm_conversations.sql');
    expect(names).toContain('008_llm_improvements.sql');
    expect(names).toContain('011_hnsw_tuning.sql');
    expect(names).toContain('012_error_log.sql');
    expect(names).toContain('013_search_analytics.sql');
    expect(names).toContain('014_page_versions.sql');
    expect(names).toContain('021_add_performance_indexes.sql');
  });

  describe('performance indexes (migration 021, updated by 023)', () => {
    it('should have idx_cached_pages_dirty_modified composite index', async () => {
      const result = await query<{ indexname: string; indexdef: string }>(
        `SELECT indexname, indexdef FROM pg_indexes
         WHERE tablename = 'cached_pages'
         AND indexname = 'idx_cached_pages_dirty_modified'`,
      );
      expect(result.rows).toHaveLength(1);
      // After migration 023 (shared tables), user_id was dropped from cached_pages
      expect(result.rows[0].indexdef).toContain('embedding_dirty');
      expect(result.rows[0].indexdef).toContain('last_modified_at');
    });

    it('should have idx_cached_pages_space_modified composite index', async () => {
      const result = await query<{ indexname: string; indexdef: string }>(
        `SELECT indexname, indexdef FROM pg_indexes
         WHERE tablename = 'cached_pages'
         AND indexname = 'idx_cached_pages_space_modified'`,
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].indexdef).toContain('space_key');
      expect(result.rows[0].indexdef).toContain('last_modified_at');
    });
  });

  describe('required tables exist', () => {
    const expectedTables = [
      'users',
      'user_settings',
      'cached_spaces',
      'cached_pages',
      'page_embeddings',
      'llm_conversations',
      'llm_improvements',
      'refresh_tokens',
      'audit_log',
      'error_log',
      'search_analytics',
      'page_versions',
    ];

    it.each(expectedTables)('should have table: %s', async (tableName) => {
      const result = await query<{ exists: boolean }>(
        `SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = $1
        ) AS exists`,
        [tableName],
      );
      expect(result.rows[0].exists).toBe(true);
    });
  });

  describe('users table schema', () => {
    it('should have role column', async () => {
      const result = await query<{ column_name: string; data_type: string; column_default: string }>(
        `SELECT column_name, data_type, column_default
         FROM information_schema.columns
         WHERE table_name = 'users' AND column_name = 'role'`,
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].column_name).toBe('role');
      expect(result.rows[0].data_type).toBe('text');
      expect(result.rows[0].column_default).toContain("'user'");
    });

    it('should have all required columns', async () => {
      const result = await query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'users' ORDER BY ordinal_position`,
      );
      const columns = result.rows.map((r) => r.column_name);
      expect(columns).toContain('id');
      expect(columns).toContain('username');
      expect(columns).toContain('password_hash');
      expect(columns).toContain('role');
      expect(columns).toContain('created_at');
      expect(columns).toContain('updated_at');
    });

    it('should default role to user when inserting without explicit role', async () => {
      await truncateAllTables();

      await query(
        "INSERT INTO users (username, password_hash) VALUES ('defaultrole_user', 'hash')",
      );

      const result = await query<{ role: string }>(
        "SELECT role FROM users WHERE username = 'defaultrole_user'",
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].role).toBe('user');

      await truncateAllTables();
    });
  });

  describe('user_settings table schema', () => {
    it('should have all required columns', async () => {
      const result = await query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'user_settings' ORDER BY ordinal_position`,
      );
      const columns = result.rows.map((r) => r.column_name);
      expect(columns).toContain('user_id');
      expect(columns).toContain('confluence_url');
      expect(columns).toContain('confluence_pat');
      // selected_spaces was migrated to user_space_selections table in migration 023
      expect(columns).toContain('ollama_model');
      expect(columns).toContain('theme');
      expect(columns).toContain('sync_interval_min');
    });
  });

  describe('cached_pages table schema', () => {
    it('should have embedding_dirty column', async () => {
      const result = await query<{ column_name: string; column_default: string }>(
        `SELECT column_name, column_default
         FROM information_schema.columns
         WHERE table_name = 'cached_pages' AND column_name = 'embedding_dirty'`,
      );
      expect(result.rows).toHaveLength(1);
    });

    it('should have all required columns', async () => {
      const result = await query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'cached_pages' ORDER BY ordinal_position`,
      );
      const columns = result.rows.map((r) => r.column_name);
      expect(columns).toContain('confluence_id');
      expect(columns).toContain('space_key');
      expect(columns).toContain('title');
      expect(columns).toContain('body_storage');
      expect(columns).toContain('body_html');
      expect(columns).toContain('body_text');
      expect(columns).toContain('version');
      expect(columns).toContain('labels');
    });
  });

  describe('page_embeddings table schema', () => {
    it('should have vector(768) embedding column', async () => {
      const result = await query<{ column_name: string; udt_name: string }>(
        `SELECT column_name, udt_name
         FROM information_schema.columns
         WHERE table_name = 'page_embeddings' AND column_name = 'embedding'`,
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].udt_name).toBe('vector');
    });

    it('should have HNSW index on embedding', async () => {
      const result = await query<{ indexname: string; indexdef: string }>(
        `SELECT indexname, indexdef FROM pg_indexes
         WHERE tablename = 'page_embeddings'
         AND indexdef LIKE '%hnsw%'`,
      );
      expect(result.rows.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('llm_conversations table schema', () => {
    it('should have messages JSONB column', async () => {
      const result = await query<{ column_name: string; data_type: string }>(
        `SELECT column_name, data_type
         FROM information_schema.columns
         WHERE table_name = 'llm_conversations' AND column_name = 'messages'`,
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].data_type).toBe('jsonb');
    });
  });

  describe('extensions', () => {
    it('should have pgvector extension', async () => {
      const result = await query<{ extname: string }>(
        "SELECT extname FROM pg_extension WHERE extname = 'vector'",
      );
      expect(result.rows).toHaveLength(1);
    });

    it('should have pg_trgm extension', async () => {
      const result = await query<{ extname: string }>(
        "SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'",
      );
      expect(result.rows).toHaveLength(1);
    });
  });
});
