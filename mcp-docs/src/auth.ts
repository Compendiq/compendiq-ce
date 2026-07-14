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
 * Build the Express middleware guarding /mcp.
 *
 * When `token` is set, every /mcp request must present it in the
 * `x-mcp-docs-token` header (constant-time compare).
 *
 * When `token` is unset the behaviour depends on `isProduction`:
 *   - production → fail closed: log a one-time error and reject every /mcp
 *     request with 401. A production sidecar with no token is a
 *     misconfiguration, not a licence to run unauthenticated.
 *   - non-production → pass through (logs a one-time warning) so local dev
 *     keeps working without a token.
 */
export function makeMcpAuth(token: string | undefined, isProduction = false) {
  let warned = false;
  return function mcpAuth(req: Request, res: Response, next: NextFunction): void {
    if (!token) {
      if (isProduction) {
        if (!warned) {
          logger.error('MCP_DOCS_TOKEN is required in production — rejecting all /mcp requests with 401 until it is set');
          warned = true;
        }
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
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
