import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  hashLlmInputs,
  buildLlmCacheKey,
  buildRagCacheKey,
  LlmCache,
} from './llm-cache.js';

describe('hashLlmInputs', () => {
  it('should produce a deterministic SHA-256 hex string', () => {
    const hash1 = hashLlmInputs('model-a', 'system prompt', 'user content');
    const hash2 = hashLlmInputs('model-a', 'system prompt', 'user content');
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/); // SHA-256 = 64 hex chars
  });

  it('should produce different hashes for different inputs', () => {
    const hash1 = hashLlmInputs('model-a', 'prompt-1', 'content');
    const hash2 = hashLlmInputs('model-a', 'prompt-2', 'content');
    expect(hash1).not.toBe(hash2);
  });

  it('should avoid collisions from concatenation ambiguity', () => {
    // "abc" + "def" vs "ab" + "cdef" should be different due to null separator
    const hash1 = hashLlmInputs('abc', 'def');
    const hash2 = hashLlmInputs('ab', 'cdef');
    expect(hash1).not.toBe(hash2);
  });
});

describe('buildLlmCacheKey', () => {
  it('should prefix with kb:llm:', () => {
    const key = buildLlmCacheKey('qwen3.5', 'system', 'user');
    expect(key).toMatch(/^kb:llm:[a-f0-9]{64}$/);
  });

  it('should produce same key for same inputs', () => {
    const key1 = buildLlmCacheKey('qwen3.5', 'Improve grammar', 'Hello world');
    const key2 = buildLlmCacheKey('qwen3.5', 'Improve grammar', 'Hello world');
    expect(key1).toBe(key2);
  });

  it('should differ when model changes', () => {
    const key1 = buildLlmCacheKey('qwen3.5', 'system', 'content');
    const key2 = buildLlmCacheKey('llama3', 'system', 'content');
    expect(key1).not.toBe(key2);
  });
});

describe('buildRagCacheKey', () => {
  it('should prefix with kb:llm:', () => {
    const key = buildRagCacheKey('qwen3.5', 'What is X?', ['doc1', 'doc2']);
    expect(key).toMatch(/^kb:llm:[a-f0-9]{64}$/);
  });

  it('should be independent of docId order', () => {
    const key1 = buildRagCacheKey('model', 'question', ['doc1', 'doc2', 'doc3']);
    const key2 = buildRagCacheKey('model', 'question', ['doc3', 'doc1', 'doc2']);
    expect(key1).toBe(key2);
  });

  it('should differ when doc IDs change', () => {
    const key1 = buildRagCacheKey('model', 'question', ['doc1', 'doc2']);
    const key2 = buildRagCacheKey('model', 'question', ['doc1', 'doc3']);
    expect(key1).not.toBe(key2);
  });

  it('should differ when includeSubPages is toggled', () => {
    const keyWithout = buildRagCacheKey('model', 'question', ['doc1']);
    const keyWith = buildRagCacheKey('model', 'question', ['doc1'], {
      includeSubPages: true,
      pageId: 'page-1',
    });
    expect(keyWithout).not.toBe(keyWith);
  });

  it('should differ when pageId changes with includeSubPages', () => {
    const key1 = buildRagCacheKey('model', 'question', ['doc1'], {
      includeSubPages: true,
      pageId: 'page-1',
    });
    const key2 = buildRagCacheKey('model', 'question', ['doc1'], {
      includeSubPages: true,
      pageId: 'page-2',
    });
    expect(key1).not.toBe(key2);
  });

  it('should match key without options when includeSubPages is false', () => {
    const keyNoOpts = buildRagCacheKey('model', 'question', ['doc1']);
    const keyFalse = buildRagCacheKey('model', 'question', ['doc1'], {
      includeSubPages: false,
      pageId: 'page-1',
    });
    expect(keyNoOpts).toBe(keyFalse);
  });
});

describe('LlmCache', () => {
  let cache: LlmCache;
  let mockRedis: {
    get: ReturnType<typeof vi.fn>;
    setEx: ReturnType<typeof vi.fn>;
    scan: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockRedis = {
      get: vi.fn(),
      setEx: vi.fn(),
      scan: vi.fn(),
      del: vi.fn(),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cache = new LlmCache(mockRedis as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getCachedResponse', () => {
    it('should return null on cache miss', async () => {
      mockRedis.get.mockResolvedValue(null);
      const result = await cache.getCachedResponse('kb:llm:abc123');
      expect(result).toBeNull();
      expect(mockRedis.get).toHaveBeenCalledWith('kb:llm:abc123');
    });

    it('should return parsed response on cache hit', async () => {
      const cached = { content: 'Hello world', cachedAt: 1000000 };
      mockRedis.get.mockResolvedValue(JSON.stringify(cached));
      const result = await cache.getCachedResponse('kb:llm:abc123');
      expect(result).toEqual(cached);
    });

    it('should return null and log error on Redis failure', async () => {
      mockRedis.get.mockRejectedValue(new Error('Redis down'));
      const result = await cache.getCachedResponse('kb:llm:abc123');
      expect(result).toBeNull();
    });
  });

  describe('setCachedResponse', () => {
    it('should store response with default TTL', async () => {
      mockRedis.setEx.mockResolvedValue('OK');
      await cache.setCachedResponse('kb:llm:abc123', 'response text');

      expect(mockRedis.setEx).toHaveBeenCalledWith(
        'kb:llm:abc123',
        3600,
        expect.stringContaining('"content":"response text"'),
      );
    });

    it('should store response with custom TTL', async () => {
      mockRedis.setEx.mockResolvedValue('OK');
      await cache.setCachedResponse('kb:llm:abc123', 'response', 1800);

      expect(mockRedis.setEx).toHaveBeenCalledWith(
        'kb:llm:abc123',
        1800,
        expect.any(String),
      );
    });

    it('should not throw on Redis error', async () => {
      mockRedis.setEx.mockRejectedValue(new Error('Redis down'));
      // Should not throw
      await cache.setCachedResponse('kb:llm:abc123', 'response');
    });
  });

  describe('clearAll', () => {
    it('should scan and delete all LLM cache keys', async () => {
      mockRedis.scan
        .mockResolvedValueOnce({ cursor: '10', keys: ['kb:llm:aaa', 'kb:llm:bbb'] })
        .mockResolvedValueOnce({ cursor: '0', keys: ['kb:llm:ccc'] });
      mockRedis.del.mockResolvedValue(2);

      const deleted = await cache.clearAll();
      expect(deleted).toBe(3);
      expect(mockRedis.scan).toHaveBeenCalledTimes(2);
      expect(mockRedis.del).toHaveBeenCalledTimes(2);
    });

    it('should handle empty cache', async () => {
      mockRedis.scan.mockResolvedValueOnce({ cursor: '0', keys: [] });
      const deleted = await cache.clearAll();
      expect(deleted).toBe(0);
    });
  });
});
