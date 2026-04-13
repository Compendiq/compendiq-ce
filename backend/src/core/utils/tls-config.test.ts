import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

/** Create a mock Agent class whose instances have a .compose() method */
function createMockAgent() {
  const composedDispatcher = { isComposed: true };
  // Use a real class so `new Agent()` works (arrow fns can't be constructors)
  const MockAgent = vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.compose = vi.fn().mockReturnValue(composedDispatcher);
  });
  return { MockAgent, composedDispatcher };
}

/** Mock redirect interceptor */
const mockRedirectInterceptor = vi.fn();

describe('tls-config', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('should create dispatcher with redirect interceptor even without custom TLS config', async () => {
    vi.stubEnv('CONFLUENCE_VERIFY_SSL', 'true');
    vi.stubEnv('NODE_EXTRA_CA_CERTS', '');

    vi.doMock('fs', () => ({
      readFileSync: vi.fn().mockImplementation(() => { throw new Error('ENOENT'); }),
      existsSync: vi.fn().mockReturnValue(false),
    }));

    const { MockAgent, composedDispatcher } = createMockAgent();
    vi.doMock('undici', () => ({
      Agent: MockAgent,
      Dispatcher: class {},
      interceptors: { redirect: mockRedirectInterceptor },
    }));

    const { confluenceDispatcher, buildConnectOptions } = await import('./tls-config.js');
    // No custom TLS, but dispatcher is always created for redirect support
    expect(confluenceDispatcher).toBe(composedDispatcher);
    expect(buildConnectOptions()).toBeUndefined();
    // Agent created without connect options
    expect(MockAgent).toHaveBeenCalledWith();
  });

  it('should create dispatcher with rejectUnauthorized false when CONFLUENCE_VERIFY_SSL is false', async () => {
    vi.stubEnv('CONFLUENCE_VERIFY_SSL', 'false');
    vi.stubEnv('NODE_EXTRA_CA_CERTS', '');

    vi.doMock('fs', () => ({
      readFileSync: vi.fn().mockImplementation(() => { throw new Error('ENOENT'); }),
      existsSync: vi.fn().mockReturnValue(false),
    }));

    const { MockAgent, composedDispatcher } = createMockAgent();
    vi.doMock('undici', () => ({
      Agent: MockAgent,
      Dispatcher: class {},
      interceptors: { redirect: mockRedirectInterceptor },
    }));

    const { confluenceDispatcher } = await import('./tls-config.js');
    expect(confluenceDispatcher).toBe(composedDispatcher);
    expect(MockAgent).toHaveBeenCalledWith({
      connect: { rejectUnauthorized: false },
    });
  });

  it('should create dispatcher with CA bundle from NODE_EXTRA_CA_CERTS', async () => {
    const fakeCert = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n';
    vi.stubEnv('CONFLUENCE_VERIFY_SSL', 'true');
    vi.stubEnv('NODE_EXTRA_CA_CERTS', '/custom/ca.pem');

    vi.doMock('fs', () => ({
      readFileSync: vi.fn().mockReturnValue(fakeCert),
      existsSync: vi.fn().mockReturnValue(false),
    }));

    const { MockAgent, composedDispatcher } = createMockAgent();
    vi.doMock('undici', () => ({
      Agent: MockAgent,
      Dispatcher: class {},
      interceptors: { redirect: mockRedirectInterceptor },
    }));

    const { confluenceDispatcher } = await import('./tls-config.js');
    expect(confluenceDispatcher).toBe(composedDispatcher);
    expect(MockAgent).toHaveBeenCalledWith({
      connect: { ca: fakeCert },
    });
  });

  it('should fall back to system CA paths when NODE_EXTRA_CA_CERTS not set', async () => {
    const fakeCert = '-----BEGIN CERTIFICATE-----\nMIIBsystem\n-----END CERTIFICATE-----\n';
    vi.stubEnv('CONFLUENCE_VERIFY_SSL', 'true');
    vi.stubEnv('NODE_EXTRA_CA_CERTS', '');

    vi.doMock('fs', () => ({
      readFileSync: vi.fn().mockReturnValue(fakeCert),
      existsSync: vi.fn().mockReturnValue(true),
    }));

    const { MockAgent, composedDispatcher } = createMockAgent();
    vi.doMock('undici', () => ({
      Agent: MockAgent,
      Dispatcher: class {},
      interceptors: { redirect: mockRedirectInterceptor },
    }));

    const { confluenceDispatcher } = await import('./tls-config.js');
    expect(confluenceDispatcher).toBe(composedDispatcher);
    expect(MockAgent).toHaveBeenCalledWith({
      connect: { ca: fakeCert },
    });
  });

  it('should report verify SSL status', async () => {
    vi.stubEnv('CONFLUENCE_VERIFY_SSL', 'true');
    vi.stubEnv('NODE_EXTRA_CA_CERTS', '');

    vi.doMock('fs', () => ({
      readFileSync: vi.fn().mockImplementation(() => { throw new Error('ENOENT'); }),
      existsSync: vi.fn().mockReturnValue(false),
    }));

    const { MockAgent } = createMockAgent();
    vi.doMock('undici', () => ({
      Agent: MockAgent,
      Dispatcher: class {},
      interceptors: { redirect: mockRedirectInterceptor },
    }));

    const { isVerifySslEnabled } = await import('./tls-config.js');
    expect(isVerifySslEnabled()).toBe(true);
  });

  it('createTlsDispatcher should always verify TLS even when CONFLUENCE_VERIFY_SSL is false', async () => {
    const fakeCert = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n';
    vi.stubEnv('CONFLUENCE_VERIFY_SSL', 'false');
    vi.stubEnv('NODE_EXTRA_CA_CERTS', '/custom/ca.pem');

    vi.doMock('fs', () => ({
      readFileSync: vi.fn().mockReturnValue(fakeCert),
      existsSync: vi.fn().mockReturnValue(false),
    }));

    const { MockAgent, composedDispatcher } = createMockAgent();
    vi.doMock('undici', () => ({
      Agent: MockAgent,
      Dispatcher: class {},
      interceptors: { redirect: mockRedirectInterceptor },
    }));

    const { createTlsDispatcher } = await import('./tls-config.js');
    const dispatcher = createTlsDispatcher();
    expect(dispatcher).toBe(composedDispatcher);

    // createTlsDispatcher creates a NEW Agent — it's the second call after the module-level one.
    // The module-level Agent uses { connect: { rejectUnauthorized: false } } because CONFLUENCE_VERIFY_SSL=false,
    // but createTlsDispatcher should use { connect: { ca: fakeCert } } (never rejectUnauthorized: false).
    const calls = MockAgent.mock.calls;
    // Last call is from createTlsDispatcher
    const lastCall = calls[calls.length - 1];
    expect(lastCall[0]).toEqual({ connect: { ca: fakeCert } });
    // It should NOT have rejectUnauthorized: false
    expect(lastCall[0]?.connect?.rejectUnauthorized).toBeUndefined();
  });

  it('createTlsDispatcher should work without CA bundle', async () => {
    vi.stubEnv('CONFLUENCE_VERIFY_SSL', 'true');
    vi.stubEnv('NODE_EXTRA_CA_CERTS', '');

    vi.doMock('fs', () => ({
      readFileSync: vi.fn().mockImplementation(() => { throw new Error('ENOENT'); }),
      existsSync: vi.fn().mockReturnValue(false),
    }));

    const { MockAgent, composedDispatcher } = createMockAgent();
    vi.doMock('undici', () => ({
      Agent: MockAgent,
      Dispatcher: class {},
      interceptors: { redirect: mockRedirectInterceptor },
    }));

    const { createTlsDispatcher } = await import('./tls-config.js');
    const dispatcher = createTlsDispatcher();
    expect(dispatcher).toBe(composedDispatcher);

    // Last Agent() call should be from createTlsDispatcher — without connect opts
    const calls = MockAgent.mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall.length === 0 || lastCall[0] === undefined).toBe(true);
  });
});

describe('TLS bypass periodic warnings', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('checkConfluenceTlsBypassWarning should log when CONFLUENCE_VERIFY_SSL=false', async () => {
    vi.stubEnv('CONFLUENCE_VERIFY_SSL', 'false');
    vi.stubEnv('NODE_EXTRA_CA_CERTS', '');

    vi.doMock('fs', () => ({
      readFileSync: vi.fn().mockImplementation(() => { throw new Error('ENOENT'); }),
      existsSync: vi.fn().mockReturnValue(false),
    }));

    const { MockAgent } = createMockAgent();
    vi.doMock('undici', () => ({
      Agent: MockAgent,
      Dispatcher: class {},
      interceptors: { redirect: mockRedirectInterceptor },
    }));

    const { logger } = await import('./logger.js');
    const { checkConfluenceTlsBypassWarning, _resetTlsWarningTimestamps } = await import('./tls-config.js');

    _resetTlsWarningTimestamps();
    checkConfluenceTlsBypassWarning();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('CONFLUENCE_VERIFY_SSL=false is still active'),
    );
  });

  it('checkConfluenceTlsBypassWarning should not log when CONFLUENCE_VERIFY_SSL=true', async () => {
    vi.stubEnv('CONFLUENCE_VERIFY_SSL', 'true');
    vi.stubEnv('NODE_EXTRA_CA_CERTS', '');

    vi.doMock('fs', () => ({
      readFileSync: vi.fn().mockImplementation(() => { throw new Error('ENOENT'); }),
      existsSync: vi.fn().mockReturnValue(false),
    }));

    const { MockAgent } = createMockAgent();
    vi.doMock('undici', () => ({
      Agent: MockAgent,
      Dispatcher: class {},
      interceptors: { redirect: mockRedirectInterceptor },
    }));

    const { logger } = await import('./logger.js');
    const warnCallsBefore = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.length;
    const { checkConfluenceTlsBypassWarning } = await import('./tls-config.js');

    checkConfluenceTlsBypassWarning();
    // No new warn calls about TLS bypass
    const warnCallsAfter = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(warnCallsAfter).toBe(warnCallsBefore);
  });

  it('checkConfluenceTlsBypassWarning should not log twice within 24h', async () => {
    vi.stubEnv('CONFLUENCE_VERIFY_SSL', 'false');
    vi.stubEnv('NODE_EXTRA_CA_CERTS', '');

    vi.doMock('fs', () => ({
      readFileSync: vi.fn().mockImplementation(() => { throw new Error('ENOENT'); }),
      existsSync: vi.fn().mockReturnValue(false),
    }));

    const { MockAgent } = createMockAgent();
    vi.doMock('undici', () => ({
      Agent: MockAgent,
      Dispatcher: class {},
      interceptors: { redirect: mockRedirectInterceptor },
    }));

    const { logger } = await import('./logger.js');
    const { checkConfluenceTlsBypassWarning, _resetTlsWarningTimestamps } = await import('./tls-config.js');

    _resetTlsWarningTimestamps();
    (logger.warn as ReturnType<typeof vi.fn>).mockClear();

    checkConfluenceTlsBypassWarning();
    checkConfluenceTlsBypassWarning(); // Second call within interval
    // Should only have been called once for the periodic warning
    const tlsWarnings = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('CONFLUENCE_VERIFY_SSL=false is still active'),
    );
    expect(tlsWarnings.length).toBe(1);
  });

  it('checkLlmTlsBypassWarning should log when LLM_VERIFY_SSL=false', async () => {
    vi.stubEnv('CONFLUENCE_VERIFY_SSL', 'true');
    vi.stubEnv('LLM_VERIFY_SSL', 'false');
    vi.stubEnv('NODE_EXTRA_CA_CERTS', '');

    vi.doMock('fs', () => ({
      readFileSync: vi.fn().mockImplementation(() => { throw new Error('ENOENT'); }),
      existsSync: vi.fn().mockReturnValue(false),
    }));

    const { MockAgent } = createMockAgent();
    vi.doMock('undici', () => ({
      Agent: MockAgent,
      Dispatcher: class {},
      interceptors: { redirect: mockRedirectInterceptor },
    }));

    const { logger } = await import('./logger.js');
    const { checkLlmTlsBypassWarning, _resetTlsWarningTimestamps } = await import('./tls-config.js');

    _resetTlsWarningTimestamps();
    checkLlmTlsBypassWarning();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('LLM_VERIFY_SSL=false is still active'),
    );
  });
});
