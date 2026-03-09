import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

describe('tls-config', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('should not create dispatcher when no CA bundle and SSL verification enabled', async () => {
    vi.stubEnv('CONFLUENCE_VERIFY_SSL', 'true');
    vi.stubEnv('NODE_EXTRA_CA_CERTS', '');

    vi.doMock('fs', () => ({
      readFileSync: vi.fn().mockImplementation(() => { throw new Error('ENOENT'); }),
      existsSync: vi.fn().mockReturnValue(false),
    }));
    vi.doMock('undici', () => ({
      Agent: vi.fn(),
    }));

    const { confluenceDispatcher, buildConnectOptions } = await import('./tls-config.js');
    expect(confluenceDispatcher).toBeUndefined();
    expect(buildConnectOptions()).toBeUndefined();
  });

  it('should create dispatcher with rejectUnauthorized false when CONFLUENCE_VERIFY_SSL is false', async () => {
    vi.stubEnv('CONFLUENCE_VERIFY_SSL', 'false');
    vi.stubEnv('NODE_EXTRA_CA_CERTS', '');

    vi.doMock('fs', () => ({
      readFileSync: vi.fn().mockImplementation(() => { throw new Error('ENOENT'); }),
      existsSync: vi.fn().mockReturnValue(false),
    }));

    const MockAgent = vi.fn();
    vi.doMock('undici', () => ({
      Agent: MockAgent,
    }));

    const { confluenceDispatcher } = await import('./tls-config.js');
    expect(confluenceDispatcher).toBeDefined();
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

    const MockAgent = vi.fn();
    vi.doMock('undici', () => ({
      Agent: MockAgent,
    }));

    const { confluenceDispatcher } = await import('./tls-config.js');
    expect(confluenceDispatcher).toBeDefined();
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

    const MockAgent = vi.fn();
    vi.doMock('undici', () => ({
      Agent: MockAgent,
    }));

    const { confluenceDispatcher } = await import('./tls-config.js');
    expect(confluenceDispatcher).toBeDefined();
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
    vi.doMock('undici', () => ({
      Agent: vi.fn(),
    }));

    const { isVerifySslEnabled } = await import('./tls-config.js');
    expect(isVerifySslEnabled()).toBe(true);
  });
});
