import { z } from 'zod';

/**
 * Shared schema for the public OIDC config endpoint
 * (`GET /api/auth/oidc/config`).
 *
 * Served by the EE backend when the OIDC_SSO feature is licensed, and by a
 * community-mode fallback in CE that always reports `enabled: false`. The
 * shared CE login page consumes this to decide whether to render the SSO
 * sign-in button.
 */
export const OidcConfigSchema = z.object({
  /** Whether OIDC SSO is configured and available for interactive login. */
  enabled: z.boolean(),
  /** Issuer URL of the configured identity provider, or null when not configured. */
  issuer: z.string().nullable(),
  /** Display name for the SSO button (e.g. "OrgSSO"); null falls back to "SSO". */
  name: z.string().nullable(),
  /**
   * True when SSO requires an enterprise license that the responding backend
   * does not have. CE reports this so the login page keeps the button hidden
   * even if some other signal were to flip `enabled`.
   */
  enterpriseRequired: z.boolean(),
});

export type OidcConfig = z.infer<typeof OidcConfigSchema>;
