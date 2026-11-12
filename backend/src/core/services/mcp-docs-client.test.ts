import { setImmediate as nextEventLoopTurn } from 'node:timers/promises';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/**
 * Fakes for the SDK client + transport. Hoisted so the counters survive the
 * per-test `vi.resetModules()` that resets the client module's connection
 * cache. The REAL `StreamableHTTPError` is re-exported through the transport
 * mock so the `instanceof` check inside the module under test is genuine.
 */
interface FakeTransport {
  url: URL;
  opts: unknown;
  closed: boolean;
  closeCalls: number;
  /** Rejects this transport's pending `connect`, like the SDK's onclose does. */
  rejectConnect?: (err: Error) => void;
}

interface FakeClient {
  connected: boolean;
  transport?: FakeTransport;
}

interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

const h = vi.hoisted(() => ({
  transportCtor: vi.fn(),
  transports: [] as Array<{
    url: URL; opts: unknown; closed: boolean; closeCalls: number; rejectConnect?: (err: Error) => void;
  }>,
  connect: vi.fn<(transport: FakeTransport, client: FakeClient) => Promise<void>>(),
  callTool: vi.fn<(params: ToolCall, client: FakeClient) => Promise<unknown>>(),
  listTools: vi.fn<(client: FakeClient) => Promise<unknown>>(),
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', async (importOriginal) => {
  const actual = await importOriginal<{ StreamableHTTPError: typeof StreamableHTTPError }>();
  class StreamableHTTPClientTransport implements FakeTransport {
    closed = false;
    closeCalls = 0;
    rejectConnect?: (err: Error) => void;
    constructor(public url: URL, public opts?: unknown) {
      h.transportCtor(url, opts);
      h.transports.push(this);
    }
    async close() {
      this.closed = true;
      this.closeCalls += 1;
      this.rejectConnect?.(new Error('MCP error -32000: Connection closed'));
    }
  }
  return { StreamableHTTPError: actual.StreamableHTTPError, StreamableHTTPClientTransport };
});

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class implements FakeClient {
    connected = false;
    transport?: FakeTransport;
    async connect(transport: FakeTransport) {
      this.transport = transport;
      await h.connect(transport, this);
      this.connected = true;
    }
    callTool(params: ToolCall) {
      return h.callTool(params, this);
    }
    listTools() {
      return h.listTools(this);
    }
  },
}));

vi.mock('./mcp-docs-settings.js', () => ({
  getMcpDocsSettings: vi.fn().mockResolvedValue({
    enabled: true,
    url: 'http://mcp-docs:3100/mcp',
  }),
}));

const TOOLS = { tools: [{ name: 'fetch_url' }, { name: 'search_web' }, { name: 'list_cached' }] };
const SEARCH_TEXT = '1. **Doc**\n   https://docs.example/a\n   snippet';
const SEARCH_RESULT = { content: [{ type: 'text', text: SEARCH_TEXT }] };
const SEARCH_PARSED = [{ title: 'Doc', url: 'https://docs.example/a', snippet: 'snippet' }];
const FETCH_RESULT = {
  content: [{ type: 'text', text: 'Title: Doc\nURL: https://docs.example/a\nContent length: 7 chars\nCached: false\n\n---\n\n# Hello' }],
};

/** What the SDK throws for a non-OK POST: `Error POSTing to endpoint: <body>`. */
function sessionLost(status: number, code: number, message: string): StreamableHTTPError {
  return new StreamableHTTPError(
    status,
    `Error POSTing to endpoint: ${JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null })}`,
  );
}
const lost404 = () => sessionLost(404, -32001, 'Session not found');

async function loadClient() {
  return import('./mcp-docs-client.js');
}

beforeEach(() => {
  // Fresh module each test so the module-level connection cache is reset and
  // the transport is reconstructed (and re-captured).
  vi.resetModules();
  h.transportCtor.mockClear();
  h.transports.length = 0;
  h.connect.mockReset().mockResolvedValue(undefined);
  h.callTool.mockReset();
  h.listTools.mockReset().mockResolvedValue(TOOLS);
});

afterEach(() => {
  delete process.env.MCP_DOCS_TOKEN;
});

describe('mcp-docs-client transport auth header', () => {
  it('sends the shared-secret header on the transport when MCP_DOCS_TOKEN is set', async () => {
    process.env.MCP_DOCS_TOKEN = 's3cret-token';
    const { testConnection } = await loadClient();

    await testConnection();

    expect(h.transportCtor).toHaveBeenCalledWith(
      expect.any(URL),
      { requestInit: { headers: { 'x-mcp-docs-token': 's3cret-token' } } },
    );
  });

  it('omits the header (requestInit undefined) when no token is set', async () => {
    const { testConnection } = await loadClient();

    await testConnection();

    expect(h.transportCtor).toHaveBeenCalledWith(expect.any(URL), { requestInit: undefined });
  });
});

describe('mcp-docs-client session recovery (#1766)', () => {
  it('searchDocumentation retries callTool exactly once on 404 after closing the dead transport and re-initializing', async () => {
    h.callTool.mockRejectedValueOnce(lost404()).mockResolvedValueOnce(SEARCH_RESULT);
    const { searchDocumentation } = await loadClient();

    await expect(searchDocumentation('vitest retry', 'u1', 2)).resolves.toEqual(SEARCH_PARSED);

    expect(h.callTool).toHaveBeenCalledTimes(2);
    const expectedArgs = { name: 'search_web', arguments: { query: 'vitest retry', num_results: 2, user_id: 'u1' } };
    expect(h.callTool.mock.calls[0]![0]).toEqual(expectedArgs);
    expect(h.callTool.mock.calls[1]![0]).toEqual(expectedArgs);
    // Only the keyword query crosses the boundary — nothing is added on retry.
    expect(Object.keys(h.callTool.mock.calls[1]![0].arguments)).toEqual(['query', 'num_results', 'user_id']);
    // Fresh initialize on a fresh transport; the dead one was closed.
    expect(h.connect).toHaveBeenCalledTimes(2);
    expect(h.transports).toHaveLength(2);
    expect(h.transports[0]!.closed).toBe(true);
    expect(h.transports[1]!.closed).toBe(false);
    expect(h.callTool.mock.calls[1]![1]).not.toBe(h.callTool.mock.calls[0]![1]);
  });

  it('fetchDocumentation retries callTool exactly once on 400 (sidecar before #1766) with the identical URL-only arguments', async () => {
    h.callTool.mockRejectedValueOnce(sessionLost(400, -32000, 'Invalid or missing session')).mockResolvedValueOnce(FETCH_RESULT);
    const { fetchDocumentation } = await loadClient();

    const doc = await fetchDocumentation('https://docs.example/a', 'u1');

    expect(doc).toMatchObject({ title: 'Doc', url: 'https://docs.example/a', markdown: '# Hello', contentLength: 7, cached: false });
    expect(h.callTool).toHaveBeenCalledTimes(2);
    const expectedArgs = { name: 'fetch_url', arguments: { url: 'https://docs.example/a', max_length: 10_000, user_id: 'u1' } };
    expect(h.callTool.mock.calls[0]![0]).toEqual(expectedArgs);
    expect(h.callTool.mock.calls[1]![0]).toEqual(expectedArgs);
    expect(Object.keys(h.callTool.mock.calls[1]![0].arguments)).toEqual(['url', 'max_length', 'user_id']);
    expect(h.connect).toHaveBeenCalledTimes(2);
    expect(h.transports).toHaveLength(2);
    expect(h.transports[0]!.closed).toBe(true);
    expect(h.transports[1]!.closed).toBe(false);
  });

  it('testConnection retries listTools exactly once on 404 and reports the tools', async () => {
    h.listTools.mockRejectedValueOnce(lost404()).mockResolvedValueOnce(TOOLS);
    const { testConnection } = await loadClient();

    await expect(testConnection()).resolves.toEqual({ ok: true, tools: ['fetch_url', 'search_web', 'list_cached'] });

    expect(h.listTools).toHaveBeenCalledTimes(2);
    expect(h.connect).toHaveBeenCalledTimes(2);
    expect(h.transports).toHaveLength(2);
    expect(h.transports[0]!.closed).toBe(true);
    expect(h.transports[1]!.closed).toBe(false);
  });

  it('testConnection retries listTools exactly once on 400', async () => {
    h.listTools.mockRejectedValueOnce(sessionLost(400, -32000, 'Invalid or missing session')).mockResolvedValueOnce(TOOLS);
    const { testConnection } = await loadClient();

    await expect(testConnection()).resolves.toEqual({ ok: true, tools: ['fetch_url', 'search_web', 'list_cached'] });

    expect(h.listTools).toHaveBeenCalledTimes(2);
    expect(h.connect).toHaveBeenCalledTimes(2);
  });

  it('never retries a tool-level isError result (SearXNG unavailable): one request, no reconnect', async () => {
    h.callTool.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Error: search backend unavailable: SearXNG returned 503' }],
      isError: true,
    });
    const { searchDocumentation } = await loadClient();

    await expect(searchDocumentation('vitest no retry', 'u1', 2)).rejects.toThrow('search backend unavailable: SearXNG returned 503');

    expect(h.callTool).toHaveBeenCalledTimes(1);
    expect(h.connect).toHaveBeenCalledTimes(1);
    expect(h.transports).toHaveLength(1);
    expect(h.transports[0]!.closed).toBe(false);
  });

  it('never retries other transport failures (500, fetch failed): the original error propagates once', async () => {
    const serverError = new StreamableHTTPError(500, 'Error POSTing to endpoint: boom');
    h.callTool.mockRejectedValueOnce(serverError);
    const { fetchDocumentation, searchDocumentation } = await loadClient();

    await expect(fetchDocumentation('https://docs.example/a', 'u1')).rejects.toBe(serverError);
    expect(h.callTool).toHaveBeenCalledTimes(1);

    const networkError = new TypeError('fetch failed');
    h.callTool.mockRejectedValueOnce(networkError);
    await expect(searchDocumentation('vitest down', 'u1', 2)).rejects.toBe(networkError);

    expect(h.callTool).toHaveBeenCalledTimes(2);
    expect(h.connect).toHaveBeenCalledTimes(1);
    expect(h.transports).toHaveLength(1);
    expect(h.transports[0]!.closed).toBe(false);
  });

  it('gives up after one retry when the fresh session is lost too, leaving no cached connection', async () => {
    const second = sessionLost(400, -32000, 'Invalid or missing session');
    h.callTool.mockRejectedValueOnce(lost404()).mockRejectedValueOnce(second);
    const { searchDocumentation } = await loadClient();

    await expect(searchDocumentation('vitest twice', 'u1', 2)).rejects.toBe(second);

    expect(h.callTool).toHaveBeenCalledTimes(2);
    expect(h.connect).toHaveBeenCalledTimes(2);
    expect(h.transports).toHaveLength(2);
    expect(h.transports[0]!.closed).toBe(true);
    expect(h.transports[1]!.closed).toBe(true);
  });

  it('concurrent first calls share one in-flight connect and all get a connected client', async () => {
    // A client that is handed out before `connect` resolved has no session id
    // yet; the sidecar answers its POST with 400 (the SDK transport throws).
    h.listTools.mockImplementation(async (client) => {
      if (!client.connected) {
        throw sessionLost(400, -32000, 'Bad Request: Mcp-Session-Id header is required');
      }
      return TOOLS;
    });
    const pendingConnects: Array<() => void> = [];
    h.connect.mockImplementation((transport) => {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      transport.rejectConnect = reject;
      pendingConnects.push(resolve);
      return promise;
    });
    const { testConnection } = await loadClient();

    const calls = Promise.all([testConnection(), testConnection(), testConnection()]);
    await vi.waitFor(() => expect(h.connect).toHaveBeenCalled());
    // Let every caller reach its connect decision before any connect resolves.
    await nextEventLoopTurn();
    for (const resolve of pendingConnects) resolve();

    const results = await calls;
    expect(results).toEqual([
      { ok: true, tools: ['fetch_url', 'search_web', 'list_cached'] },
      { ok: true, tools: ['fetch_url', 'search_web', 'list_cached'] },
      { ok: true, tools: ['fetch_url', 'search_web', 'list_cached'] },
    ]);
    expect(h.connect).toHaveBeenCalledTimes(1);
    expect(h.transports).toHaveLength(1);
    expect(h.transports[0]!.closed).toBe(false);
  });

  it('concurrent calls on one lost session reconnect once and leak no transport', async () => {
    h.callTool
      .mockRejectedValueOnce(lost404())
      .mockRejectedValueOnce(lost404())
      .mockResolvedValue(SEARCH_RESULT);
    const { searchDocumentation } = await loadClient();

    const results = await Promise.all([
      searchDocumentation('vitest concurrent', 'u1', 2),
      searchDocumentation('vitest concurrent', 'u1', 2),
    ]);

    expect(results).toEqual([SEARCH_PARSED, SEARCH_PARSED]);
    expect(h.callTool).toHaveBeenCalledTimes(4);
    expect(h.connect).toHaveBeenCalledTimes(2);
    expect(h.transports).toHaveLength(2);
    expect(h.transports[0]!.closed).toBe(true);
    expect(h.transports[0]!.closeCalls).toBe(1);
    expect(h.transports[1]!.closed).toBe(false);
    // Exactly one live transport remains: constructed − closed === 1.
    expect(h.transports.filter((t) => !t.closed)).toHaveLength(1);
  });
});
