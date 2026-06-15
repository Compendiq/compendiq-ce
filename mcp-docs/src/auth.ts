/**
 * Shared-secret auth for the /mcp endpoints.
 *
 * The sidecar's primary control is Docker network isolation (only the backend
 * can reach it). This adds defense-in-depth: when MCP_DOCS_TOKEN is set, every
 * /mcp request must present it in the `x-mcp-docs-token` header. /health stays
 * open for container probes. When the token is unset the middleware is a
 * pass-through, so existing deployments keep working unchanged.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { logger } from './logger.js';

export const MCP_AUTH_HEADER = 'x-mcp-docs-token';

function constantTimeEqual(presented: string, expected: string): boolean {
  // Compare fixed-length SHA-256 digests: neither the comparison time nor an
  // early length-mismatch branch can leak anything about the expected token.
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
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
