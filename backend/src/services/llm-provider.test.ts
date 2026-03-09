import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

vi.mock('ollama', () => ({
  Ollama: class MockOllama {
    list = vi.fn().mockResolvedValue({ models: [] });
    chat = vi.fn().mockResolvedValue({ message: { content: 'ollama-test' } });
    embed = vi.fn().mockResolvedValue({ embeddings: [[0.1]] });
  },
}));

describe('LLM provider switching', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('should default to ollama provider', async () => {
    delete process.env.LLM_PROVIDER;

    const mod = await import('./ollama-service.js');
    expect(mod.getActiveProviderType()).toBe('ollama');
  });

  it('should use openai provider when LLM_PROVIDER=openai', async () => {
    process.env.LLM_PROVIDER = 'openai';

    const mod = await import('./ollama-service.js');
    expect(mod.getActiveProviderType()).toBe('openai');
  });

  it('should switch provider at runtime via setActiveProvider', async () => {
    delete process.env.LLM_PROVIDER;

    const mod = await import('./ollama-service.js');
    expect(mod.getActiveProviderType()).toBe('ollama');

    mod.setActiveProvider('openai');
    expect(mod.getActiveProviderType()).toBe('openai');

    mod.setActiveProvider('ollama');
    expect(mod.getActiveProviderType()).toBe('ollama');
  });

  it('should throw on unknown provider type', async () => {
    const mod = await import('./ollama-service.js');
    expect(() => mod.setActiveProvider('invalid' as 'ollama')).toThrow('Unknown LLM provider');
  });

  it('should get specific provider via getProvider', async () => {
    const mod = await import('./ollama-service.js');

    const ollamaProvider = mod.getProvider('ollama');
    expect(ollamaProvider.name).toBe('ollama');

    const openaiProvider = mod.getProvider('openai');
    expect(openaiProvider.name).toBe('openai');
  });

  it('should export system prompt functions', async () => {
    const mod = await import('./ollama-service.js');

    expect(mod.getSystemPrompt('ask')).toContain('knowledgeable assistant');
    expect(mod.getSystemPrompt('generate')).toContain('documentation writer');
    expect(mod.getSystemPrompt('summarize')).toContain('summary');
  });

  it('should delegate listModels to active provider', async () => {
    delete process.env.LLM_PROVIDER;
    const mod = await import('./ollama-service.js');

    // Default provider is Ollama
    const models = await mod.listModels();
    expect(Array.isArray(models)).toBe(true);
  });

  it('should delegate checkHealth to active provider', async () => {
    delete process.env.LLM_PROVIDER;
    const mod = await import('./ollama-service.js');

    const health = await mod.checkHealth();
    expect(health).toHaveProperty('connected');
  });

  it('should export backward-compatible ollama client', async () => {
    const mod = await import('./ollama-service.js');
    expect(mod.ollama).toBeDefined();
  });
});
