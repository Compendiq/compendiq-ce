import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Epic #1903 validation for #1766: the backend MCP client against the REAL
 * mcp-docs sidecar (spawned from this worktree's `mcp-docs/src`) and a fake
 * SearXNG, through (a) idle-session eviction and (b) a sidecar restart. After
 * each, the next `/test` (`testConnection`) and the next web search must
 * succeed in the same backend process, and the fake SearXNG's request counter
 * proves the recovery never doubles outbound traffic.
 *
 * Deliberate network requirement: `mcp-docs` has its own lockfile and is not a
 * root npm workspace, so this file installs the sidecar's PRODUCTION
 * dependencies into a temp dir (`npm ci --omit=dev`, the Dockerfile's prod-deps
 * command) before spawning it with the root-installed `tsx`. `--prefer-offline`
 * makes a warm npm cache sufficient; a cold, offline cache fails this file
 * loudly. There is no skip path: a skipped Redis/sidecar test counts as not
 * run (docs/claude/content-pipeline.md → MCP Sidecar Sessions).
 *
 * CI: runs in the `Tests` job (`npm test -w backend`), which has network and
 * Redis; no workflow file needs the sidecar's dependencies.
 */

const TOKEN = 'integration-token';
const backendDir = fileURLToPath(new URL('../../..', import.meta.url));
const mcpDocsDir = resolve(backendDir, '..', 'mcp-docs');

const settings = vi.hoisted(() => ({ url: '' }));

vi.mock('./mcp-docs-settings.js', () => ({
  getMcpDocsSettings: async () => ({
    enabled: true,
    url: settings.url,
    domainMode: 'blocklist',
    allowedDomains: ['*'],
    blockedDomains: [],
    cacheTtl: 3600,
    maxContentLength: 50_000,
  }),
}));

// Keeps the LLM route graph out of this file; the saved settings are #1768's / #1769's concern.
vi.mock('../../routes/llm/_helpers.js', () => ({
  getSearxngSettings: async () => ({ maxResults: 3, categories: 'general' }),
}));

import { searchDocumentation, testConnection } from './mcp-docs-client.js';
import { fetchWebSources } from '../../routes/llm/_web-search-helper.js';

// ── Fake SearXNG ─────────────────────────────────────────────────────────

interface SearchHit { q: string | null; format: string | null; categories: string | null }

let fake: Server | undefined;
let fakeUrl = '';
let fakeMode: 'ok' | 'unavailable' = 'ok';
const searches: SearchHit[] = [];
let docHits = 0;

async function startFakeSearxng(): Promise<void> {
  fake = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    if (url.pathname === '/search') {
      searches.push({
        q: url.searchParams.get('q'),
        format: url.searchParams.get('format'),
        categories: url.searchParams.get('categories'),
      });
      if (fakeMode === 'unavailable') {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        results: [1, 2, 3].map((n) => ({
          title: `Doc ${n}`,
          url: `${fakeUrl}/doc/${n}`,
          content: `snippet ${n}`,
        })),
      }));
      return;
    }
    if (url.pathname.startsWith('/doc/')) {
      docHits += 1;
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body><p>doc</p></body></html>');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const { promise, resolve: listening } = Promise.withResolvers<void>();
  fake.listen(0, '127.0.0.1', listening);
  await promise;
  const address = fake.address();
  if (!address || typeof address === 'string') throw new Error('fake SearXNG did not bind');
  fakeUrl = `http://127.0.0.1:${address.port}`;
}

// ── Real sidecar process ─────────────────────────────────────────────────

let sidecarDir = '';
let sidecarPort = 0;
let sidecar: ChildProcess | undefined;
let sidecarOutput = '';

function prepareSidecar(): void {
  sidecarDir = mkdtempSync(join(tmpdir(), 'mcp-docs-1766-'));
  for (const file of ['package.json', 'package-lock.json']) {
    cpSync(join(mcpDocsDir, file), join(sidecarDir, file));
  }
  cpSync(join(mcpDocsDir, 'src'), join(sidecarDir, 'src'), { recursive: true });
  try {
    execFileSync(
      'npm',
      ['ci', '--ignore-scripts', '--omit=dev', '--prefer-offline', '--no-audit', '--no-fund', '--loglevel=error'],
      // Strictly below the beforeAll budget (240 s) so a slow install surfaces as the explicit error below,
      // never as a generic hook timeout; the remaining 60 s cover the fake SearXNG and the ≤30 s sidecar readiness.
      { cwd: sidecarDir, stdio: 'pipe', timeout: 180_000 },
    );
  } catch (err) {
    const detail = err instanceof Error && 'stderr' in err ? String(err.stderr) : String(err);
    throw new Error(`npm ci for the mcp-docs sidecar failed (network/npm cache required): ${detail}`);
  }
}

async function freePort(): Promise<number> {
  const probe = createTcpServer();
  const { promise, resolve: listening } = Promise.withResolvers<void>();
  probe.listen(0, '127.0.0.1', listening);
  await promise;
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('port probe did not bind');
  const { promise: closed, resolve: onClosed } = Promise.withResolvers<void>();
  probe.close(() => onClosed());
  await closed;
  return address.port;
}

async function health(): Promise<{ status: string; redis: string; sessions: number }> {
  const res = await fetch(`http://127.0.0.1:${sidecarPort}/health`);
  return res.json() as Promise<{ status: string; redis: string; sessions: number }>;
}

async function startSidecar(env: Record<string, string> = {}): Promise<void> {
  sidecarOutput = '';
  const child = spawn(process.execPath, ['--import', 'tsx', join(sidecarDir, 'src', 'index.ts')], {
    cwd: backendDir,
    env: {
      ...process.env,
      PORT: String(sidecarPort),
      MCP_DOCS_HOST: '127.0.0.1',
      REDIS_URL: process.env.REDIS_URL!,
      SEARXNG_URL: fakeUrl,
      MCP_DOCS_TOKEN: TOKEN,
      // Like the container: fails closed on the token and uses plain pino (no pino-pretty in prod deps).
      NODE_ENV: 'production',
      LOG_LEVEL: 'warn',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => { sidecarOutput += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer) => { sidecarOutput += chunk.toString(); });
  sidecar = child;

  const { promise: exited, resolve: onExit } = Promise.withResolvers<string>();
  child.once('error', (err) => onExit(`spawn error: ${err.message}`));
  child.once('exit', (code, signal) => onExit(`exited early (code ${code}, signal ${signal})`));

  // Real clock: readiness of a separate OS process can only be observed by polling.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const early = await Promise.race([exited, sleep(100).then(() => null)]);
    if (early) throw new Error(`mcp-docs sidecar ${early}\n${sidecarOutput}`);
    try {
      const status = await health();
      if (status.status === 'ok' && status.redis === 'connected') return;
      if (status.status === 'ok') {
        throw new Error(`mcp-docs sidecar cannot reach Redis at ${process.env.REDIS_URL} (health: ${JSON.stringify(status)}); this validation requires a real Redis`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('mcp-docs sidecar')) throw err;
      // not listening yet
    }
  }
  throw new Error(`mcp-docs sidecar did not become healthy within 30s\n${sidecarOutput}`);
}

async function stopSidecar(): Promise<void> {
  const child = sidecar;
  sidecar = undefined;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await Promise.race([exited, sleep(5_000).then(() => child.kill('SIGKILL'))]);
  await exited;
}

// Real clock: the reaper is a timer inside another process.
async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function searchesFor(query: string): SearchHit[] {
  return searches.filter((s) => s.q === query);
}

const EXPECTED_TOOLS = { ok: true, tools: ['fetch_url', 'search_web', 'list_cached'] };

beforeAll(async () => {
  process.env.MCP_DOCS_TOKEN = TOKEN;
  prepareSidecar();
  await startFakeSearxng();
  sidecarPort = await freePort();
  settings.url = `http://127.0.0.1:${sidecarPort}/mcp`;
  // Short idle TTL so scenario (a) exercises the real reaper within seconds.
  await startSidecar({ MCP_DOCS_SESSION_TTL_MS: '1500' });
}, 240_000);

afterAll(async () => {
  // Point the cached client elsewhere so its transport (and SSE reconnect
  // timers) are closed before the worker exits.
  settings.url = 'http://127.0.0.1:1/mcp';
  await testConnection();
  await stopSidecar();
  if (fake?.listening) {
    const { promise, resolve: closed } = Promise.withResolvers<void>();
    fake.close(() => closed());
    await promise;
  }
  if (sidecarDir) rmSync(sidecarDir, { recursive: true, force: true });
  delete process.env.MCP_DOCS_TOKEN;
});

describe('MCP client against the real mcp-docs sidecar + fake SearXNG (#1766, epic #1903)', () => {
  it('baseline: /test lists the tools and a web search reaches the fake SearXNG exactly once', async () => {
    const q1 = `session recovery baseline ${randomUUID()}`;

    await expect(testConnection()).resolves.toEqual(EXPECTED_TOOLS);
    const results = await searchDocumentation(q1, 'user-1', 3);

    expect(results).toEqual([1, 2, 3].map((n) => ({
      title: `Doc ${n}`, url: `${fakeUrl}/doc/${n}`, snippet: `snippet ${n}`,
    })));
    expect(searchesFor(q1)).toEqual([{ q: q1, format: 'json', categories: 'general' }]);
    expect((await health()).sessions).toBe(1);
  });

  it('(a) after idle-session eviction the next web search and the next /test succeed; one outbound request', async () => {
    await waitFor(async () => (await health()).sessions === 0, 15_000, 'idle eviction of the backend session');
    const q2 = `session recovery after eviction ${randomUUID()}`;

    const { sources } = await fetchWebSources(q2, 'user-1', { maxResults: 3 });

    expect(sources).toEqual([
      { url: `${fakeUrl}/doc/1`, title: 'Doc 1', snippet: 'snippet 1' },
      { url: `${fakeUrl}/doc/2`, title: 'Doc 2', snippet: 'snippet 2' },
    ]);
    expect(searchesFor(q2)).toHaveLength(1);
    // fetch_url is SSRF-blocked for loopback, so the helper fell back to snippets without any page fetch.
    expect(docHits).toBe(0);
    await expect(testConnection()).resolves.toEqual(EXPECTED_TOOLS);
    expect((await health()).sessions).toBe(1);
  }, 60_000);

  it('(b) after a sidecar restart the next /test and the next web search succeed; one outbound request', async () => {
    await stopSidecar();
    await startSidecar(); // default 30-minute TTL: only the restart can invalidate the session
    expect((await health()).sessions).toBe(0);
    const q3 = `session recovery after restart ${randomUUID()}`;

    await expect(testConnection()).resolves.toEqual(EXPECTED_TOOLS);
    const results = await searchDocumentation(q3, 'user-1', 3);

    expect(results).toHaveLength(3);
    expect(searchesFor(q3)).toHaveLength(1);
    expect((await health()).sessions).toBe(1);
  }, 60_000);

  it('never retries a SearXNG-unavailable tool error: exactly one outbound request, session kept', async () => {
    fakeMode = 'unavailable';
    const q4 = `session recovery searxng down ${randomUUID()}`;
    try {
      await expect(searchDocumentation(q4, 'user-1', 3)).rejects.toThrow('search backend unavailable: SearXNG returned 503');
    } finally {
      fakeMode = 'ok';
    }

    expect(searchesFor(q4)).toHaveLength(1);
    await expect(testConnection()).resolves.toEqual(EXPECTED_TOOLS);
    expect((await health()).sessions).toBe(1);
  });
});
