import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mock: mcp-docs-client ---
const mockIsEnabled = vi.fn();
const mockFetchDocumentation = vi.fn();
const mockSearchDocumentation = vi.fn();

vi.mock('../../core/services/mcp-docs-client.js', () => ({
  isEnabled: (...args: unknown[]) => mockIsEnabled(...args),
  fetchDocumentation: (...args: unknown[]) => mockFetchDocumentation(...args),
  searchDocumentation: (...args: unknown[]) => mockSearchDocumentation(...args),
}));

// --- Mock: sanitize-llm-input ---
vi.mock('../../core/utils/sanitize-llm-input.js', () => ({
  sanitizeLlmInput: (input: string) => ({ sanitized: input, warnings: [] }),
}));

// --- Mock: _helpers (getSearxngMaxResults) ---
vi.mock('./_helpers.js', () => ({
  getSearxngMaxResults: vi.fn().mockResolvedValue(5),
}));

// --- Mock: logger ---
vi.mock('../../core/utils/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

import { fetchWebSources, formatWebContext } from './_web-search-helper.js';

describe('_web-search-helper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('fetchWebSources', () => {
    it('returns empty array when MCP docs is disabled', async () => {
      mockIsEnabled.mockResolvedValue(false);

      const result = await fetchWebSources('test query', 'user-1');

      expect(result).toEqual([]);
      expect(mockSearchDocumentation).not.toHaveBeenCalled();
    });

    it('searches and fetches documentation with default maxLength=5000', async () => {
      mockIsEnabled.mockResolvedValue(true);
      mockSearchDocumentation.mockResolvedValue([
        { url: 'https://example.com/doc1', title: 'Doc 1', snippet: 'snippet 1' },
      ]);
      mockFetchDocumentation.mockResolvedValue({
        url: 'https://example.com/doc1',
        title: 'Doc 1',
        markdown: 'Full markdown content',
      });

      const result = await fetchWebSources('test query', 'user-1');

      expect(mockSearchDocumentation).toHaveBeenCalledWith('test query', 'user-1', 5);
      expect(mockFetchDocumentation).toHaveBeenCalledWith('https://example.com/doc1', 'user-1', 5000);
      expect(result).toEqual([
        { url: 'https://example.com/doc1', title: 'Doc 1', snippet: 'Full markdown content' },
      ]);
    });

    it('falls back to snippet on individual fetch failure', async () => {
      mockIsEnabled.mockResolvedValue(true);
      mockSearchDocumentation.mockResolvedValue([
        { url: 'https://example.com/doc1', title: 'Doc 1', snippet: 'fallback snippet' },
      ]);
      mockFetchDocumentation.mockRejectedValue(new Error('fetch failed'));

      const result = await fetchWebSources('test query', 'user-1');

      expect(result).toEqual([
        { url: 'https://example.com/doc1', title: 'Doc 1', snippet: 'fallback snippet' },
      ]);
    });

    it('returns empty array on top-level search error', async () => {
      mockIsEnabled.mockResolvedValue(true);
      mockSearchDocumentation.mockRejectedValue(new Error('search failed'));

      const result = await fetchWebSources('test query', 'user-1');

      expect(result).toEqual([]);
    });

    it('limits to 2 results even when search returns more', async () => {
      mockIsEnabled.mockResolvedValue(true);
      mockSearchDocumentation.mockResolvedValue([
        { url: 'https://example.com/1', title: 'One', snippet: 's1' },
        { url: 'https://example.com/2', title: 'Two', snippet: 's2' },
        { url: 'https://example.com/3', title: 'Three', snippet: 's3' },
      ]);
      mockFetchDocumentation.mockResolvedValue({ url: '', title: '', markdown: 'content' });

      const result = await fetchWebSources('query', 'user-1');

      expect(result).toHaveLength(2);
      expect(mockFetchDocumentation).toHaveBeenCalledTimes(2);
    });

    it('respects custom maxResults and maxLength options', async () => {
      mockIsEnabled.mockResolvedValue(true);
      mockSearchDocumentation.mockResolvedValue([
        { url: 'https://example.com/doc1', title: 'Doc 1', snippet: 's1' },
      ]);
      mockFetchDocumentation.mockResolvedValue({ url: '', title: '', markdown: 'content' });

      await fetchWebSources('query', 'user-1', { maxResults: 10, maxLength: 8000 });

      expect(mockSearchDocumentation).toHaveBeenCalledWith('query', 'user-1', 10);
      expect(mockFetchDocumentation).toHaveBeenCalledWith('https://example.com/doc1', 'user-1', 8000);
    });
  });

  describe('formatWebContext', () => {
    it('returns empty string for empty sources', () => {
      const result = formatWebContext([], {
        sourceLabel: 'Reference',
        sectionHeader: 'Web search results',
      });
      expect(result).toBe('');
    });

    it('formats single source with correct label and header', () => {
      const result = formatWebContext(
        [{ url: 'https://example.com', title: 'Example', snippet: 'Some content' }],
        { sourceLabel: 'Reference', sectionHeader: 'Verified reference material from web search' },
      );

      expect(result).toContain('Verified reference material from web search:');
      expect(result).toContain('[Reference 1: "Example" (https://example.com)]');
      expect(result).toContain('Some content');
    });

    it('formats multiple sources with correct numbering and separators', () => {
      const result = formatWebContext(
        [
          { url: 'https://a.com', title: 'A', snippet: 'Content A' },
          { url: 'https://b.com', title: 'B', snippet: 'Content B' },
        ],
        { sourceLabel: 'Web Source', sectionHeader: 'Web search results' },
      );

      expect(result).toContain('[Web Source 1: "A" (https://a.com)]');
      expect(result).toContain('[Web Source 2: "B" (https://b.com)]');
      expect(result).toContain('---');
      expect(result).toContain('Web search results:');
    });

    it('preserves different formatting configs', () => {
      const sources = [{ url: 'https://x.com', title: 'X', snippet: 'content' }];

      const ref = formatWebContext(sources, { sourceLabel: 'Reference', sectionHeader: 'Reference material' });
      const web = formatWebContext(sources, { sourceLabel: 'Web Source', sectionHeader: 'Web search results' });

      expect(ref).toContain('[Reference 1:');
      expect(ref).toContain('Reference material:');
      expect(web).toContain('[Web Source 1:');
      expect(web).toContain('Web search results:');
    });
  });
});
