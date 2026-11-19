import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpApp, type McpApp } from './app.js';
import { makeMcpAuth, MCP_AUTH_HEADER } from './auth.js';

/**
 * Session handling of the /mcp endpoint (issue #1766).
 *
 * MCP spec 2025-06-18 (Session Management, items 3–4): a request carrying a
 * session ID the server no longer knows MUST get HTTP 404, and the client MUST
 * then re-initialize. The SDK's own transport answers with
 * `404 {"jsonrpc":"2.0","error":{"code":-32001,"message":"Session not found"},"id":null}`
 * (webStandardStreamableHttp.js validateSession); the sidecar routes unknown
 * ids itself, so it must produce the same shape — on POST, GET and DELETE —
 * while the shared-secret guard keeps running first.
 */

const TOKEN = 't0ken';
const SESSION_NOT_FOUND = {
  jsonrpc: '2.0',
  error: { code: -32001, message: 'Session not found' },
  id: null,
};
const SESSION_ID_REQUIRED = {
  jsonrpc: '2.0',
  error: { code: -32000, message: 'Bad Request: Mcp-Session-Id header is required' },
  id: null,
};
const TOOLS_LIST = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

let mcpApp: McpApp | undefined;
let server: Server | undefined;
let transport: StreamableHTTPClientTransport | undefined;
let baseUrl = '';

async function boot(sessionTtlMs = 60_000): Promise<void> {
  mcpApp = createMcpApp({
    mcpAuth: makeMcpAuth(TOKEN, true),
    createMcpServer: () => new McpServer({ name: 'app-test', version: '0.0.0' }),
    redisStatus: () => 'disconnected',
    sessionTtlMs,
  });
  const { promise, resolve } = Promise.withResolvers<void>();
  server = mcpApp.app.listen(0, '127.0.0.1', resolve);
  await promise;
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('app did not bind');
  baseUrl = `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await transport?.close();
  transport = undefined;
  await mcpApp?.close();
  mcpApp = undefined;
  if (server?.listening) {
    const { promise, resolve } = Promise.withResolvers<void>();
    server.close(() => resolve());
    await promise;
  }
  server = undefined;
});

function mcpRequest(
  method: 'POST' | 'GET' | 'DELETE',
  opts: { token?: string; sessionId?: string; body?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    [MCP_AUTH_HEADER]: opts.token ?? TOKEN,
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
  };
  if (opts.sessionId) headers['mcp-session-id'] = opts.sessionId;
  return fetch(`${baseUrl}/mcp`, {
    method,
    headers,
    body: method === 'POST' ? (opts.body ?? TOOLS_LIST) : undefined,
  });
}

async function health(): Promise<{ status: string; redis: string; sessions: number }> {
  const res = await fetch(`${baseUrl}/health`);
  return res.json() as Promise<{ status: string; redis: string; sessions: number }>;
}

/** Open a real SDK session against the app and return its id. */
async function openSession(): Promise<string> {
  transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { [MCP_AUTH_HEADER]: TOKEN } },
  });
  const client = new Client({ name: 'app-test-client', version: '0.0.0' });
  await client.connect(transport);
  const sessionId = transport.sessionId;
  if (!sessionId) throw new Error('initialize did not assign a session id');
  return sessionId;
}

// Real clock on purpose: the reaper is a setInterval inside the app under test
// and the condition is observed over real HTTP, so fake timers cannot drive it.
async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

describe('/mcp unknown session → 404 Session not found (#1766)', () => {
  it('POST with an unknown mcp-session-id returns 404 with the SDK JSON-RPC shape', async () => {
    await boot();
    const res = await mcpRequest('POST', { sessionId: 'does-not-exist' });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(await res.json()).toEqual(SESSION_NOT_FOUND);
  });

  it('GET with an unknown mcp-session-id returns 404 with the SDK JSON-RPC shape', async () => {
    await boot();
    const res = await mcpRequest('GET', { sessionId: 'does-not-exist' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(SESSION_NOT_FOUND);
  });

  it('DELETE with an unknown mcp-session-id returns 404 with the SDK JSON-RPC shape', async () => {
    await boot();
    const res = await mcpRequest('DELETE', { sessionId: 'does-not-exist' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(SESSION_NOT_FOUND);
  });

  it('the shared-secret guard still runs first: wrong token + unknown session → 401, never 404', async () => {
    await boot();
    for (const method of ['POST', 'GET', 'DELETE'] as const) {
      const res = await mcpRequest(method, { token: 'wrong', sessionId: 'does-not-exist' });
      expect(res.status, method).toBe(401);
      expect(await res.json(), method).toEqual({ error: 'Unauthorized' });
    }
  });

  it('POST without a session id that is not an initialize request stays 400', async () => {
    await boot();
    const res = await mcpRequest('POST');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(SESSION_ID_REQUIRED);
  });

  it('a terminated session is unknown afterwards: initialize → ping → DELETE → 404', async () => {
    await boot();
    const sessionId = await openSession();
    expect((await health()).sessions).toBe(1);

    const ping = await mcpRequest('POST', {
      sessionId,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
    });
    expect(ping.status).toBe(200);
    await ping.body?.cancel();

    await transport!.terminateSession();
    expect((await health()).sessions).toBe(0);

    const afterDelete = await mcpRequest('POST', { sessionId });
    expect(afterDelete.status).toBe(404);
    expect(await afterDelete.json()).toEqual(SESSION_NOT_FOUND);
  });

  it('an idle-evicted session is unknown afterwards on POST and GET', async () => {
    await boot(200);
    const sessionId = await openSession();
    expect((await health()).sessions).toBe(1);

    await waitFor(async () => (await health()).sessions === 0, 5_000, 'idle eviction');

    const post = await mcpRequest('POST', { sessionId });
    expect(post.status).toBe(404);
    expect(await post.json()).toEqual(SESSION_NOT_FOUND);

    const get = await mcpRequest('GET', { sessionId });
    expect(get.status).toBe(404);
    expect(await get.json()).toEqual(SESSION_NOT_FOUND);
  });

  it('/health reports redis state and session count without advertising the framework', async () => {
    await boot();
    const res = await fetch(`${baseUrl}/health`);
    expect(res.headers.get('x-powered-by')).toBeNull();
    expect(await res.json()).toEqual({ status: 'ok', redis: 'disconnected', sessions: 0 });
  });
});
