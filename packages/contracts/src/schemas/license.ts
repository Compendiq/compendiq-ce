import { z } from 'zod';

/**
 * Shared schema for the license info API response shape.
 *
 * The backend stores LicenseInfo internally with `expiresAt: Date` and
 * `seats: number` (required), but serializes to this schema at the API
 * boundary. The frontend consumes this shape directly.
 */
export const LicenseInfoResponseSchema = z.object({
  edition: z.string(),
  tier: z.string(),
  features: z.array(z.string()),
  expiresAt: z.string().optional(),
  seats: z.number().optional(),
  valid: z.boolean(),
});

export type LicenseInfoResponse = z.infer<typeof LicenseInfoResponseSchema>;
