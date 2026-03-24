/**
 * Audit logger: logs every outbound request for admin review.
 */

import { logger } from '../logger.js';

export interface AuditEntry {
  tool: string;
  url?: string;
  query?: string;
  userId?: string;
  statusCode?: number;
  contentLength?: number;
  cached: boolean;
  timestamp: string;
}

export function logOutboundRequest(entry: AuditEntry): void {
  logger.info({
    audit: true,
    tool: entry.tool,
    url: entry.url,
    query: entry.query,
    userId: entry.userId,
    statusCode: entry.statusCode,
    contentLength: entry.contentLength,
    cached: entry.cached,
  }, `MCP outbound: ${entry.tool} ${entry.url ?? entry.query ?? ''}`);
}
