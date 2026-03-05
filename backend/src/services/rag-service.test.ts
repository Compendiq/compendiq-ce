import { describe, it, expect } from 'vitest';
import { buildRagContext, RAG_EF_SEARCH } from './rag-service.js';
import type { SearchResult } from './rag-service.js';

describe('RAG Service', () => {
  describe('RAG_EF_SEARCH config', () => {
    it('should default to 100', () => {
      // Since test-setup.ts does not set RAG_EF_SEARCH, it should default to 100
      expect(RAG_EF_SEARCH).toBe(100);
    });

    it('should be a positive integer', () => {
      expect(Number.isInteger(RAG_EF_SEARCH)).toBe(true);
      expect(RAG_EF_SEARCH).toBeGreaterThan(0);
    });
  });

  describe('buildRagContext', () => {
    it('should return "no context" message for empty results', () => {
      const context = buildRagContext([]);
      expect(context).toBe('No relevant context found in the knowledge base.');
    });

    it('should format a single result', () => {
      const results: SearchResult[] = [
        {
          confluenceId: 'page-1',
          chunkText: 'Some chunk text here.',
          pageTitle: 'Getting Started Guide',
          sectionTitle: 'Installation',
          spaceKey: 'DEV',
          score: 0.85,
        },
      ];

      const context = buildRagContext(results);
      expect(context).toContain('[Source 1:');
      expect(context).toContain('"Getting Started Guide"');
      expect(context).toContain('Space: DEV');
      expect(context).toContain('Section: Installation');
      expect(context).toContain('Some chunk text here.');
    });

    it('should format multiple results separated by ---', () => {
      const results: SearchResult[] = [
        {
          confluenceId: 'page-1',
          chunkText: 'First chunk.',
          pageTitle: 'Page 1',
          sectionTitle: 'Section A',
          spaceKey: 'DEV',
          score: 0.9,
        },
        {
          confluenceId: 'page-2',
          chunkText: 'Second chunk.',
          pageTitle: 'Page 2',
          sectionTitle: 'Section B',
          spaceKey: 'OPS',
          score: 0.8,
        },
      ];

      const context = buildRagContext(results);
      expect(context).toContain('[Source 1:');
      expect(context).toContain('[Source 2:');
      expect(context).toContain('---');
      expect(context).toContain('First chunk.');
      expect(context).toContain('Second chunk.');
    });

    it('should number sources sequentially', () => {
      const results: SearchResult[] = Array.from({ length: 5 }, (_, i) => ({
        confluenceId: `page-${i}`,
        chunkText: `Chunk ${i}`,
        pageTitle: `Page ${i}`,
        sectionTitle: `Section ${i}`,
        spaceKey: 'DEV',
        score: 1 - i * 0.1,
      }));

      const context = buildRagContext(results);
      for (let i = 1; i <= 5; i++) {
        expect(context).toContain(`[Source ${i}:`);
      }
    });
  });
});
