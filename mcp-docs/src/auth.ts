/**
 * Shared-secret auth for the /mcp endpoints.
 *
 * The sidecar's primary control is Docker network isolation (only the backend
 * can reach it). This adds defense-in-depth: when MCP_DOCS_TOKEN is set, every
 * /mcp request must present it in the `x-mcp-docs-token` header. /health stays
 * open for container probes. When the token is unset the middleware is a
 * pass-through, so existing deployments keep working unchanged.
 */

import { timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { logger } from './logger.js';

export const MCP_AUTH_HEADER = 'x-mcp-docs-token';

function constantTimeEqual(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    // Keep timing roughly constant on a length mismatch, then fail.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Build the Express middleware guarding /mcp. A falsy `token` yields a
 * pass-through middleware (logs a one-time warning).
 */
export function makeMcpAuth(token: string | undefined) {
  let warned = false;
  return function mcpAuth(req: Request, res: Response, next: NextFunction): void {
    if (!token) {
      if (!warned) {
        logger.warn('MCP_DOCS_TOKEN not set — /mcp is unauthenticated (relying on network isolation)');
        warned = true;
      }
      next();
      return;
    }
    const presented = (req.headers[MCP_AUTH_HEADER] as string | undefined) ?? '';
    if (presented && constantTimeEqual(presented, token)) {
      next();
      return;
    }
    res.status(401).json({ error: 'Unauthorized' });
  };
}
