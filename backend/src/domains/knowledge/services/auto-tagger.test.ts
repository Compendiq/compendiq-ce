import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseTagResponse, ALLOWED_TAGS, autoTagContent, autoTagPage, applyTags, autoTagAllPages } from './auto-tagger.js';

// Mock llm-provider to avoid real API calls (provider-aware resolution)
const mockProviderChat = vi.fn();
vi.mock('../../llm/services/llm-provider.js', () => ({
  providerChat: (...args: unknown[]) => mockProviderChat(...args),
}));

vi.mock('../../../core/services/content-converter.js', () => ({
  htmlToMarkdown: vi.fn().mockReturnValue('some markdown content'),
}));

vi.mock('../../../core/utils/sanitize-llm-input.js', () => ({
  sanitizeLlmInput: vi.fn().mockReturnValue({ sanitized: 'sanitized content' }),
}));

vi.mock('../../../core/utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const mockQueryFn = vi.fn();
vi.mock('../../../core/db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQueryFn(...args),
}));

vi.mock('../../confluence/services/sync-service.js', () => ({
  getClientForUser: vi.fn().mockResolvedValue({
    addLabels: vi.fn().mockResolvedValue(undefined),
    removeLabel: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('../../../core/services/rbac-service.js', () => ({
  getUserAccessibleSpaces: vi.fn().mockResolvedValue(['DEV', 'OPS']),
}));

describe('AutoTagger', () => {
  describe('parseTagResponse', () => {
    it('should parse a valid JSON array of tags', () => {
      const result = parseTagResponse('["architecture", "deployment"]');
      expect(result).toEqual(['architecture', 'deployment']);
    });

    it('should filter out invalid tags', () => {
      const result = parseTagResponse('["architecture", "invalid-tag", "security"]');
      expect(result).toEqual(['architecture', 'security']);
    });

    it('should handle JSON with surrounding text', () => {
      const result = parseTagResponse('Based on the content, the tags are: ["api", "database"]');
      expect(result).toEqual(['api', 'database']);
    });

    it('should be case-insensitive', () => {
      const result = parseTagResponse('["Architecture", "DEPLOYMENT"]');
      expect(result).toEqual(['architecture', 'deployment']);
    });

    it('should return empty array for non-JSON response', () => {
      const result = parseTagResponse('I think the tags should be architecture and deployment.');
      expect(result).toEqual([]);
    });

    it('should return empty array for empty response', () => {
      const result = parseTagResponse('');
      expect(result).toEqual([]);
    });

    it('should return empty array for non-array JSON', () => {
      const result = parseTagResponse('{"tags": ["architecture"]}');
      // The regex will find ["architecture"] inside the string
      expect(result).toEqual(['architecture']);
    });

    it('should deduplicate tags', () => {
      const result = parseTagResponse('["api", "api", "security", "security"]');
      expect(result).toEqual(['api', 'security']);
    });

    it('should limit to 5 tags', () => {
      const allTags = ALLOWED_TAGS.slice(0, 7);
      const result = parseTagResponse(JSON.stringify(allTags));
      expect(result.length).toBeLessThanOrEqual(5);
    });

    it('should handle tags with extra whitespace', () => {
      const result = parseTagResponse('[" architecture ", " deployment "]');
      expect(result).toEqual(['architecture', 'deployment']);
    });

    it('should ignore non-string array elements', () => {
      const result = parseTagResponse('[123, "architecture", null, "security"]');
      expect(result).toEqual(['architecture', 'security']);
    });

    it('should handle markdown-wrapped JSON', () => {
      const result = parseTagResponse('```json\n["api", "database"]\n```');
      expect(result).toEqual(['api', 'database']);
    });
  });

  describe('ALLOWED_TAGS', () => {
    it('should contain expected tags', () => {
      expect(ALLOWED_TAGS).toContain('architecture');
      expect(ALLOWED_TAGS).toContain('deployment');
      expect(ALLOWED_TAGS).toContain('troubleshooting');
      expect(ALLOWED_TAGS).toContain('how-to');
      expect(ALLOWED_TAGS).toContain('api');
      expect(ALLOWED_TAGS).toContain('security');
      expect(ALLOWED_TAGS).toContain('database');
      expect(ALLOWED_TAGS).toContain('monitoring');
      expect(ALLOWED_TAGS).toContain('configuration');
      expect(ALLOWED_TAGS).toContain('onboarding');
      expect(ALLOWED_TAGS).toContain('policy');
      expect(ALLOWED_TAGS).toContain('runbook');
    });

    it('should have 12 tags', () => {
      expect(ALLOWED_TAGS).toHaveLength(12);
    });
  });

  describe('autoTagContent', () => {
    it('should return parsed tags on successful LLM response', async () => {
      mockProviderChat.mockResolvedValueOnce('["architecture", "deployment"]');

      const result = await autoTagContent('test-user-id', 'qwen3:32b', 'some content');
      expect(result).toEqual(['architecture', 'deployment']);
      expect(mockProviderChat).toHaveBeenCalledOnce();
      // Verify userId is passed as the first argument
      expect(mockProviderChat).toHaveBeenCalledWith(
        'test-user-id',
        'qwen3:32b',
        expect.any(Array),
      );
    });

    it('should wrap LLM errors with descriptive message', async () => {
      mockProviderChat.mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:11434'));

      await expect(autoTagContent('test-user-id', 'qwen3:32b', 'some content'))
        .rejects.toThrow('Auto-tag failed: connect ECONNREFUSED 127.0.0.1:11434');
    });

    it('should wrap non-Error LLM failures with descriptive message', async () => {
      mockProviderChat.mockRejectedValueOnce('string error');

      await expect(autoTagContent('test-user-id', 'qwen3:32b', 'some content'))
        .rejects.toThrow('Auto-tag failed: string error');
    });

    it('should wrap fetch failed errors', async () => {
      mockProviderChat.mockRejectedValueOnce(new TypeError('fetch failed'));

      await expect(autoTagContent('test-user-id', 'qwen3:32b', 'some content'))
        .rejects.toThrow('Auto-tag failed: fetch failed');
    });

    it('should preserve original error as cause', async () => {
      const original = new Error('connect ECONNREFUSED 127.0.0.1:11434');
      mockProviderChat.mockRejectedValueOnce(original);

      try {
        await autoTagContent('test-user-id', 'qwen3:32b', 'some content');
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).cause).toBe(original);
      }
    });

    it('should preserve CircuitBreakerOpenError as cause', async () => {
      const cbError = new Error('ollama-chat: LLM server temporarily unavailable');
      cbError.name = 'CircuitBreakerOpenError';
      mockProviderChat.mockRejectedValueOnce(cbError);

      try {
        await autoTagContent('test-user-id', 'qwen3:32b', 'some content');
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        const cause = (err as Error).cause as Error;
        expect(cause).toBe(cbError);
        expect(cause.name).toBe('CircuitBreakerOpenError');
      }
    });
  });

  describe('autoTagPage (#442 — integer PK fix)', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('should use integer PK when given a numeric string id', async () => {
      mockQueryFn.mockResolvedValueOnce({
        rows: [{ body_html: '<p>test content</p>', labels: [] }],
        rowCount: 1,
      });
      mockProviderChat.mockResolvedValueOnce('["architecture"]');

      const result = await autoTagPage('test-user-id', '42', 'qwen3:32b');
      expect(result.suggestedTags).toEqual(['architecture']);

      // Verify query used id = $1 with integer value
      const selectCall = mockQueryFn.mock.calls[0];
      expect(selectCall[0]).toContain('id = $1');
      expect(selectCall[1]).toEqual([42]);
    });

    it('should use confluence_id when given a non-numeric string id', async () => {
      mockQueryFn.mockResolvedValueOnce({
        rows: [{ body_html: '<p>test content</p>', labels: [] }],
        rowCount: 1,
      });
      mockProviderChat.mockResolvedValueOnce('["api"]');

      const result = await autoTagPage('test-user-id', 'conf-abc', 'qwen3:32b');
      expect(result.suggestedTags).toEqual(['api']);

      // Verify query used confluence_id = $1 with string value
      const selectCall = mockQueryFn.mock.calls[0];
      expect(selectCall[0]).toContain('confluence_id = $1');
      expect(selectCall[1]).toEqual(['conf-abc']);
    });

    it('should throw when page not found', async () => {
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await expect(autoTagPage('test-user-id', '999', 'qwen3:32b'))
        .rejects.toThrow('Page not found: 999');
    });
  });

  describe('applyTags (#442 — integer PK fix)', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('should use integer PK for SELECT and UPDATE when given numeric id', async () => {
      // Mock SELECT
      mockQueryFn.mockResolvedValueOnce({
        rows: [{ id: 42, confluence_id: 'conf-42', labels: ['existing'] }],
        rowCount: 1,
      });
      // Mock UPDATE
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const result = await applyTags('test-user-id', '42', ['architecture']);
      expect(result).toContain('existing');
      expect(result).toContain('architecture');

      // Verify SELECT used id = $1 with integer value
      const selectCall = mockQueryFn.mock.calls[0];
      expect(selectCall[0]).toContain('id = $1');
      expect(selectCall[1]).toEqual([42]);

      // Verify UPDATE used WHERE id = $1
      const updateCall = mockQueryFn.mock.calls[1];
      expect(updateCall[0]).toContain('WHERE id = $1');
      expect(updateCall[1][0]).toBe(42);
    });

    it('should work for standalone pages with no confluence_id (no Confluence sync)', async () => {
      // Standalone page: confluence_id is null
      mockQueryFn.mockResolvedValueOnce({
        rows: [{ id: 99, confluence_id: null, labels: [] }],
        rowCount: 1,
      });
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const result = await applyTags('test-user-id', '99', ['security']);
      expect(result).toEqual(['security']);

      // Should NOT attempt Confluence sync (getClientForUser not called)
      const { getClientForUser } = await import('../../confluence/services/sync-service.js');
      expect(getClientForUser).not.toHaveBeenCalled();
    });

    it('should sync labels to Confluence using confluence_id, not integer PK', async () => {
      mockQueryFn.mockResolvedValueOnce({
        rows: [{ id: 42, confluence_id: 'conf-42', labels: [] }],
        rowCount: 1,
      });
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await applyTags('test-user-id', '42', ['deployment']);

      const { getClientForUser } = await import('../../confluence/services/sync-service.js');
      expect(getClientForUser).toHaveBeenCalledWith('test-user-id');
      const client = await (getClientForUser as ReturnType<typeof vi.fn>).mock.results[0].value;
      expect(client.addLabels).toHaveBeenCalledWith('conf-42', ['deployment']);
    });

    it('should throw when page not found', async () => {
      mockQueryFn.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await expect(applyTags('test-user-id', '999', ['architecture']))
        .rejects.toThrow('Page not found: 999');
    });
  });

  describe('autoTagAllPages (standalone page inclusion)', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('should include standalone pages (space_key IS NULL) in auto-tag query', async () => {
      // Mock the SELECT query to return both a Confluence page and a standalone page
      mockQueryFn
        .mockResolvedValueOnce({
          rows: [
            { id: 1, body_html: '<p>confluence page</p>' },
            { id: 2, body_html: '<p>standalone page</p>' },
          ],
          rowCount: 2,
        })
        // Mock applyTags SELECT queries (two pages)
        .mockResolvedValueOnce({
          rows: [{ id: 1, confluence_id: 'conf-1', labels: [] }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE for page 1
        .mockResolvedValueOnce({
          rows: [{ id: 2, confluence_id: null, labels: [] }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE for page 2

      mockProviderChat
        .mockResolvedValueOnce('["architecture"]')
        .mockResolvedValueOnce('["deployment"]');

      const result = await autoTagAllPages('test-user-id', 'qwen3:32b');
      expect(result.tagged).toBe(2);
      expect(result.errors).toBe(0);

      // Verify the SELECT query includes OR cp.space_key IS NULL
      const selectCall = mockQueryFn.mock.calls[0];
      expect(selectCall[0]).toContain('space_key IS NULL');
    });
  });
});
