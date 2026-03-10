import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

vi.mock('./content-converter.js', () => ({
  htmlToMarkdown: vi.fn((html: string) => `md:${html}`),
}));

import {
  fetchSubPages,
  hasSubPages,
  assembleSubPageContext,
  getMultiPagePromptSuffix,
} from './subpage-context.js';

describe('subpage-context', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('hasSubPages', () => {
    it('should return true when page has children', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '3' }] });

      const result = await hasSubPages('user-1', 'page-1');
      expect(result).toBe(true);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('COUNT(*)'),
        ['page-1'],
      );
    });

    it('should return false when page has no children', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });

      const result = await hasSubPages('user-1', 'page-1');
      expect(result).toBe(false);
    });
  });

  describe('fetchSubPages', () => {
    it('should fetch direct children of a page', async () => {
      // First call: children of parent
      mockQuery.mockResolvedValueOnce({
        rows: [
          { confluence_id: 'child-1', title: 'Child 1', body_html: '<p>Content 1</p>' },
          { confluence_id: 'child-2', title: 'Child 2', body_html: '<p>Content 2</p>' },
        ],
      });
      // Second call: children of child-1
      mockQuery.mockResolvedValueOnce({ rows: [] });
      // Third call: children of child-2
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await fetchSubPages('user-1', 'parent-1');

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        confluenceId: 'child-1',
        title: 'Child 1',
        bodyHtml: '<p>Content 1</p>',
        depth: 1,
      });
      expect(result[1]).toEqual({
        confluenceId: 'child-2',
        title: 'Child 2',
        bodyHtml: '<p>Content 2</p>',
        depth: 1,
      });
    });

    it('should fetch nested sub-pages recursively', async () => {
      // Children of parent
      mockQuery.mockResolvedValueOnce({
        rows: [
          { confluence_id: 'child-1', title: 'Child 1', body_html: '<p>C1</p>' },
        ],
      });
      // Children of child-1 (depth 2)
      mockQuery.mockResolvedValueOnce({
        rows: [
          { confluence_id: 'grandchild-1', title: 'Grandchild 1', body_html: '<p>GC1</p>' },
        ],
      });
      // Children of grandchild-1 (depth 3)
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await fetchSubPages('user-1', 'parent-1');

      expect(result).toHaveLength(2);
      expect(result[0].depth).toBe(1);
      expect(result[1].depth).toBe(2);
      expect(result[1].title).toBe('Grandchild 1');
    });

    it('should return empty array when no children', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await fetchSubPages('user-1', 'parent-1');
      expect(result).toHaveLength(0);
    });

    it('should coalesce null body_html to empty string', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { confluence_id: 'child-1', title: 'Child 1', body_html: null },
        ],
      });
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await fetchSubPages('user-1', 'parent-1');

      expect(result).toHaveLength(1);
      expect(result[0].bodyHtml).toBe('');
    });

    it('should respect max depth limit', async () => {
      // Create a chain 6 levels deep (max is 5)
      for (let i = 1; i <= 5; i++) {
        mockQuery.mockResolvedValueOnce({
          rows: [
            { confluence_id: `level-${i}`, title: `Level ${i}`, body_html: `<p>L${i}</p>` },
          ],
        });
      }
      // At depth 6, should not be queried because depth > MAX_DEPTH

      const result = await fetchSubPages('user-1', 'root');

      // Should have 5 pages (depth 1 through 5)
      expect(result).toHaveLength(5);
      expect(result[4].depth).toBe(5);
    });
  });

  describe('assembleSubPageContext', () => {
    it('should assemble parent and sub-page content with markers', async () => {
      // Sub-pages query
      mockQuery.mockResolvedValueOnce({
        rows: [
          { confluence_id: 'child-1', title: 'Getting Started', body_html: '<p>Start here</p>' },
        ],
      });
      // No children of child-1
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await assembleSubPageContext(
        'user-1',
        'parent-1',
        '<p>Parent content</p>',
        'Main Guide',
      );

      expect(result.pageCount).toBe(2);
      expect(result.wasTruncated).toBe(false);
      expect(result.includedPages).toEqual(['Main Guide', 'Getting Started']);
      expect(result.markdown).toContain('--- Page: "Main Guide" (Main Page) ---');
      expect(result.markdown).toContain('md:<p>Parent content</p>');
      expect(result.markdown).toContain('--- Page: "Getting Started" (Sub-page, depth 1) ---');
      expect(result.markdown).toContain('md:<p>Start here</p>');
    });

    it('should return only parent when no sub-pages exist', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await assembleSubPageContext(
        'user-1',
        'parent-1',
        '<p>Solo page</p>',
        'Solo',
      );

      expect(result.pageCount).toBe(1);
      expect(result.wasTruncated).toBe(false);
      expect(result.includedPages).toEqual(['Solo']);
      expect(result.markdown).toContain('--- Page: "Solo" (Main Page) ---');
    });

    it('should truncate when content exceeds maxChars', async () => {
      const longContent = 'x'.repeat(500);
      // Sub-pages with content that will exceed maxChars
      mockQuery.mockResolvedValueOnce({
        rows: [
          { confluence_id: 'child-1', title: 'Child 1', body_html: longContent },
          { confluence_id: 'child-2', title: 'Child 2', body_html: longContent },
        ],
      });
      mockQuery.mockResolvedValueOnce({ rows: [] });
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await assembleSubPageContext(
        'user-1',
        'parent-1',
        '<p>Parent</p>',
        'Parent',
        600, // very small maxChars for testing
      );

      expect(result.wasTruncated).toBe(true);
      // Should include parent + at most 1-2 child pages within 600 chars
      expect(result.pageCount).toBeLessThanOrEqual(3);
    });
  });

  describe('getMultiPagePromptSuffix', () => {
    it('should return empty string for single page', () => {
      expect(getMultiPagePromptSuffix(1)).toBe('');
    });

    it('should return instruction text for multiple pages', () => {
      const suffix = getMultiPagePromptSuffix(5);
      expect(suffix).toContain('5 total');
      expect(suffix).toContain('page title');
      expect(suffix).toContain('--- Page:');
    });
  });
});
