/**
 * Compendiq MCP Documentation Server
 *
 * Sidecar container that fetches online documentation for air-gapped LLM environments.
 * Exposes tools via MCP Streamable HTTP transport.
 *
 * Security: GET-only outbound, SSRF guard, domain filtering, query sanitization, audit logging.
 */

import { randomUUID } from 'node:crypto';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createClient, type RedisClientType } from 'redis';
import { z } from 'zod';
import { fetchUrl } from './tools/fetch-url.js';
import { searchWeb } from './tools/search-web.js';
import { listCached } from './tools/list-cached.js';
import { logger } from './logger.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_VERSION: string = JSON.parse(
  readFileSync(resolve(__dirname, '../package.json'), 'utf-8'),
).version;

const PORT = parseInt(process.env.PORT ?? '3100', 10);
const HOST = process.env.MCP_DOCS_HOST ?? '127.0.0.1';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const CACHE_TTL = parseInt(process.env.CACHE_TTL_SECONDS ?? '3600', 10);

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
    },
    async ({ url, max_length, start_index, user_id }) => {
      try {
        const result = await fetchUrl(url, redis, {
          maxLength: max_length ?? undefined,
          startIndex: start_index ?? undefined,
          userId: user_id ?? undefined,
          cacheTtl: CACHE_TTL,
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
    },
    async ({ query, num_results, user_id }) => {
      try {
        const results = await searchWeb(query, redis, {
          numResults: num_results ?? undefined,
          userId: user_id ?? undefined,
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

const transports = new Map<string, StreamableHTTPServerTransport>();
const servers = new Map<string, McpServer>();
const sessionLastSeen = new Map<string, number>();

const SESSION_TTL_MS = 30 * 60_000; // 30 minutes idle timeout
const SESSION_REAP_INTERVAL_MS = 5 * 60_000; // Check every 5 minutes

// Evict stale sessions to prevent memory leaks from disconnected clients
setInterval(() => {
  const now = Date.now();
  for (const [id, lastSeen] of sessionLastSeen) {
    if (now - lastSeen > SESSION_TTL_MS) {
      transports.delete(id);
      const server = servers.get(id);
      if (server) {
        server.close().catch(() => {});
        servers.delete(id);
      }
      sessionLastSeen.delete(id);
      logger.debug({ sessionId: id }, 'Evicted stale MCP session');
    }
  }
}, SESSION_REAP_INTERVAL_MS).unref();

const app = express();
app.use(express.json());

// MCP endpoint
app.post('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  try {
    if (sessionId && transports.has(sessionId)) {
      sessionLastSeen.set(sessionId, Date.now());
      const transport = transports.get(sessionId)!;
      await transport.handleRequest(req, res, req.body);
      return;
    }

    if (!sessionId && isInitializeRequest(req.body)) {
      const mcpServer = createMcpServerInstance();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newId: string) => {
          transports.set(newId, transport);
          servers.set(newId, mcpServer);
          sessionLastSeen.set(newId, Date.now());
          logger.debug({ sessionId: newId }, 'MCP session initialized');
        },
      });

      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Invalid or missing session' },
      id: null,
    });
  } catch (err) {
    logger.error({ err }, 'MCP request error');
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

// GET /mcp for SSE streams (required by Streamable HTTP spec)
app.get('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (sessionId && transports.has(sessionId)) {
    sessionLastSeen.set(sessionId, Date.now());
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res);
    return;
  }
  res.status(400).json({ error: 'Invalid or missing session' });
});

// DELETE /mcp for session termination
app.delete('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (sessionId && transports.has(sessionId)) {
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res);
    transports.delete(sessionId);
    sessionLastSeen.delete(sessionId);
    const server = servers.get(sessionId);
    if (server) {
      await server.close();
      servers.delete(sessionId);
    }
    return;
  }
  res.status(400).json({ error: 'Invalid or missing session' });
});

// Health endpoint
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    redis: redis ? 'connected' : 'disconnected',
    sessions: transports.size,
  });
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
