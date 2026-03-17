import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockFetch } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
}));

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return {
    ...actual,
    fetch: mockFetch,
  };
});

vi.mock('../../../core/services/circuit-breaker.js', () => ({
  openaiBreakers: {
    chat: { execute: vi.fn((fn: () => unknown) => fn()) },
    embed: { execute: vi.fn((fn: () => unknown) => fn()) },
    list: { execute: vi.fn((fn: () => unknown) => fn()) },
  },
}));

vi.mock('../../../core/utils/logger.js', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { OpenAIProvider } from './openai-service.js';

/** Create a mock embedding array of exactly 768 dimensions. */
function mockEmbedding(seed: number): number[] {
  return Array.from({ length: 768 }, (_, i) => seed + i * 0.001);
}

describe('OpenAIProvider', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    mockFetch.mockReset();
    process.env.OPENAI_BASE_URL = 'https://api.test.com/v1';
    process.env.OPENAI_API_KEY = 'test-key-123';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  describe('checkHealth', () => {
    it('should return connected: true when API responds with 200', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [] }), { status: 200 }),
      );

      const provider = new OpenAIProvider();
      const result = await provider.checkHealth();

      expect(result).toEqual({ connected: true });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.test.com/v1/models',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-key-123',
          }),
        }),
      );
    });

    it('should return connected: false with error on HTTP error', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('Unauthorized', { status: 401 }),
      );

      const provider = new OpenAIProvider();
      const result = await provider.checkHealth();

      expect(result.connected).toBe(false);
      expect(result.error).toContain('401');
    });

    it('should return connected: false with error on network failure', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

      const provider = new OpenAIProvider();
      const result = await provider.checkHealth();

      expect(result.connected).toBe(false);
      expect(result.error).toBe('Connection refused');
    });
  });

  describe('listModels', () => {
    it('should return parsed model list', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              { id: 'gpt-4o', created: 1700000000, owned_by: 'openai' },
              { id: 'gpt-4o-mini', created: 1700000001, owned_by: 'openai' },
            ],
          }),
          { status: 200 },
        ),
      );

      const provider = new OpenAIProvider();
      const models = await provider.listModels();

      expect(models).toHaveLength(2);
      expect(models[0].name).toBe('gpt-4o');
      expect(models[1].name).toBe('gpt-4o-mini');
      expect(models[0].digest).toBe('openai');
    });

    it('should throw on HTTP error', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('Internal Server Error', { status: 500 }),
      );

      const provider = new OpenAIProvider();
      await expect(provider.listModels()).rejects.toThrow('Failed to list models');
    });
  });

  describe('chat', () => {
    it('should return assistant message content', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'Hello from GPT' } }],
          }),
          { status: 200 },
        ),
      );

      const provider = new OpenAIProvider();
      const result = await provider.chat('gpt-4o', [
        { role: 'user', content: 'Hi' },
      ]);

      expect(result).toBe('Hello from GPT');
      const callBody = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
      expect(callBody.model).toBe('gpt-4o');
      expect(callBody.stream).toBe(false);
    });
  });

  describe('generateEmbedding', () => {
    it('should return embeddings in correct order', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              { index: 1, embedding: mockEmbedding(0.2) },
              { index: 0, embedding: mockEmbedding(0.1) },
            ],
          }),
          { status: 200 },
        ),
      );

      const provider = new OpenAIProvider();
      const result = await provider.generateEmbedding(['text1', 'text2']);

      expect(result).toHaveLength(2);
      // Should be sorted by index
      expect(result[0]).toEqual(mockEmbedding(0.1));
      expect(result[1]).toEqual(mockEmbedding(0.2));
    });

    it('should handle single text input', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ index: 0, embedding: mockEmbedding(0.1) }],
          }),
          { status: 200 },
        ),
      );

      const provider = new OpenAIProvider();
      const result = await provider.generateEmbedding('single text');

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(mockEmbedding(0.1));
    });
  });

  describe('streamChat', () => {
    it('should yield stream chunks from SSE response', async () => {
      const sseData = [
        'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{"content":" World"},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ].join('');

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(sseData));
          controller.close();
        },
      });

      mockFetch.mockResolvedValueOnce(
        new Response(stream, { status: 200 }),
      );

      const provider = new OpenAIProvider();
      const chunks: Array<{ content: string; done: boolean }> = [];

      for await (const chunk of provider.streamChat('gpt-4o', [
        { role: 'user', content: 'Hi' },
      ])) {
        chunks.push(chunk);
      }

      expect(chunks.length).toBeGreaterThanOrEqual(2);
      expect(chunks.some((c) => c.content === 'Hello')).toBe(true);
      expect(chunks.some((c) => c.content === ' World')).toBe(true);
    });

    it('should use 5-minute streaming timeout when no signal is provided', async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');

      const sseData = 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(sseData));
          controller.close();
        },
      });
      mockFetch.mockResolvedValueOnce(new Response(stream, { status: 200 }));

      const provider = new OpenAIProvider();
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _chunk of provider.streamChat('gpt-4o', [{ role: 'user', content: 'Hi' }])) {
        // consume
      }

      // streamChat should request the 300s streaming timeout, not the 60s default
      expect(timeoutSpy).toHaveBeenCalledWith(300_000);
      timeoutSpy.mockRestore();
    });

    it('should honour a caller-provided signal instead of the default streaming timeout', async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
      const callerSignal = AbortSignal.timeout(10_000);

      const sseData = 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(sseData));
          controller.close();
        },
      });
      mockFetch.mockResolvedValueOnce(new Response(stream, { status: 200 }));

      const provider = new OpenAIProvider();
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _chunk of provider.streamChat('gpt-4o', [{ role: 'user', content: 'Hi' }], callerSignal)) {
        // consume
      }

      // The 300_000 streaming fallback should NOT have been created
      const streamTimeoutCalls = timeoutSpy.mock.calls.filter(([ms]) => ms === 300_000);
      expect(streamTimeoutCalls).toHaveLength(0);
      timeoutSpy.mockRestore();
    });
  });

  describe('configuration', () => {
    it('should use default base URL when env var is not set', async () => {
      delete process.env.OPENAI_BASE_URL;

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [] }), { status: 200 }),
      );

      const provider = new OpenAIProvider();
      await provider.checkHealth();

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/models',
        expect.anything(),
      );
    });

    it('should not set Authorization header when API key is empty', async () => {
      delete process.env.OPENAI_API_KEY;
      delete process.env.LLM_BEARER_TOKEN;

      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [] }), { status: 200 }),
      );

      const provider = new OpenAIProvider();
      await provider.checkHealth();

      const headers = mockFetch.mock.calls[0][1]?.headers as Record<string, string>;
      expect(headers.Authorization).toBeUndefined();
    });
  });
});
