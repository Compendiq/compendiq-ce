import { z } from 'zod';

/**
 * MCP Docs admin settings (`admin_settings.mcp_docs_*`), Settings → Integrations → MCP Docs.
 *
 * The backend sends both values to the mcp-docs sidecar with every `fetch_url`
 * call (#1769): `cacheTtl` as the tool's `cache_ttl` argument
 * (`z.number().int().min(60).max(86400)` in mcp-docs/src/index.ts), and
 * `maxContentLength` as the ceiling on `max_length`, whose range ends at the
 * sidecar's hard cap (`max_length: z.number().max(100_000)` in
 * mcp-docs/src/index.ts, `ABSOLUTE_MAX_LENGTH = 100_000` in
 * mcp-docs/src/tools/fetch-url.ts). The sidecar does not depend on this
 * package, so both sides are pinned with literal tests: schemas/mcp-docs.test.ts
 * (these numbers) and mcp-docs/src/admin-settings.integration.test.ts (the
 * running sidecar's tool schema). Never widen one side alone.
 */
export const MCP_DOCS_CACHE_TTL_MIN = 60;
export const MCP_DOCS_CACHE_TTL_MAX = 86_400;
export const MCP_DOCS_CACHE_TTL_DEFAULT = 3600;
export const MCP_DOCS_MAX_CONTENT_LENGTH_MIN = 1000;
export const MCP_DOCS_MAX_CONTENT_LENGTH_MAX = 100_000;
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
