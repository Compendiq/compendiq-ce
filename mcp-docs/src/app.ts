/**
 * Express app for the MCP docs sidecar: the Streamable HTTP `/mcp` endpoint
 * (one SDK transport + McpServer per session, idle eviction) and `/health`.
 *
 * Free of process-level concerns (env parsing, Redis, listen) so tests can boot
 * it in-process on an ephemeral port; `index.ts` wires the real dependencies.
 */

import { randomUUID } from 'node:crypto';
import express, { type RequestHandler } from 'express';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { logger } from './logger.js';

export interface McpAppOptions {
  /** Shared-secret guard for `/mcp` (see `makeMcpAuth`); runs before the JSON body parser. */
  mcpAuth: RequestHandler;
  /** Per-session MCP server factory. */
  createMcpServer: () => McpServer;
  /** Redis state reported by `/health`. */
  redisStatus: () => 'connected' | 'disconnected';
  /** Idle time after which a session is evicted. */
  sessionTtlMs: number;
}

export interface McpApp {
  app: express.Express;
  sessionCount(): number;
  /** Stop the reaper and close every live session (tests only). */
  close(): Promise<void>;
}

/** Reaper cadence; shortened to the TTL itself when the TTL is smaller. */
export const SESSION_REAP_INTERVAL_MS = 5 * 60_000;

export function createMcpApp(options: McpAppOptions): McpApp {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const servers = new Map<string, McpServer>();
  const sessionLastSeen = new Map<string, number>();

  // Evict stale sessions to prevent memory leaks from disconnected clients
  const reaper = setInterval(() => {
    const now = Date.now();
    for (const [id, lastSeen] of sessionLastSeen) {
      if (now - lastSeen > options.sessionTtlMs) {
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
  }, Math.min(SESSION_REAP_INTERVAL_MS, options.sessionTtlMs));
  reaper.unref();

  const app = express();
  // Don't advertise the framework/version to callers.
  app.disable('x-powered-by');

  // Shared-secret guard on /mcp (all methods) — registered BEFORE express.json so
  // an unauthenticated request's body is never parsed. /health below stays open.
  app.use('/mcp', options.mcpAuth);
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
        const mcpServer = options.createMcpServer();
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
      redis: options.redisStatus(),
      sessions: transports.size,
    });
  });

  return {
    app,
    sessionCount: () => transports.size,
    async close() {
      clearInterval(reaper);
      for (const [id, server] of servers) {
        await server.close().catch(() => {});
        servers.delete(id);
        transports.delete(id);
        sessionLastSeen.delete(id);
      }
    },
  };
}
