import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

describe('llm-config', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('should return undefined connect options when SSL verification enabled and no CA bundle', async () => {
    vi.stubEnv('LLM_VERIFY_SSL', 'true');
    vi.stubEnv('NODE_EXTRA_CA_CERTS', '');

    vi.doMock('fs', () => ({
      readFileSync: vi.fn().mockImplementation(() => { throw new Error('ENOENT'); }),
      existsSync: vi.fn().mockReturnValue(false),
    }));
    vi.doMock('undici', () => ({
      Agent: vi.fn(),
    }));

    const { buildLlmConnectOptions, llmDispatcher } = await import('./llm-config.js');
    expect(buildLlmConnectOptions()).toBeUndefined();
    expect(llmDispatcher).toBeUndefined();
  });

  it('should return rejectUnauthorized false when LLM_VERIFY_SSL is false', async () => {
    vi.stubEnv('LLM_VERIFY_SSL', 'false');
    vi.stubEnv('NODE_EXTRA_CA_CERTS', '');

    vi.doMock('fs', () => ({
      readFileSync: vi.fn().mockImplementation(() => { throw new Error('ENOENT'); }),
      existsSync: vi.fn().mockReturnValue(false),
    }));

    const MockAgent = vi.fn();
    vi.doMock('undici', () => ({
      Agent: MockAgent,
    }));

    const { buildLlmConnectOptions, llmDispatcher } = await import('./llm-config.js');
    expect(buildLlmConnectOptions()).toEqual({ rejectUnauthorized: false });
    expect(llmDispatcher).toBeDefined();
    expect(MockAgent).toHaveBeenCalledWith({
      connect: { rejectUnauthorized: false },
    });
  });

  it('should load CA bundle from NODE_EXTRA_CA_CERTS', async () => {
    const fakeCert = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n';
    vi.stubEnv('LLM_VERIFY_SSL', 'true');
    vi.stubEnv('NODE_EXTRA_CA_CERTS', '/custom/ca.pem');

    vi.doMock('fs', () => ({
      readFileSync: vi.fn().mockReturnValue(fakeCert),
      existsSync: vi.fn().mockReturnValue(false),
    }));

    const MockAgent = vi.fn();
    vi.doMock('undici', () => ({
      Agent: MockAgent,
    }));

    const { buildLlmConnectOptions, llmDispatcher } = await import('./llm-config.js');
    expect(buildLlmConnectOptions()).toEqual({ ca: fakeCert });
    expect(llmDispatcher).toBeDefined();
    expect(MockAgent).toHaveBeenCalledWith({
      connect: { ca: fakeCert },
    });
  });

  it('should fall back to system CA paths when NODE_EXTRA_CA_CERTS not set', async () => {
    const fakeCert = '-----BEGIN CERTIFICATE-----\nMIIBsystem\n-----END CERTIFICATE-----\n';
    vi.stubEnv('LLM_VERIFY_SSL', 'true');
    vi.stubEnv('NODE_EXTRA_CA_CERTS', '');

    vi.doMock('fs', () => ({
      readFileSync: vi.fn().mockReturnValue(fakeCert),
      existsSync: vi.fn().mockReturnValue(true),
    }));

    const MockAgent = vi.fn();
    vi.doMock('undici', () => ({
      Agent: MockAgent,
    }));

    const { llmDispatcher } = await import('./llm-config.js');
    expect(llmDispatcher).toBeDefined();
    expect(MockAgent).toHaveBeenCalledWith({
      connect: { ca: fakeCert },
    });
  });

  it('should report verify SSL status', async () => {
    vi.stubEnv('LLM_VERIFY_SSL', 'true');
    vi.stubEnv('NODE_EXTRA_CA_CERTS', '');

    vi.doMock('fs', () => ({
      readFileSync: vi.fn().mockImplementation(() => { throw new Error('ENOENT'); }),
      existsSync: vi.fn().mockReturnValue(false),
    }));
    vi.doMock('undici', () => ({
      Agent: vi.fn(),
    }));

    const { isLlmVerifySslEnabled } = await import('./llm-config.js');
    expect(isLlmVerifySslEnabled()).toBe(true);
  });

  it('should return false for verify SSL when LLM_VERIFY_SSL=false', async () => {
    vi.stubEnv('LLM_VERIFY_SSL', 'false');
    vi.stubEnv('NODE_EXTRA_CA_CERTS', '');

    vi.doMock('fs', () => ({
      readFileSync: vi.fn().mockImplementation(() => { throw new Error('ENOENT'); }),
      existsSync: vi.fn().mockReturnValue(false),
    }));
    vi.doMock('undici', () => ({
      Agent: vi.fn(),
    }));

    const { isLlmVerifySslEnabled } = await import('./llm-config.js');
    expect(isLlmVerifySslEnabled()).toBe(false);
  });

  describe('LLM_AUTH_TYPE startup warning', () => {
    it('should warn when LLM_AUTH_TYPE is explicitly set to bearer without a token', async () => {
      vi.stubEnv('LLM_AUTH_TYPE', 'bearer');
      vi.stubEnv('LLM_BEARER_TOKEN', '');
      vi.stubEnv('NODE_EXTRA_CA_CERTS', '');

      vi.doMock('fs', () => ({
        readFileSync: vi.fn().mockImplementation(() => { throw new Error('ENOENT'); }),
        existsSync: vi.fn().mockReturnValue(false),
      }));
      vi.doMock('undici', () => ({
        Agent: vi.fn(),
      }));

      const { logger } = await import('./logger.js');
      await import('./llm-config.js');
      expect(logger.warn).toHaveBeenCalledWith('LLM_AUTH_TYPE=bearer but LLM_BEARER_TOKEN is empty');
    });

    it('should NOT warn when LLM_AUTH_TYPE is not set (default bearer without token)', async () => {
      // Do NOT set LLM_AUTH_TYPE — the default is 'bearer' but the warning
      // should only fire when the user explicitly configured it.
      delete process.env.LLM_AUTH_TYPE;
      vi.stubEnv('LLM_VERIFY_SSL', 'true');
      vi.stubEnv('LLM_BEARER_TOKEN', '');
      vi.stubEnv('NODE_EXTRA_CA_CERTS', '');

      vi.doMock('fs', () => ({
        readFileSync: vi.fn().mockImplementation(() => { throw new Error('ENOENT'); }),
        existsSync: vi.fn().mockReturnValue(false),
      }));
      vi.doMock('undici', () => ({
        Agent: vi.fn(),
      }));

      const { logger } = await import('./logger.js');
      // Clear accumulated calls from previous tests (module-level mock is shared)
      vi.mocked(logger.warn).mockClear();
      await import('./llm-config.js');
      expect(logger.warn).not.toHaveBeenCalledWith('LLM_AUTH_TYPE=bearer but LLM_BEARER_TOKEN is empty');
    });
  });

  describe('getLlmAuthHeaders', () => {
    it('should return empty object when no auth configured', async () => {
      vi.stubEnv('LLM_AUTH_TYPE', 'none');
      vi.stubEnv('NODE_EXTRA_CA_CERTS', '');

      vi.doMock('fs', () => ({
        readFileSync: vi.fn().mockImplementation(() => { throw new Error('ENOENT'); }),
        existsSync: vi.fn().mockReturnValue(false),
      }));
      vi.doMock('undici', () => ({
        Agent: vi.fn(),
      }));

      const { getLlmAuthHeaders } = await import('./llm-config.js');
      expect(getLlmAuthHeaders()).toEqual({});
    });

    it('should return bearer auth header when configured', async () => {
      vi.stubEnv('LLM_AUTH_TYPE', 'bearer');
      vi.stubEnv('LLM_BEARER_TOKEN', 'my-secret-token');
      vi.stubEnv('NODE_EXTRA_CA_CERTS', '');

      vi.doMock('fs', () => ({
        readFileSync: vi.fn().mockImplementation(() => { throw new Error('ENOENT'); }),
        existsSync: vi.fn().mockReturnValue(false),
      }));
      vi.doMock('undici', () => ({
        Agent: vi.fn(),
      }));

      const { getLlmAuthHeaders } = await import('./llm-config.js');
      expect(getLlmAuthHeaders()).toEqual({ Authorization: 'Bearer my-secret-token' });
    });

    it('should default to bearer auth when LLM_AUTH_TYPE is not set', async () => {
      // Do NOT stub LLM_AUTH_TYPE — verify the default is 'bearer'
      delete process.env.LLM_AUTH_TYPE;
      vi.stubEnv('LLM_BEARER_TOKEN', 'default-test-token');
      vi.stubEnv('NODE_EXTRA_CA_CERTS', '');

      vi.doMock('fs', () => ({
        readFileSync: vi.fn().mockImplementation(() => { throw new Error('ENOENT'); }),
        existsSync: vi.fn().mockReturnValue(false),
      }));
      vi.doMock('undici', () => ({
        Agent: vi.fn(),
      }));

      const { getLlmAuthHeaders } = await import('./llm-config.js');
      expect(getLlmAuthHeaders()).toEqual({ Authorization: 'Bearer default-test-token' });
    });

    it('should return empty object when bearer auth type but no token', async () => {
      vi.stubEnv('LLM_AUTH_TYPE', 'bearer');
      vi.stubEnv('LLM_BEARER_TOKEN', '');
      vi.stubEnv('NODE_EXTRA_CA_CERTS', '');

      vi.doMock('fs', () => ({
        readFileSync: vi.fn().mockImplementation(() => { throw new Error('ENOENT'); }),
        existsSync: vi.fn().mockReturnValue(false),
      }));
      vi.doMock('undici', () => ({
        Agent: vi.fn(),
      }));

      const { getLlmAuthHeaders } = await import('./llm-config.js');
      expect(getLlmAuthHeaders()).toEqual({});
    });
  });

  describe('getOllamaBaseUrl', () => {
    it('should return default URL when env not set', async () => {
      vi.stubEnv('OLLAMA_BASE_URL', '');
      vi.stubEnv('NODE_EXTRA_CA_CERTS', '');

      vi.doMock('fs', () => ({
        readFileSync: vi.fn().mockImplementation(() => { throw new Error('ENOENT'); }),
        existsSync: vi.fn().mockReturnValue(false),
      }));
      vi.doMock('undici', () => ({
        Agent: vi.fn(),
      }));

      const { getOllamaBaseUrl } = await import('./llm-config.js');
      expect(getOllamaBaseUrl()).toBe('http://localhost:11434');
    });

    it('should return custom URL from env', async () => {
      vi.stubEnv('OLLAMA_BASE_URL', 'https://ollama.internal:11434');
      vi.stubEnv('NODE_EXTRA_CA_CERTS', '');

      vi.doMock('fs', () => ({
        readFileSync: vi.fn().mockImplementation(() => { throw new Error('ENOENT'); }),
        existsSync: vi.fn().mockReturnValue(false),
      }));
      vi.doMock('undici', () => ({
        Agent: vi.fn(),
      }));

      const { getOllamaBaseUrl } = await import('./llm-config.js');
      expect(getOllamaBaseUrl()).toBe('https://ollama.internal:11434');
    });
  });

  describe('buildOllamaFetch', () => {
    it('should return undefined when no custom TLS or auth needed', async () => {
      vi.stubEnv('LLM_VERIFY_SSL', 'true');
      vi.stubEnv('LLM_AUTH_TYPE', 'none');
      vi.stubEnv('NODE_EXTRA_CA_CERTS', '');

      vi.doMock('fs', () => ({
        readFileSync: vi.fn().mockImplementation(() => { throw new Error('ENOENT'); }),
        existsSync: vi.fn().mockReturnValue(false),
      }));
      vi.doMock('undici', () => ({
        Agent: vi.fn(),
      }));

      const { buildOllamaFetch } = await import('./llm-config.js');
      expect(buildOllamaFetch()).toBeUndefined();
    });

    it('should return a custom fetch when auth headers are configured', async () => {
      vi.stubEnv('LLM_VERIFY_SSL', 'true');
      vi.stubEnv('LLM_AUTH_TYPE', 'bearer');
      vi.stubEnv('LLM_BEARER_TOKEN', 'test-token');
      vi.stubEnv('NODE_EXTRA_CA_CERTS', '');

      vi.doMock('fs', () => ({
        readFileSync: vi.fn().mockImplementation(() => { throw new Error('ENOENT'); }),
        existsSync: vi.fn().mockReturnValue(false),
      }));
      vi.doMock('undici', () => ({
        Agent: vi.fn(),
      }));

      const { buildOllamaFetch } = await import('./llm-config.js');
      const customFetch = buildOllamaFetch();
      expect(customFetch).toBeDefined();
      expect(typeof customFetch).toBe('function');
    });

    it('should return a custom fetch when TLS dispatcher is configured', async () => {
      vi.stubEnv('LLM_VERIFY_SSL', 'false');
      vi.stubEnv('LLM_AUTH_TYPE', 'none');
      vi.stubEnv('NODE_EXTRA_CA_CERTS', '');

      vi.doMock('fs', () => ({
        readFileSync: vi.fn().mockImplementation(() => { throw new Error('ENOENT'); }),
        existsSync: vi.fn().mockReturnValue(false),
      }));
      vi.doMock('undici', () => ({
        Agent: vi.fn(),
      }));

      const { buildOllamaFetch } = await import('./llm-config.js');
      const customFetch = buildOllamaFetch();
      expect(customFetch).toBeDefined();
      expect(typeof customFetch).toBe('function');
    });
  });
});
