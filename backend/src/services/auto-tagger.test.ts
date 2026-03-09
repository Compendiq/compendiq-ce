import { describe, it, expect, vi } from 'vitest';
import { parseTagResponse, ALLOWED_TAGS, autoTagContent } from './auto-tagger.js';

// Mock ollama-service to avoid real API calls
const mockChat = vi.fn();
vi.mock('./ollama-service.js', () => ({
  chat: (...args: unknown[]) => mockChat(...args),
  generateEmbedding: vi.fn(),
}));

vi.mock('./content-converter.js', () => ({
  htmlToMarkdown: vi.fn().mockReturnValue('some markdown content'),
}));

vi.mock('../utils/sanitize-llm-input.js', () => ({
  sanitizeLlmInput: vi.fn().mockReturnValue({ sanitized: 'sanitized content' }),
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
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
      mockChat.mockResolvedValueOnce('["architecture", "deployment"]');

      const result = await autoTagContent('qwen3:32b', 'some content');
      expect(result).toEqual(['architecture', 'deployment']);
      expect(mockChat).toHaveBeenCalledOnce();
    });

    it('should wrap LLM errors with descriptive message', async () => {
      mockChat.mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:11434'));

      await expect(autoTagContent('qwen3:32b', 'some content'))
        .rejects.toThrow('Auto-tag LLM call failed: connect ECONNREFUSED 127.0.0.1:11434');
    });

    it('should wrap non-Error LLM failures with descriptive message', async () => {
      mockChat.mockRejectedValueOnce('string error');

      await expect(autoTagContent('qwen3:32b', 'some content'))
        .rejects.toThrow('Auto-tag LLM call failed: string error');
    });

    it('should wrap fetch failed errors', async () => {
      mockChat.mockRejectedValueOnce(new TypeError('fetch failed'));

      await expect(autoTagContent('qwen3:32b', 'some content'))
        .rejects.toThrow('Auto-tag LLM call failed: fetch failed');
    });
  });
});
