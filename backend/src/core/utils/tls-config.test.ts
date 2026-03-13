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
});
