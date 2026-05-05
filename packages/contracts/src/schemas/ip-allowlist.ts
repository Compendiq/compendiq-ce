import { z } from 'zod';

/**
 * Shared schemas for the IP-allowlist admin API (EE #111).
 *
 * These are consumed by both the backend (request/response validation) and
 * the frontend (form typing). The `contracts` package must stay pure — it
 * cannot import backend-only helpers like `parseCidrSafe`. We therefore
 * enforce only structural shape here (non-empty strings); the route
 * handler performs semantic CIDR / path validation and returns
 * `{ error: 'invalid_cidr', cidr }` / `{ error: 'invalid_exception', path }`
 * on failure.
 */

export const IpAllowlistConfigSchema = z.object({
  enabled: z.boolean(),
  cidrs: z.array(z.string().min(1)),
  trustedProxies: z.array(z.string().min(1)),
  exceptions: z.array(z.string().min(1)),
});

export type IpAllowlistConfig = z.infer<typeof IpAllowlistConfigSchema>;

export const IpAllowlistTestRequestSchema = z.object({
  ip: z.string().min(1),
});

export type IpAllowlistTestRequest = z.infer<typeof IpAllowlistTestRequestSchema>;

export const IpAllowlistTestResponseSchema = z.object({
  allowed: z.boolean(),
  matchedCidr: z.string().nullable(),
  isTrustedProxy: z.boolean(),
  reason: z.string(),
});

export type IpAllowlistTestResponse = z.infer<typeof IpAllowlistTestResponseSchema>;
