import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock undici before any imports
const mockUndiciRequest = vi.fn();
vi.mock('undici', () => ({
  request: (...args: unknown[]) => mockUndiciRequest(...args),
  Agent: vi.fn().mockImplementation(() => ({})),
}));

// Mock circuit breakers
vi.mock('./circuit-breaker.js', () => ({
  openaiBreakers: {
    chat: {
      execute: vi.fn().mockImplementation(async (fn: () => Promise<unknown>) => fn()),
    },
    embed: {
      execute: vi.fn().mockImplementation(async (fn: () => Promise<unknown>) => fn()),
    },
  },
}));

// Mock logger
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import {
  openaiChat,
  openaiGenerateEmbedding,
  REQUIRED_EMBEDDING_DIMENSIONS,
  type OpenAIConfig,
} from './openai-service.js';

const testConfig: OpenAIConfig = {
  baseUrl: 'https://api.openai.com',
  apiKey: 'test-api-key',
  model: 'gpt-4o-mini',
};

describe('openai-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('REQUIRED_EMBEDDING_DIMENSIONS', () => {
    it('should be 768 to match pgvector column', () => {
      expect(REQUIRED_EMBEDDING_DIMENSIONS).toBe(768);
    });
  });

  describe('openaiChat', () => {
    it('should make a request to the chat completions endpoint', async () => {
      mockUndiciRequest.mockResolvedValue({
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: {
          text: vi.fn().mockResolvedValue(JSON.stringify({
            choices: [{ message: { content: 'Hello from OpenAI' } }],
          })),
        },
      });

      const result = await openaiChat(testConfig, [
        { role: 'user', content: 'say hello' },
      ]);

      expect(result).toBe('Hello from OpenAI');
      expect(mockUndiciRequest).toHaveBeenCalledWith(
        'https://api.openai.com/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Authorization': 'Bearer test-api-key',
          }),
        }),
      );

      // Verify the request body contains the model
      const callArgs = mockUndiciRequest.mock.calls[0];
      const body = JSON.parse(callArgs[1].body as string);
      expect(body.model).toBe('gpt-4o-mini');
      expect(body.messages).toEqual([{ role: 'user', content: 'say hello' }]);
    });

    it('should throw on non-2xx response', async () => {
      mockUndiciRequest.mockResolvedValue({
        statusCode: 429,
        headers: {},
        body: {
          text: vi.fn().mockResolvedValue('Rate limit exceeded'),
        },
      });

      await expect(openaiChat(testConfig, [{ role: 'user', content: 'test' }]))
        .rejects.toThrow('OpenAI API error 429');
    });
  });

  describe('openaiGenerateEmbedding', () => {
    it('should request exactly 768 dimensions', async () => {
      const mockEmbedding = new Array(768).fill(0.1);
      mockUndiciRequest.mockResolvedValue({
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: {
          text: vi.fn().mockResolvedValue(JSON.stringify({
            data: [{ embedding: mockEmbedding }],
          })),
        },
      });

      const result = await openaiGenerateEmbedding(testConfig, 'test text');

      expect(result).toEqual([mockEmbedding]);

      // Verify the request includes dimensions parameter
      const callArgs = mockUndiciRequest.mock.calls[0];
      const body = JSON.parse(callArgs[1].body as string);
      expect(body.dimensions).toBe(768);
      expect(body.model).toBe('text-embedding-3-small');
    });

    it('should handle batch input', async () => {
      const mockEmbedding = new Array(768).fill(0.1);
      mockUndiciRequest.mockResolvedValue({
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: {
          text: vi.fn().mockResolvedValue(JSON.stringify({
            data: [
              { embedding: mockEmbedding },
              { embedding: mockEmbedding },
            ],
          })),
        },
      });

      const result = await openaiGenerateEmbedding(testConfig, ['text 1', 'text 2']);
      expect(result).toHaveLength(2);

      const callArgs = mockUndiciRequest.mock.calls[0];
      const body = JSON.parse(callArgs[1].body as string);
      expect(body.input).toEqual(['text 1', 'text 2']);
    });

    it('should throw when returned dimensions do not match 768', async () => {
      // Simulate an API that ignores the dimensions parameter
      const wrongDimensionEmbedding = new Array(1536).fill(0.1);
      mockUndiciRequest.mockResolvedValue({
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: {
          text: vi.fn().mockResolvedValue(JSON.stringify({
            data: [{ embedding: wrongDimensionEmbedding }],
          })),
        },
      });

      await expect(openaiGenerateEmbedding(testConfig, 'test'))
        .rejects.toThrow('Embedding dimension mismatch: got 1536, expected 768');
    });

    it('should use default embedding model when none provided', async () => {
      const mockEmbedding = new Array(768).fill(0.1);
      mockUndiciRequest.mockResolvedValue({
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: {
          text: vi.fn().mockResolvedValue(JSON.stringify({
            data: [{ embedding: mockEmbedding }],
          })),
        },
      });

      await openaiGenerateEmbedding(testConfig, 'test');

      const callArgs = mockUndiciRequest.mock.calls[0];
      const body = JSON.parse(callArgs[1].body as string);
      expect(body.model).toBe('text-embedding-3-small');
    });

    it('should use custom embedding model when provided', async () => {
      const mockEmbedding = new Array(768).fill(0.1);
      mockUndiciRequest.mockResolvedValue({
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: {
          text: vi.fn().mockResolvedValue(JSON.stringify({
            data: [{ embedding: mockEmbedding }],
          })),
        },
      });

      await openaiGenerateEmbedding(testConfig, 'test', 'text-embedding-3-large');

      const callArgs = mockUndiciRequest.mock.calls[0];
      const body = JSON.parse(callArgs[1].body as string);
      expect(body.model).toBe('text-embedding-3-large');
    });
  });
});
