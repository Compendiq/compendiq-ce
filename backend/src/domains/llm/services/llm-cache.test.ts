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

  it('should differ when provider changes (issue #217)', () => {
    const keyOllama = buildLlmCacheKey('same-model', 'system', 'content', 'ollama');
    const keyOpenai = buildLlmCacheKey('same-model', 'system', 'content', 'openai');
    expect(keyOllama).not.toBe(keyOpenai);
  });

  it('should match key without provider when provider is omitted', () => {
    const keyNoProvider = buildLlmCacheKey('model', 'system', 'content');
    const keyUndefinedProvider = buildLlmCacheKey('model', 'system', 'content', undefined);
    expect(keyNoProvider).toBe(keyUndefinedProvider);
  });

  it('should differ when thinking is toggled', () => {
    const off = buildLlmCacheKey('model', 'sys', 'user', 'p');
    const on  = buildLlmCacheKey('model', 'sys', 'user', 'p', { thinking: true });
    expect(off).not.toBe(on);
  });
});

describe('buildRagCacheKey', () => {
  it('keys on the assembly budget — killing assembly must not replay large-context answers (#1270 m6)', () => {
    const at = (contextChars?: number) =>
      buildRagCacheKey('m', 'q', ['d1'], { provider: 'p1', contextChars });
    expect(at(6000)).not.toBe(at(0));
    expect(at(6000)).toBe(at(6000));
    // Absent stays its own namespace (pre-#1270 callers).
    expect(at(undefined)).not.toBe(at(6000));
  });

  it('keys on the pin count — a soft-failed pin must not serve the pinned answer for the TTL (#1273 M5)', () => {
    const at = (pinnedCount: number) =>
      buildRagCacheKey('m', 'q', ['d1'], { provider: 'p1', pinnedCount });
    expect(at(1)).not.toBe(at(0));
    expect(at(1)).toBe(at(1));
  });

  it('keys on deep search — the two modes must never serve each other\'s answers (#1112)', () => {
    // Not hypothetical arithmetic: deep search fuses three phrasings, so it
    // can return the SAME pages in a DIFFERENT order (identical docIds — the
    // id component sees nothing), and when expansion soft-fails it returns
    // literally the single-query result. Without the flag one mode poisons
    // the other for the whole TTL, in both directions.
    const at = (deepSearch?: boolean) =>
      buildRagCacheKey('m', 'q', ['d1', 'd2'], { provider: 'p1', deepSearch });
    expect(at(true)).not.toBe(at(false));
    expect(at(true)).toBe(at(true));
    // Absent and false are the same request — the flag defaults off, so a
    // caller that never heard of it keeps today's key.
    expect(at(undefined)).toBe(at(false));
  });

  it('keys on attached reference text so different documents never share an answer', () => {
    const withoutReference = buildRagCacheKey('m', 'q', ['d1'], { provider: 'p1' });
    const firstReference = buildRagCacheKey('m', 'q', ['d1'], {
      provider: 'p1', referenceText: 'first document',
    });
    const secondReference = buildRagCacheKey('m', 'q', ['d1'], {
      provider: 'p1', referenceText: 'second document',
    });

    expect(firstReference).not.toBe(withoutReference);
    expect(firstReference).not.toBe(secondReference);
    expect(firstReference).toBe(buildRagCacheKey('m', 'q', ['d1'], {
      provider: 'p1', referenceText: 'first document',
    }));
  });

  it('keys on the REALIZED outcome — a soft-failed chunk-level answer never occupies the assembled key (#1270 F9)', () => {
    const at = (assembledPages: number) =>
      buildRagCacheKey('m', 'q', ['d1'], { provider: 'p1', contextChars: 6000, assembledPages });
    expect(at(5)).not.toBe(at(0));
    expect(at(5)).toBe(at(5));
  });

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

  it('should differ when provider changes (issue #217)', () => {
    const keyOllama = buildRagCacheKey('same-model', 'question', ['doc1'], {
      provider: 'ollama',
    });
    const keyOpenai = buildRagCacheKey('same-model', 'question', ['doc1'], {
      provider: 'openai',
    });
    expect(keyOllama).not.toBe(keyOpenai);
  });

  it('should match key without provider when provider is omitted', () => {
    const keyNoProvider = buildRagCacheKey('model', 'question', ['doc1']);
    const keyEmptyOpts = buildRagCacheKey('model', 'question', ['doc1'], {});
    expect(keyNoProvider).toBe(keyEmptyOpts);
  });

  // Thinking-on responses must live in a separate cache namespace, otherwise
  // a prior thinking-off answer is replayed when the user toggles Think on
  // and the upstream LLM never sees the new request.
  it('should differ when thinking is toggled', () => {
    const off = buildRagCacheKey('model', 'q', ['d1'], { provider: 'p' });
    const on  = buildRagCacheKey('model', 'q', ['d1'], { provider: 'p', thinking: true });
    expect(off).not.toBe(on);
  });

  it('should treat thinking:false as equivalent to omitted', () => {
    const off = buildRagCacheKey('model', 'q', ['d1'], { provider: 'p' });
    const offExplicit = buildRagCacheKey('model', 'q', ['d1'], { provider: 'p', thinking: false });
    expect(off).toBe(offExplicit);
  });
});

describe('LlmCache', () => {
  let cache: LlmCache;
  let mockRedis: {
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
    setEx: ReturnType<typeof vi.fn>;
    scan: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
    exists: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockRedis = {
      get: vi.fn(),
      set: vi.fn(),
      setEx: vi.fn(),
      scan: vi.fn(),
      del: vi.fn(),
      exists: vi.fn(),
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

  describe('acquireLock', () => {
    it('should return true when lock is acquired (SET NX succeeds)', async () => {
      mockRedis.set.mockResolvedValue('OK');
      const acquired = await cache.acquireLock('kb:llm:abc123');
      expect(acquired).toBe(true);
      expect(mockRedis.set).toHaveBeenCalledWith('llm:lock:kb:llm:abc123', '1', { NX: true, EX: 120 });
    });

    it('should return false when lock is already held (SET NX returns null)', async () => {
      mockRedis.set.mockResolvedValue(null);
      const acquired = await cache.acquireLock('kb:llm:abc123');
      expect(acquired).toBe(false);
    });

    it('should accept a custom TTL', async () => {
      mockRedis.set.mockResolvedValue('OK');
      await cache.acquireLock('kb:llm:abc123', 30);
      expect(mockRedis.set).toHaveBeenCalledWith('llm:lock:kb:llm:abc123', '1', { NX: true, EX: 30 });
    });

    it('should return true on Redis error (graceful degradation)', async () => {
      mockRedis.set.mockRejectedValue(new Error('Redis down'));
      const acquired = await cache.acquireLock('kb:llm:abc123');
      // On failure, allow caller to proceed rather than blocking
      expect(acquired).toBe(true);
    });
  });

  describe('releaseLock', () => {
    it('should delete the lock key', async () => {
      mockRedis.del.mockResolvedValue(1);
      await cache.releaseLock('kb:llm:abc123');
      expect(mockRedis.del).toHaveBeenCalledWith('llm:lock:kb:llm:abc123');
    });

    it('should not throw on Redis error', async () => {
      mockRedis.del.mockRejectedValue(new Error('Redis down'));
      // Should not throw
      await cache.releaseLock('kb:llm:abc123');
    });
  });

  describe('waitForCachedResponse', () => {
    it('should return cached response on first poll if available', async () => {
      const cached = { content: 'Generated answer', cachedAt: Date.now() };
      mockRedis.get.mockResolvedValue(JSON.stringify(cached));

      const result = await cache.waitForCachedResponse('kb:llm:abc123', 50, 5000);
      expect(result).toEqual(cached);
      // Should only poll once since it found the result immediately
      expect(mockRedis.get).toHaveBeenCalledTimes(1);
    });

    it('should poll until cached response appears', async () => {
      const cached = { content: 'Delayed result', cachedAt: Date.now() };
      mockRedis.get
        .mockResolvedValueOnce(null)  // 1st poll: miss
        .mockResolvedValueOnce(null)  // 2nd poll: miss
        .mockResolvedValue(JSON.stringify(cached));  // 3rd poll: hit

      // Lock exists for the first two polls
      mockRedis.exists.mockResolvedValue(1);

      const result = await cache.waitForCachedResponse('kb:llm:abc123', 10, 5000);
      expect(result).toEqual(cached);
      expect(mockRedis.get).toHaveBeenCalledTimes(3);
    });

    it('should return null when lock disappears without cached result', async () => {
      mockRedis.get.mockResolvedValue(null);
      // Lock was released (holder failed without caching)
      mockRedis.exists.mockResolvedValue(0);

      const result = await cache.waitForCachedResponse('kb:llm:abc123', 10, 5000);
      expect(result).toBeNull();
    });

    it('should return null on timeout', async () => {
      mockRedis.get.mockResolvedValue(null);
      mockRedis.exists.mockResolvedValue(1); // Lock always held

      const result = await cache.waitForCachedResponse('kb:llm:abc123', 10, 30);
      expect(result).toBeNull();
    });

    it('should keep polling if exists check fails', async () => {
      const cached = { content: 'Eventually found', cachedAt: Date.now() };
      mockRedis.get
        .mockResolvedValueOnce(null)
        .mockResolvedValue(JSON.stringify(cached));
      // exists throws on first call
      mockRedis.exists.mockRejectedValueOnce(new Error('Redis intermittent'));

      const result = await cache.waitForCachedResponse('kb:llm:abc123', 10, 5000);
      expect(result).toEqual(cached);
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

describe('buildLlmCacheKey imageHash (#1154)', () => {
  /**
   * Without the image in the key, two different images sharing one prompt
   * collide and the second request is served the first image's answer.
   */
  it('produces different keys for different images with one prompt', () => {
    const a = buildLlmCacheKey('m', 'sys', 'user', 'p', { imageHash: 'a'.repeat(64) });
    const b = buildLlmCacheKey('m', 'sys', 'user', 'p', { imageHash: 'b'.repeat(64) });
    expect(a).not.toBe(b);
  });

  it('differs from the same prompt with no image', () => {
    const withImage = buildLlmCacheKey('m', 'sys', 'user', 'p', { imageHash: 'a'.repeat(64) });
    const without = buildLlmCacheKey('m', 'sys', 'user', 'p');
    expect(withImage).not.toBe(without);
  });

  it('is stable for the same image', () => {
    const opts = { imageHash: 'a'.repeat(64) };
    expect(buildLlmCacheKey('m', 'sys', 'user', 'p', opts))
      .toBe(buildLlmCacheKey('m', 'sys', 'user', 'p', opts));
  });

  it('leaves existing text-only keys unchanged', () => {
    expect(buildLlmCacheKey('m', 'sys', 'user', 'p'))
      .toBe(buildLlmCacheKey('m', 'sys', 'user', 'p', {}));
  });
});
