import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We need to test that the Ollama client is configured with the correct headers
// based on the LLM_BEARER_TOKEN env var. Since the module initializes at import time,
// we use dynamic imports with vi.resetModules() to test different configurations.

vi.mock('undici', () => ({
  Agent: class MockAgent {
    constructor(public opts: Record<string, unknown>) {}
  },
}));

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

  it('should provide a custom fetch function with timeout support', async () => {
    delete process.env.LLM_BEARER_TOKEN;

    await import('./ollama-service.js');

    expect(capturedConfig).toBeDefined();
    expect(typeof capturedConfig!.fetch).toBe('function');
  });

  it('should not set Authorization header when LLM_AUTH_TYPE is none even if LLM_BEARER_TOKEN is set', async () => {
    process.env.LLM_BEARER_TOKEN = 'my-secret-token';
    process.env.LLM_AUTH_TYPE = 'none';

    await import('./ollama-service.js');

    expect(capturedConfig).toBeDefined();
    expect(capturedConfig!.headers).toBeUndefined();
  });

  it('should set Authorization header when LLM_AUTH_TYPE is bearer (default)', async () => {
    process.env.LLM_BEARER_TOKEN = 'my-secret-token';
    delete process.env.LLM_AUTH_TYPE;

    await import('./ollama-service.js');

    expect(capturedConfig).toBeDefined();
    expect(capturedConfig!.headers).toEqual({
      Authorization: 'Bearer my-secret-token',
    });
  });

  it('should export isLlmVerifySslEnabled returning true by default', async () => {
    delete process.env.LLM_VERIFY_SSL;
    delete process.env.LLM_BEARER_TOKEN;

    const mod = await import('./ollama-service.js');
    expect(mod.isLlmVerifySslEnabled()).toBe(true);
  });

  it('should export isLlmVerifySslEnabled returning false when LLM_VERIFY_SSL=false', async () => {
    process.env.LLM_VERIFY_SSL = 'false';
    delete process.env.LLM_BEARER_TOKEN;

    const mod = await import('./ollama-service.js');
    expect(mod.isLlmVerifySslEnabled()).toBe(false);
  });

  it('should export getLlmAuthType returning bearer by default', async () => {
    delete process.env.LLM_AUTH_TYPE;
    delete process.env.LLM_BEARER_TOKEN;

    const mod = await import('./ollama-service.js');
    expect(mod.getLlmAuthType()).toBe('bearer');
  });

  it('should export getLlmAuthType returning none when LLM_AUTH_TYPE=none', async () => {
    process.env.LLM_AUTH_TYPE = 'none';
    delete process.env.LLM_BEARER_TOKEN;

    const mod = await import('./ollama-service.js');
    expect(mod.getLlmAuthType()).toBe('none');
  });

  it('should return connected: true from checkHealth when ollama.list() succeeds', async () => {
    delete process.env.LLM_BEARER_TOKEN;

    const mod = await import('./ollama-service.js');
    const result = await mod.checkHealth();

    expect(result).toEqual({ connected: true });
  });

  it('should return connected: false with error from checkHealth when ollama.list() fails', async () => {
    delete process.env.LLM_BEARER_TOKEN;

    // Re-mock ollama to make list() fail for this test
    vi.doMock('ollama', () => ({
      Ollama: class MockOllama {
        constructor(config: Record<string, unknown>) {
          capturedConfig = config;
        }
        list = vi.fn().mockRejectedValue(new Error('Connection refused'));
        chat = vi.fn();
        embed = vi.fn();
      },
    }));

    const mod = await import('./ollama-service.js');
    const result = await mod.checkHealth();

    expect(result.connected).toBe(false);
    expect(result.error).toBe('Connection refused');
  });
});

describe('ollama-service system prompts — diagram special character quoting', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    capturedConfig = undefined;
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  const diagramTypes = ['flowchart', 'sequence', 'state', 'mindmap'] as const;

  for (const type of diagramTypes) {
    it(`generate_diagram_${type} system prompt should instruct quoting labels with special characters`, async () => {
      delete process.env.LLM_BEARER_TOKEN;

      const mod = await import('./ollama-service.js');
      const prompt = mod.getSystemPrompt(`generate_diagram_${type}` as import('./ollama-service.js').SystemPromptKey);

      expect(prompt).toContain('MUST wrap the entire label text in double quotes');
      expect(prompt).toContain('parentheses ()');
      expect(prompt).toContain('brackets []');
      expect(prompt).toContain('braces {}');
    });
  }
});

describe('ollama-service system prompts — language preservation', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    capturedConfig = undefined;
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  const improveTypes = ['grammar', 'structure', 'clarity', 'technical', 'completeness'] as const;

  for (const type of improveTypes) {
    it(`improve_${type} system prompt should contain language preservation instruction`, async () => {
      delete process.env.LLM_BEARER_TOKEN;

      const mod = await import('./ollama-service.js');
      const prompt = mod.getSystemPrompt(`improve_${type}` as import('./ollama-service.js').SystemPromptKey);

      expect(prompt).toContain('ORIGINAL language');
      expect(prompt).toContain('Never translate');
    });
  }

  it('summarize system prompt should contain language preservation instruction', async () => {
    delete process.env.LLM_BEARER_TOKEN;

    const mod = await import('./ollama-service.js');
    const prompt = mod.getSystemPrompt('summarize');

    expect(prompt).toContain('ORIGINAL language');
    expect(prompt).toContain('Never translate');
  });

  it('ask system prompt should instruct responding in the same language as the question', async () => {
    delete process.env.LLM_BEARER_TOKEN;

    const mod = await import('./ollama-service.js');
    const prompt = mod.getSystemPrompt('ask');

    expect(prompt).toContain('same language as the user');
  });

  it('generate system prompt should NOT contain language preservation (user controls language)', async () => {
    delete process.env.LLM_BEARER_TOKEN;

    const mod = await import('./ollama-service.js');
    const prompt = mod.getSystemPrompt('generate');

    expect(prompt).not.toContain('ORIGINAL language');
    expect(prompt).not.toContain('Never translate');
  });
});
