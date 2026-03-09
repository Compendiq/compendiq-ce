import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We need to test that the Ollama client is configured with the correct headers
// based on the LLM_BEARER_TOKEN env var. Since the module initializes at import time,
// we use dynamic imports with vi.resetModules() to test different configurations.

vi.mock('./circuit-breaker.js', () => ({
  ollamaBreakers: {
    chat: { execute: vi.fn((fn: () => unknown) => fn()) },
    embed: { execute: vi.fn((fn: () => unknown) => fn()) },
    list: { execute: vi.fn((fn: () => unknown) => fn()) },
  },
}));

vi.mock('../utils/sanitize-llm-input.js', () => ({
  sanitizeLlmInput: vi.fn((input: string) => ({ sanitized: input, warnings: [] })),
}));

vi.mock('../utils/logger.js', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

// Capture the config passed to Ollama constructor
let capturedConfig: Record<string, unknown> | undefined;

vi.mock('ollama', () => {
  return {
    Ollama: class MockOllama {
      constructor(config: Record<string, unknown>) {
        capturedConfig = config;
      }
      list = vi.fn().mockResolvedValue({ models: [] });
      chat = vi.fn().mockResolvedValue({ message: { content: 'test' } });
      embed = vi.fn().mockResolvedValue({ embeddings: [[0.1]] });
    },
  };
});

describe('ollama-service bearer token configuration', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    capturedConfig = undefined;
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('should not set Authorization header when LLM_BEARER_TOKEN is not set', async () => {
    delete process.env.LLM_BEARER_TOKEN;

    await import('./ollama-service.js');

    expect(capturedConfig).toBeDefined();
    expect(capturedConfig!.headers).toBeUndefined();
  });

  it('should set Authorization header when LLM_BEARER_TOKEN is set', async () => {
    process.env.LLM_BEARER_TOKEN = 'my-secret-token';

    await import('./ollama-service.js');

    expect(capturedConfig).toBeDefined();
    expect(capturedConfig!.headers).toEqual({
      Authorization: 'Bearer my-secret-token',
    });
  });

  it('should use custom OLLAMA_BASE_URL when set', async () => {
    process.env.OLLAMA_BASE_URL = 'http://remote-ollama:11434';
    delete process.env.LLM_BEARER_TOKEN;

    await import('./ollama-service.js');

    expect(capturedConfig).toBeDefined();
    expect(capturedConfig!.host).toBe('http://remote-ollama:11434');
  });

  it('should use default OLLAMA_BASE_URL when not set', async () => {
    delete process.env.OLLAMA_BASE_URL;
    delete process.env.LLM_BEARER_TOKEN;

    await import('./ollama-service.js');

    expect(capturedConfig).toBeDefined();
    expect(capturedConfig!.host).toBe('http://localhost:11434');
  });
});
