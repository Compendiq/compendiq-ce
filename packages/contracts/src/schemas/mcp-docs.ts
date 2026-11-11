import { z } from 'zod';

/**
 * MCP Docs admin settings (`admin_settings.mcp_docs_*`), Settings → Integrations → MCP Docs.
 */
export const MCP_DOCS_CACHE_TTL_MIN = 60;
export const MCP_DOCS_CACHE_TTL_MAX = 86_400;
export const MCP_DOCS_CACHE_TTL_DEFAULT = 3600;
export const MCP_DOCS_MAX_CONTENT_LENGTH_MIN = 1000;
export const MCP_DOCS_MAX_CONTENT_LENGTH_MAX = 500_000;
export const MCP_DOCS_MAX_CONTENT_LENGTH_DEFAULT = 50_000;

/** PUT /api/admin/mcp-docs — every field optional; an absent field is left unchanged. */
export const UpdateMcpDocsSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  url: z.string().url().optional(),
  domainMode: z.enum(['allowlist', 'blocklist']).optional(),
  allowedDomains: z.array(z.string()).optional(),
  blockedDomains: z.array(z.string()).optional(),
  cacheTtl: z.number().int().min(MCP_DOCS_CACHE_TTL_MIN).max(MCP_DOCS_CACHE_TTL_MAX).optional(),
  maxContentLength: z
    .number()
    .int()
    .min(MCP_DOCS_MAX_CONTENT_LENGTH_MIN)
    .max(MCP_DOCS_MAX_CONTENT_LENGTH_MAX)
    .optional(),
});
export type UpdateMcpDocsSettingsInput = z.infer<typeof UpdateMcpDocsSettingsSchema>;
