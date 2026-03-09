import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock DB
const mockQuery = vi.fn();
vi.mock('../db/postgres.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

// Mock crypto
vi.mock('../utils/crypto.js', () => ({
  decryptPat: vi.fn().mockReturnValue('decrypted-api-key'),
  encryptPat: vi.fn().mockReturnValue('encrypted-value'),
}));

// Mock logger
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// Mock ollama-service
const mockOllamaStreamChat = vi.fn();
const mockOllamaChat = vi.fn();
const mockOllamaGenerateEmbedding = vi.fn();
vi.mock('./ollama-service.js', () => ({
  streamChat: (...args: unknown[]) => mockOllamaStreamChat(...args),
  chat: (...args: unknown[]) => mockOllamaChat(...args),
  generateEmbedding: (...args: unknown[]) => mockOllamaGenerateEmbedding(...args),
}));

// Mock openai-service
const mockOpenaiStreamChat = vi.fn();
const mockOpenaiChat = vi.fn();
const mockOpenaiGenerateEmbedding = vi.fn();
vi.mock('./openai-service.js', () => ({
  openaiStreamChat: (...args: unknown[]) => mockOpenaiStreamChat(...args),
  openaiChat: (...args: unknown[]) => mockOpenaiChat(...args),
  openaiGenerateEmbedding: (...args: unknown[]) => mockOpenaiGenerateEmbedding(...args),
  REQUIRED_EMBEDDING_DIMENSIONS: 768,
}));

import { resolveUserProvider, providerStreamChat, providerChat, providerGenerateEmbedding } from './llm-provider.js';
import { decryptPat } from '../utils/crypto.js';

describe('llm-provider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('resolveUserProvider', () => {
    it('should default to ollama when no user_settings row exists', async () => {
      mockQuery.mockResolvedValue({ rows: [] });

      const provider = await resolveUserProvider('user-1');
      expect(provider.type).toBe('ollama');
      expect(provider.openaiConfig).toBeUndefined();
    });

    it('should return ollama when user has llm_provider=ollama', async () => {
      mockQuery.mockResolvedValue({
        rows: [{
          llm_provider: 'ollama',
          openai_base_url: null,
          openai_api_key: null,
          openai_model: null,
        }],
      });

      const provider = await resolveUserProvider('user-1');
      expect(provider.type).toBe('ollama');
    });

    it('should return openai with decrypted config when user has llm_provider=openai', async () => {
      mockQuery.mockResolvedValue({
        rows: [{
          llm_provider: 'openai',
          openai_base_url: 'https://api.openai.com',
          openai_api_key: 'encrypted-key',
          openai_model: 'gpt-4o',
        }],
      });

      const provider = await resolveUserProvider('user-1');
      expect(provider.type).toBe('openai');
      expect(provider.openaiConfig).toEqual({
        baseUrl: 'https://api.openai.com',
        apiKey: 'decrypted-api-key',
        model: 'gpt-4o',
      });
      expect(decryptPat).toHaveBeenCalledWith('encrypted-key');
    });

    it('should strip trailing slashes from base URL', async () => {
      mockQuery.mockResolvedValue({
        rows: [{
          llm_provider: 'openai',
          openai_base_url: 'https://api.openai.com///',
          openai_api_key: 'encrypted-key',
          openai_model: 'gpt-4o',
        }],
      });

      const provider = await resolveUserProvider('user-1');
      expect(provider.openaiConfig?.baseUrl).toBe('https://api.openai.com');
    });

    it('should fall back to ollama when openai config is incomplete (no api_key)', async () => {
      mockQuery.mockResolvedValue({
        rows: [{
          llm_provider: 'openai',
          openai_base_url: 'https://api.openai.com',
          openai_api_key: null,
          openai_model: 'gpt-4o',
        }],
      });

      const provider = await resolveUserProvider('user-1');
      expect(provider.type).toBe('ollama');
    });

    it('should fall back to ollama when openai config is incomplete (no base_url)', async () => {
      mockQuery.mockResolvedValue({
        rows: [{
          llm_provider: 'openai',
          openai_base_url: null,
          openai_api_key: 'encrypted-key',
          openai_model: 'gpt-4o',
        }],
      });

      const provider = await resolveUserProvider('user-1');
      expect(provider.type).toBe('ollama');
    });

    it('should fall back to ollama when decryption fails', async () => {
      mockQuery.mockResolvedValue({
        rows: [{
          llm_provider: 'openai',
          openai_base_url: 'https://api.openai.com',
          openai_api_key: 'corrupted-key',
          openai_model: 'gpt-4o',
        }],
      });
      vi.mocked(decryptPat).mockImplementationOnce(() => {
        throw new Error('Decryption failed');
      });

      const provider = await resolveUserProvider('user-1');
      expect(provider.type).toBe('ollama');
    });

    it('should use default model when openai_model is null', async () => {
      mockQuery.mockResolvedValue({
        rows: [{
          llm_provider: 'openai',
          openai_base_url: 'https://api.openai.com',
          openai_api_key: 'encrypted-key',
          openai_model: null,
        }],
      });

      const provider = await resolveUserProvider('user-1');
      expect(provider.type).toBe('openai');
      expect(provider.openaiConfig?.model).toBe('gpt-4o-mini');
    });

    it('should be per-user -- different users can have different providers', async () => {
      // User A: ollama
      mockQuery.mockResolvedValueOnce({
        rows: [{ llm_provider: 'ollama', openai_base_url: null, openai_api_key: null, openai_model: null }],
      });
      // User B: openai
      mockQuery.mockResolvedValueOnce({
        rows: [{
          llm_provider: 'openai',
          openai_base_url: 'https://api.openai.com',
          openai_api_key: 'encrypted-key-b',
          openai_model: 'gpt-4o',
        }],
      });

      const providerA = await resolveUserProvider('user-a');
      const providerB = await resolveUserProvider('user-b');

      expect(providerA.type).toBe('ollama');
      expect(providerB.type).toBe('openai');
    });
  });

  describe('providerStreamChat', () => {
    it('should delegate to ollama when user has ollama provider', async () => {
      mockQuery.mockResolvedValue({
        rows: [{ llm_provider: 'ollama', openai_base_url: null, openai_api_key: null, openai_model: null }],
      });

      async function* fakeGen() {
        yield { content: 'hello', done: true };
      }
      mockOllamaStreamChat.mockReturnValue(fakeGen());

      const messages = [{ role: 'user' as const, content: 'test' }];
      const chunks: Array<{ content: string; done: boolean }> = [];
      for await (const chunk of providerStreamChat('user-1', 'qwen3.5', messages)) {
        chunks.push(chunk);
      }

      expect(chunks).toEqual([{ content: 'hello', done: true }]);
      expect(mockOllamaStreamChat).toHaveBeenCalledWith('qwen3.5', messages, undefined);
      expect(mockOpenaiStreamChat).not.toHaveBeenCalled();
    });

    it('should delegate to openai when user has openai provider', async () => {
      mockQuery.mockResolvedValue({
        rows: [{
          llm_provider: 'openai',
          openai_base_url: 'https://api.openai.com',
          openai_api_key: 'encrypted-key',
          openai_model: 'gpt-4o',
        }],
      });

      async function* fakeGen() {
        yield { content: 'from openai', done: true };
      }
      mockOpenaiStreamChat.mockReturnValue(fakeGen());

      const messages = [{ role: 'user' as const, content: 'test' }];
      const chunks: Array<{ content: string; done: boolean }> = [];
      for await (const chunk of providerStreamChat('user-1', '', messages)) {
        chunks.push(chunk);
      }

      expect(chunks).toEqual([{ content: 'from openai', done: true }]);
      expect(mockOpenaiStreamChat).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: 'https://api.openai.com', model: 'gpt-4o' }),
        messages,
        undefined,
      );
      expect(mockOllamaStreamChat).not.toHaveBeenCalled();
    });
  });

  describe('providerChat', () => {
    it('should delegate to ollama for ollama users', async () => {
      mockQuery.mockResolvedValue({
        rows: [{ llm_provider: 'ollama', openai_base_url: null, openai_api_key: null, openai_model: null }],
      });
      mockOllamaChat.mockResolvedValue('ollama response');

      const result = await providerChat('user-1', 'qwen3.5', [{ role: 'user', content: 'test' }]);
      expect(result).toBe('ollama response');
      expect(mockOllamaChat).toHaveBeenCalled();
      expect(mockOpenaiChat).not.toHaveBeenCalled();
    });

    it('should delegate to openai for openai users', async () => {
      mockQuery.mockResolvedValue({
        rows: [{
          llm_provider: 'openai',
          openai_base_url: 'https://api.openai.com',
          openai_api_key: 'encrypted-key',
          openai_model: 'gpt-4o',
        }],
      });
      mockOpenaiChat.mockResolvedValue('openai response');

      const result = await providerChat('user-1', '', [{ role: 'user', content: 'test' }]);
      expect(result).toBe('openai response');
      expect(mockOpenaiChat).toHaveBeenCalled();
      expect(mockOllamaChat).not.toHaveBeenCalled();
    });
  });

  describe('providerGenerateEmbedding', () => {
    it('should delegate to ollama for ollama users', async () => {
      mockQuery.mockResolvedValue({
        rows: [{ llm_provider: 'ollama', openai_base_url: null, openai_api_key: null, openai_model: null }],
      });
      mockOllamaGenerateEmbedding.mockResolvedValue([[0.1, 0.2, 0.3]]);

      const result = await providerGenerateEmbedding('user-1', 'some text');
      expect(result).toEqual([[0.1, 0.2, 0.3]]);
      expect(mockOllamaGenerateEmbedding).toHaveBeenCalledWith('some text');
      expect(mockOpenaiGenerateEmbedding).not.toHaveBeenCalled();
    });

    it('should delegate to openai for openai users', async () => {
      mockQuery.mockResolvedValue({
        rows: [{
          llm_provider: 'openai',
          openai_base_url: 'https://api.openai.com',
          openai_api_key: 'encrypted-key',
          openai_model: 'gpt-4o',
        }],
      });
      mockOpenaiGenerateEmbedding.mockResolvedValue([[0.4, 0.5, 0.6]]);

      const result = await providerGenerateEmbedding('user-1', 'some text');
      expect(result).toEqual([[0.4, 0.5, 0.6]]);
      expect(mockOpenaiGenerateEmbedding).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: 'https://api.openai.com' }),
        'some text',
      );
      expect(mockOllamaGenerateEmbedding).not.toHaveBeenCalled();
    });
  });
});
