/**
 * Compendiq MCP Documentation Server
 *
 * Sidecar container that fetches online documentation for air-gapped LLM environments.
 * Exposes tools via MCP Streamable HTTP transport.
 *
 * Security: GET-only outbound, SSRF guard, domain filtering, query sanitization, audit logging.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createClient, type RedisClientType } from 'redis';
import { z } from 'zod';
import { fetchUrl } from './tools/fetch-url.js';
import { searchWeb } from './tools/search-web.js';
import { listCached } from './tools/list-cached.js';
import { logger } from './logger.js';
import { makeMcpAuth } from './auth.js';
import { createMcpApp } from './app.js';
import { parsePort, parseCacheTtl, parseSessionTtlMs } from './config.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_VERSION: string = JSON.parse(
  readFileSync(resolve(__dirname, '../package.json'), 'utf-8'),
).version;

// A malformed PORT (e.g. empty-but-set, or non-numeric) parses to NaN;
// app.listen(NaN) would silently bind a random ephemeral port instead of
// failing. Fail fast. (Narrow null -> number for use inside start()'s closure.)
const parsedPort = parsePort(process.env.PORT);
if (parsedPort === null) {
  logger.fatal({ port: process.env.PORT }, 'Invalid PORT — must be an integer in 1..65535');
  process.exit(1);
}
const PORT: number = parsedPort;

const HOST = process.env.MCP_DOCS_HOST ?? '127.0.0.1';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
// Optional shared secret; when set, /mcp requires it in the x-mcp-docs-token header.
const MCP_DOCS_TOKEN = process.env.MCP_DOCS_TOKEN;
// CACHE_TTL is non-fatal: falls back to the default when unset/malformed.
const CACHE_TTL = parseCacheTtl(process.env.CACHE_TTL_SECONDS);
// Idle-session eviction; non-fatal like CACHE_TTL (default 30 minutes).
const SESSION_TTL_MS = parseSessionTtlMs(process.env.MCP_DOCS_SESSION_TTL_MS);

// ── Redis connection ────────────────────────────────────────────────────

let redis: RedisClientType | null = null;

async function connectRedis(): Promise<void> {
  try {
    redis = createClient({ url: REDIS_URL }) as RedisClientType;
    redis.on('error', (err) => logger.error({ err }, 'Redis connection error'));
    await redis.connect();
    logger.info('Redis connected');
  } catch (err) {
    logger.warn({ err }, 'Redis not available — running without cache');
    redis = null;
  }
}

// ── MCP Server factory ─────────────────────────────────────────────────

function createMcpServerInstance(): McpServer {
  const server = new McpServer(
    { name: 'compendiq-mcp-docs', version: APP_VERSION },
    { capabilities: { tools: { listChanged: true } } },
  );

  // Tool: fetch_url
  server.tool(
    'fetch_url',
    'Fetch a URL and return its content as Markdown. GET-only, no data sent outbound.',
    {
      url: z.string().url().describe('The URL to fetch (http/https only)'),
      max_length: z.number().max(100_000).default(10_000).optional().describe('Max characters to return'),
      start_index: z.number().min(0).default(0).optional().describe('Character offset to start from'),
      user_id: z.string().optional().describe('User ID for audit logging'),
      cache_ttl: z.number().int().min(60).max(86400).optional()
        .describe('Seconds to cache the fetched document (default: CACHE_TTL_SECONDS)'),
    },
    async ({ url, max_length, start_index, user_id, cache_ttl }) => {
      try {
        const result = await fetchUrl(url, redis, {
          maxLength: max_length ?? undefined,
          startIndex: start_index ?? undefined,
          userId: user_id ?? undefined,
          cacheTtl: cache_ttl ?? CACHE_TTL,
        });

        const meta = [
          `Title: ${result.title}`,
          `URL: ${result.url}`,
          `Content length: ${result.contentLength} chars`,
          `Cached: ${result.cached}`,
          result.truncated ? `Truncated: true (use start_index to read more)` : '',
        ].filter(Boolean).join('\n');

        return {
          content: [
            { type: 'text' as const, text: `${meta}\n\n---\n\n${result.markdown}` },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return {
          content: [{ type: 'text' as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );

  // Tool: search_web
  server.tool(
    'search_web',
    'Search the web for documentation. Short keyword queries only (max 200 chars).',
    {
      query: z.string().min(1).max(200).describe('Search query (keywords only, max 200 chars)'),
      num_results: z.number().min(1).max(10).default(5).optional().describe('Number of results'),
      user_id: z.string().optional().describe('User ID for audit logging'),
      categories: z.string().regex(/^[a-z0-9_]+(,[a-z0-9_]+)*$/).max(200).optional()
        .describe('Comma-separated SearXNG categories, e.g. "general,it" (default: general)'),
    },
    async ({ query, num_results, user_id, categories }) => {
      try {
        const results = await searchWeb(query, redis, {
          numResults: num_results ?? undefined,
          userId: user_id ?? undefined,
          categories: categories ?? undefined,
        });

        if (results.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'No results found. SearXNG may not be available.' }],
          };
        }

        const text = results.map((r, i) =>
          `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`
        ).join('\n\n');

        return {
          content: [{ type: 'text' as const, text: text }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return {
          content: [{ type: 'text' as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );

  // Tool: list_cached
  server.tool(
    'list_cached',
    'List previously fetched and cached documentation.',
    {
      filter: z.string().optional().describe('Filter by URL or title substring'),
    },
    async ({ filter }) => {
      const docs = await listCached(redis, filter ?? undefined);

      if (docs.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No cached documents found.' }],
        };
      }

      const text = docs.map((d) =>
        `- **${d.title}** (${d.contentLength} chars)\n  ${d.url}\n  Cached: ${d.fetchedAt}`
      ).join('\n\n');

      return {
        content: [{ type: 'text' as const, text: text }],
      };
    },
  );

  return server;
}

// ── Express + Streamable HTTP transport ─────────────────────────────────

// The /mcp guard fails closed in production: no MCP_DOCS_TOKEN → every /mcp
// request gets 401 (the container still boots and /health stays up).
const { app } = createMcpApp({
  mcpAuth: makeMcpAuth(MCP_DOCS_TOKEN, process.env.NODE_ENV === 'production'),
  createMcpServer: createMcpServerInstance,
  redisStatus: () => (redis ? 'connected' : 'disconnected'),
  sessionTtlMs: SESSION_TTL_MS,
});

// ── Start ───────────────────────────────────────────────────────────────

async function start() {
  await connectRedis();

  app.listen(PORT, HOST, () => {
    logger.info({ port: PORT, host: HOST }, 'Compendiq MCP Docs server started');
  });
}

start().catch((err) => {
  logger.fatal({ err }, 'Failed to start MCP Docs server');
  process.exit(1);
});
