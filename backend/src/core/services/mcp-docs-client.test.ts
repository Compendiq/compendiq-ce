import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Capture the transport constructor args so we can assert the auth header.
const { transportCtor } = vi.hoisted(() => ({ transportCtor: vi.fn() }));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    constructor(url: URL, opts?: unknown) {
      transportCtor(url, opts);
    }
    close() {}
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    async connect() {}
    async listTools() {
      return { tools: [] };
    }
  },
}));

vi.mock('./mcp-docs-settings.js', () => ({
  getMcpDocsSettings: vi.fn().mockResolvedValue({
    enabled: true,
    url: 'http://mcp-docs:3100/mcp',
  }),
}));

describe('mcp-docs-client transport auth header', () => {
  beforeEach(() => {
    // Fresh module each test so the module-level connection cache is reset and
    // the transport is reconstructed (and re-captured).
    vi.resetModules();
    transportCtor.mockClear();
  });

  afterEach(() => {
    delete process.env.MCP_DOCS_TOKEN;
  });

  it('sends the shared-secret header on the transport when MCP_DOCS_TOKEN is set', async () => {
    process.env.MCP_DOCS_TOKEN = 's3cret-token';
    const { testConnection } = await import('./mcp-docs-client.js');

    await testConnection();

    expect(transportCtor).toHaveBeenCalledWith(
      expect.any(URL),
      { requestInit: { headers: { 'x-mcp-docs-token': 's3cret-token' } } },
    );
  });

  it('omits the header (requestInit undefined) when no token is set', async () => {
    const { testConnection } = await import('./mcp-docs-client.js');

    await testConnection();

    expect(transportCtor).toHaveBeenCalledWith(expect.any(URL), { requestInit: undefined });
  });
});
