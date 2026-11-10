import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Shared sidecar search-limits test: boots the real sidecar from this
 * worktree's source against a loopback SearXNG and drives `search_web` through
 * the MCP SDK client.
 *
 * The numbers below are LITERAL on purpose. The sidecar does not depend on
 * `@compendiq/contracts`, whose `SEARXNG_MAX_RESULTS_{MIN,MAX,DEFAULT}` the
 * admin API and UI use (#1768); `packages/contracts/src/schemas/searxng.test.ts`
 * pins the same literals there. Change the sidecar limit and this file goes
 * red; change the contract and that one does — neither side can drift alone.
 */

const redisUrl = process.env.MCP_DOCS_TEST_REDIS_URL;
if (!redisUrl) {
  throw new Error('MCP_DOCS_TEST_REDIS_URL must point to real Redis for the search_web limits test');
}

const mcpDocsDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'search-web-limits-token';
const FAKE_RESULT_COUNT = 12; // more than the maximum, so a 10-wide request is a visible slice

// A real child process and a real socket are involved, so readiness and
// shutdown below are polled against the wall clock on purpose: fake timers
// cannot advance another process.

async function freePort(): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const probe = createNetServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const address = probe.address();
    if (!address || typeof address === 'string') {
      probe.close();
      reject(new Error('Loopback probe did not bind'));
      return;
    }
    const { port } = address;
    probe.close((err) => (err ? reject(err) : resolve(port)));
  });
  return promise;
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms).unref();
  return promise;
}

async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      const body = (await response.json()) as { status?: string };
      if (body.status === 'ok') return;
    } catch {
      // not listening yet
    }
    await sleep(100);
  }
  throw new Error(`mcp-docs did not report /health ok within ${timeoutMs} ms`);
}

/** Spawns `src/index.ts` on a free loopback port; retries a lost port race. */
async function startSidecar(searxngUrl: string): Promise<{ child: ChildProcess; baseUrl: string }> {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: mcpDocsDir,
      env: {
        ...process.env,
        PORT: String(port),
        MCP_DOCS_HOST: '127.0.0.1',
        REDIS_URL: redisUrl,
        SEARXNG_URL: searxngUrl,
        MCP_DOCS_TOKEN: TOKEN,
        NODE_ENV: 'production',
        LOG_LEVEL: 'warn',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    const gone = Promise.withResolvers<never>();
    child.once('exit', (code, signal) => gone.reject(new Error(`mcp-docs exited early (code ${code}, signal ${signal})`)));
    child.once('error', (err) => gone.reject(new Error(`mcp-docs could not be spawned: ${err.message}`)));
    gone.promise.catch(() => {}); // observed through Promise.race below; never unhandled
    try {
      await Promise.race([waitForHealth(baseUrl, 30_000), gone.promise]);
      return { child, baseUrl };
    } catch (err) {
      lastError = new Error(`${err instanceof Error ? err.message : String(err)} (attempt ${attempt})\n--- mcp-docs output ---\n${output}`);
      child.kill('SIGKILL');
    }
  }
  throw lastError ?? new Error('mcp-docs did not start');
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = Promise.withResolvers<void>();
  child.once('exit', () => exited.resolve());
  child.kill('SIGTERM');
  await Promise.race([exited.promise, sleep(5_000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

describe('search_web result-width limits against the running sidecar (#1768)', () => {
  const searxngQueries: string[] = [];
  let searxng: Server;
  let child: ChildProcess;
  let transport: StreamableHTTPClientTransport;
  let client: Client;

  beforeAll(async () => {
    searxng = createServer((request, response) => {
      searxngQueries.push(new URL(request.url ?? '/', 'http://localhost').searchParams.get('q') ?? '');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        results: Array.from({ length: FAKE_RESULT_COUNT }, (_, index) => ({
          title: `Result ${index + 1}`,
          url: `https://example.test/${index + 1}`,
          content: `Snippet ${index + 1}`,
        })),
      }));
    });
    const listening = Promise.withResolvers<void>();
    searxng.listen(0, '127.0.0.1', listening.resolve);
    await listening.promise;
    const address = searxng.address();
    if (!address || typeof address === 'string') throw new Error('Loopback SearXNG did not bind');

    const started = await startSidecar(`http://127.0.0.1:${address.port}`);
    child = started.child;
    transport = new StreamableHTTPClientTransport(new URL(`${started.baseUrl}/mcp`), {
      requestInit: { headers: { 'x-mcp-docs-token': TOKEN } },
    });
    client = new Client({ name: 'search-web-limits-test', version: '0' });
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    await transport?.terminateSession().catch(() => {});
    await client?.close().catch(() => {});
    if (child) await stopChild(child);
    if (searxng?.listening) {
      const closed = Promise.withResolvers<void>();
      searxng.close(() => closed.resolve());
      await closed.promise;
    }
  });

  /** One `search_web` call with a fresh query, so the Redis search cache (query + width) can never answer. */
  async function search(args: { num_results?: number }) {
    const query = `limits ${randomUUID()}`;
    const result = await client.callTool({
      name: 'search_web',
      arguments: { query, user_id: 'limits-test', ...args },
    });
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
    return {
      isError: result.isError === true,
      text,
      results: (text.match(/^\d+\. \*\*/gm) ?? []).length,
      searxngRequests: searxngQueries.filter((q) => q === query).length,
    };
  }

  it('accepts num_results 10 (the maximum) and returns exactly 10 results', async () => {
    const outcome = await search({ num_results: 10 });
    expect(outcome.isError).toBe(false);
    expect(outcome.results).toBe(10);
    expect(outcome.searxngRequests).toBe(1);
  });

  it('accepts num_results 1 (the minimum)', async () => {
    const outcome = await search({ num_results: 1 });
    expect(outcome.isError).toBe(false);
    expect(outcome.results).toBe(1);
  });

  it('defaults to 5 results when num_results is omitted', async () => {
    const outcome = await search({});
    expect(outcome.isError).toBe(false);
    expect(outcome.results).toBe(5);
  });

  it.each([11, 15])('rejects num_results %i as an isError result naming the <=10 bound, without calling SearXNG', async (numResults) => {
    const outcome = await search({ num_results: numResults });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toMatch(/MCP error -32602/);
    expect(outcome.text).toMatch(/Too big: expected number to be <=10 at num_results/);
    expect(outcome.searxngRequests).toBe(0);
  });

  it('rejects num_results 0 with the >=1 bound, without calling SearXNG', async () => {
    const outcome = await search({ num_results: 0 });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toMatch(/Too small: expected number to be >=1 at num_results/);
    expect(outcome.searxngRequests).toBe(0);
  });
});
