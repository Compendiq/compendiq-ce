import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * #1769 — the admin MCP Docs / SearXNG settings travel to the sidecar as tool
 * arguments. The SDK client is the boundary: `callTool` records exactly what
 * would cross to the sidecar; the real transport class is replaced so no
 * socket is opened. `mcp-docs-client.test.ts` owns connection handling.
 */
interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

const h = vi.hoisted(() => ({
  callTool: vi.fn<(call: ToolCall) => Promise<unknown>>(),
  settings: {
    enabled: true,
    url: 'http://mcp-docs:3100/mcp',
    domainMode: 'blocklist',
    allowedDomains: ['*'],
    blockedDomains: [] as string[],
    cacheTtl: 3600,
    maxContentLength: 50_000,
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  StreamableHTTPClientTransport: class {
    async close() {}
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    async connect() {}
    callTool(call: ToolCall) {
      return h.callTool(call);
    }
  },
}));

vi.mock('./mcp-docs-settings.js', () => ({
  getMcpDocsSettings: async () => ({ ...h.settings }),
}));

import { fetchDocumentation, searchDocumentation } from './mcp-docs-client.js';

const FETCH_RESULT = {
  content: [{ type: 'text', text: 'Title: Doc\nURL: https://docs.example/a\nContent length: 7 chars\nCached: false\n\n---\n\n# Hello' }],
};
const SEARCH_RESULT = { content: [{ type: 'text', text: '1. **Doc**\n   https://docs.example/a\n   snippet' }] };

function sentArguments(): Record<string, unknown> {
  return h.callTool.mock.calls[0]![0].arguments;
}

beforeEach(() => {
  h.callTool.mockReset();
  h.settings.cacheTtl = 3600;
  h.settings.maxContentLength = 50_000;
});

describe('fetchDocumentation — admin MCP Docs settings travel as fetch_url arguments (#1769)', () => {
  beforeEach(() => {
    h.callTool.mockResolvedValue(FETCH_RESULT);
  });

  it.each([
    // caller's maxLength, admin Max Content Length, max_length sent
    [5000, 50_000, 5000], // web search at the default ceiling
    [2000, 50_000, 2000], // test-fetch at the default ceiling
    [undefined, 50_000, 10_000], // external URL (no explicit length) at the default ceiling
    [5000, 1000, 1000],
    [2000, 1000, 1000],
    [undefined, 1000, 1000],
    [80_000, 100_000, 80_000],
    [5000, 5000, 5000],
  ])('a caller asking for %s under a ceiling of %i sends max_length %i', async (requested, ceiling, expected) => {
    h.settings.maxContentLength = ceiling;

    await fetchDocumentation('https://docs.example/a', 'u1', requested);

    expect(sentArguments().max_length).toBe(expected);
  });

  it.each([60, 3600, 7200])('sends the admin Cache TTL %i as cache_ttl', async (cacheTtl) => {
    h.settings.cacheTtl = cacheTtl;

    await fetchDocumentation('https://docs.example/a', 'u1', 2000);

    expect(sentArguments().cache_ttl).toBe(cacheTtl);
  });

  it('sends only the URL, the two settings-derived numbers and the user id — no content', async () => {
    await fetchDocumentation('https://docs.example/a', 'u1', 2000);

    expect(h.callTool).toHaveBeenCalledWith({
      name: 'fetch_url',
      arguments: { url: 'https://docs.example/a', max_length: 2000, user_id: 'u1', cache_ttl: 3600 },
    });
  });
});

describe('searchDocumentation — categories travel as a search_web argument (#1769)', () => {
  beforeEach(() => {
    h.callTool.mockResolvedValue(SEARCH_RESULT);
  });

  it.each(['it', 'general,it'])('sends categories %j verbatim', async (categories) => {
    await searchDocumentation('kubernetes scaling', 'u1', 3, categories);

    expect(h.callTool).toHaveBeenCalledWith({
      name: 'search_web',
      arguments: { query: 'kubernetes scaling', num_results: 3, user_id: 'u1', categories },
    });
  });

  it('omits the argument when the caller passes no categories (the sidecar then searches its default)', async () => {
    await searchDocumentation('kubernetes scaling', 'u1', 3);

    expect(Object.keys(sentArguments())).toEqual(['query', 'num_results', 'user_id']);
  });
});
