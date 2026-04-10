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
  /**
   * Masked display form of the active license key (no signature).
   * Present on the EE backend; omitted by the CE noop fallback.
   */
  displayKey: z.string().optional(),
  /**
   * Short license ID (e.g. CPQ1a2b3c4d) for support lookups. EE-only.
   */
  licenseId: z.string().nullable().optional(),
  /**
   * Signals that the responding backend accepts license-key writes via
   * PUT/DELETE /api/admin/license. Absent on the CE noop fallback — the
   * frontend reads it to decide whether to render the edit form in
   * LicenseStatusCard.
   */
  canUpdate: z.boolean().optional(),
});

export type LicenseInfoResponse = z.infer<typeof LicenseInfoResponseSchema>;
