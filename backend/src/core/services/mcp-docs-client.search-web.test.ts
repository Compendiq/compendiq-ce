/**
 * #1767 — the backend half of "a contract-accepted searchQuery reaches
 * search_web": `searchDocumentation` forwards the query verbatim as the tool's
 * `query` argument and parses the sidecar's numbered result text. The result
 * text below is byte-for-byte what mcp-docs/src/index.ts emits for two
 * results (`${i + 1}. **${title}**\n   ${url}\n   ${snippet}` joined by blank
 * lines); the isError text is the sidecar's own -32602 refusal of a 201-char
 * query, the failure the contract now prevents.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { callTool } = vi.hoisted(() => ({ callTool: vi.fn() }));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    close() {}
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    async connect() {}
    async close() {}
    async listTools() {
      return { tools: [] };
    }
    callTool(...args: unknown[]) {
      return callTool(...args);
    }
  },
}));

vi.mock('./mcp-docs-settings.js', () => ({
  getMcpDocsSettings: vi.fn().mockResolvedValue({
    enabled: true,
    url: 'http://mcp-docs:3100/mcp',
  }),
}));

const QUERY_200 = 'kubernetes scaling '.repeat(10) + 'autoscaler';

describe('searchDocumentation — search_web call and result parsing (#1767)', () => {
  beforeEach(() => {
    // The client caches its connection at module level; each test resets the
    // registry and imports the module afresh (dynamic import on purpose —
    // same seam as mcp-docs-client.test.ts), so no cached Client leaks across.
    vi.resetModules();
    callTool.mockReset();
  });

  it('calls search_web with the query verbatim and parses the sidecar\'s numbered results', async () => {
    expect(QUERY_200).toHaveLength(200);
    callTool.mockResolvedValue({
      content: [{
        type: 'text',
        text: '1. **R1**\n   https://example.test/1\n   S1\n\n2. **R2**\n   https://example.test/2\n   S2',
      }],
    });
    const { searchDocumentation } = await import('./mcp-docs-client.js');

    const results = await searchDocumentation(QUERY_200, 'user-1', 5);

    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledWith({
      name: 'search_web',
      arguments: { query: QUERY_200, num_results: 5, user_id: 'user-1' },
    });
    expect(results).toEqual([
      { title: 'R1', url: 'https://example.test/1', snippet: 'S1' },
      { title: 'R2', url: 'https://example.test/2', snippet: 'S2' },
    ]);
  });

  it('throws the sidecar\'s isError text (the -32602 path the contract now prevents)', async () => {
    callTool.mockResolvedValue({
      isError: true,
      content: [{
        type: 'text',
        text: 'MCP error -32602: Input validation error: Invalid arguments for tool search_web: Too big: expected string to have <=200 characters at query',
      }],
    });
    const { searchDocumentation } = await import('./mcp-docs-client.js');

    await expect(searchDocumentation(`${QUERY_200}s`, 'user-1', 5))
      .rejects.toThrow(/Too big: expected string to have <=200 characters at query/);
  });
});
