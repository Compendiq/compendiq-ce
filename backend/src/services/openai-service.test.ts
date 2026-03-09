import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./circuit-breaker.js', () => ({
  ollamaBreakers: {
    chat: { execute: vi.fn((fn: () => unknown) => fn()) },
    embed: { execute: vi.fn((fn: () => unknown) => fn()) },
    list: { execute: vi.fn((fn: () => unknown) => fn()) },
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { OpenAIProvider } from './openai-service.js';

describe('OpenAIProvider', () => {
  const originalEnv = { ...process.env };
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    process.env.OPENAI_BASE_URL = 'https://api.test.com/v1';
    process.env.OPENAI_API_KEY = 'test-key-123';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  describe('checkHealth', () => {
    it('should return connected: true when API responds with 200', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [] }), { status: 200 }),
      );

      const provider = new OpenAIProvider();
      const result = await provider.checkHealth();

      expect(result).toEqual({ connected: true });
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.test.com/v1/models',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-key-123',
          }),
        }),
      );
    });

    it('should return connected: false with error on HTTP error', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response('Unauthorized', { status: 401 }),
      );

      const provider = new OpenAIProvider();
      const result = await provider.checkHealth();

      expect(result.connected).toBe(false);
      expect(result.error).toContain('401');
    });

    it('should return connected: false with error on network failure', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('Connection refused'));

      const provider = new OpenAIProvider();
      const result = await provider.checkHealth();

      expect(result.connected).toBe(false);
      expect(result.error).toBe('Connection refused');
    });
  });

  describe('listModels', () => {
    it('should return parsed model list', async () => {
      fetchSpy.mockResolvedValueOnce(
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
      fetchSpy.mockResolvedValueOnce(
        new Response('Internal Server Error', { status: 500 }),
      );

      const provider = new OpenAIProvider();
      await expect(provider.listModels()).rejects.toThrow('Failed to list models');
    });
  });

  describe('chat', () => {
    it('should return assistant message content', async () => {
      fetchSpy.mockResolvedValueOnce(
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
      const callBody = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(callBody.model).toBe('gpt-4o');
      expect(callBody.stream).toBe(false);
    });
  });

  describe('generateEmbedding', () => {
    it('should return embeddings in correct order', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              { index: 1, embedding: [0.2, 0.3] },
              { index: 0, embedding: [0.1, 0.4] },
            ],
          }),
          { status: 200 },
        ),
      );

      const provider = new OpenAIProvider();
      const result = await provider.generateEmbedding(['text1', 'text2']);

      expect(result).toHaveLength(2);
      // Should be sorted by index
      expect(result[0]).toEqual([0.1, 0.4]);
      expect(result[1]).toEqual([0.2, 0.3]);
    });

    it('should handle single text input', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
          }),
          { status: 200 },
        ),
      );

      const provider = new OpenAIProvider();
      const result = await provider.generateEmbedding('single text');

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual([0.1, 0.2, 0.3]);
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

      fetchSpy.mockResolvedValueOnce(
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
  });

  describe('configuration', () => {
    it('should use default base URL when env var is not set', async () => {
      delete process.env.OPENAI_BASE_URL;

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [] }), { status: 200 }),
      );

      const provider = new OpenAIProvider();
      await provider.checkHealth();

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.openai.com/v1/models',
        expect.anything(),
      );
    });

    it('should not set Authorization header when API key is empty', async () => {
      delete process.env.OPENAI_API_KEY;

      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [] }), { status: 200 }),
      );

      const provider = new OpenAIProvider();
      await provider.checkHealth();

      const headers = fetchSpy.mock.calls[0][1]?.headers as Record<string, string>;
      expect(headers.Authorization).toBeUndefined();
    });
  });
});
