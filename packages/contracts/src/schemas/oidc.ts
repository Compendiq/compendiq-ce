import { z } from 'zod';

/**
 * Shared schema for the public OIDC config endpoint
 * (`GET /api/auth/oidc/config`).
 *
 * Served by the EE backend when the OIDC_SSO feature is licensed, and by a
 * community-mode fallback in CE that always reports `enabled: false`. The
 * shared CE login page consumes this to decide whether to render the SSO
 * sign-in button.
 *
 * Resilience: only `enabled` is required. The remaining fields are optional
 * so a minor shape drift from the EE endpoint (e.g. an omitted key) fails
 * *open* — the login page still shows the button when `enabled` is true —
 * rather than throwing in `.parse()` and silently hiding a working SSO
 * button.
 */
export const OidcConfigSchema = z.object({
  /** Whether OIDC SSO is configured and available for interactive login. */
  enabled: z.boolean(),
  /** Issuer URL of the configured identity provider; null/absent when not configured. */
  issuer: z.string().nullish(),
  /** Display name for the SSO button (e.g. "OrgSSO"); null/absent falls back to "SSO". */
  name: z.string().nullish(),
  /**
   * True when SSO requires an enterprise license that the responding backend
   * does not have. CE reports this so the login page keeps the button hidden
   * even if some other signal were to flip `enabled`. Defaults to false when
   * absent (an EE backend that omits it is licensed, so SSO is allowed).
   */
  enterpriseRequired: z.boolean().default(false),
});

export type OidcConfig = z.infer<typeof OidcConfigSchema>;
