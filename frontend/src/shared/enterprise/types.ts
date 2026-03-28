import type { ReactNode, ComponentType } from 'react';

// ─── License Types (mirrors backend types.ts) ─────────────────────

export type LicenseTier = 'community' | 'team' | 'business' | 'enterprise';

export interface LicenseInfo {
  edition: string;
  tier: LicenseTier;
  seats?: number;
  expiresAt?: string;
  isValid?: boolean;
  displayKey?: string;
  features: string[];
}

// ─── Enterprise UI Component Contract ──────────────────────────────

/**
 * Contract for the enterprise frontend package (@atlasmind/enterprise/frontend).
 * These components are loaded dynamically. If the package is not installed,
 * the community edition renders without them.
 */
export interface EnterpriseUI {
  /** License status card for the admin panel. */
  LicenseStatusCard: ComponentType<{ license: LicenseInfo | null }>;

  /** Banner shown when an enterprise feature is required. */
  EnterpriseBanner: ComponentType<{ feature: string }>;

  /**
   * Gate component: renders children only if feature is licensed.
   * If not licensed, renders the optional fallback (or nothing).
   */
  EnterpriseGate: ComponentType<{
    feature: string;
    fallback?: ReactNode;
    children: ReactNode;
  }>;

  /** Version of the enterprise frontend package. */
  version: string;
}

// ─── Enterprise Context Value ──────────────────────────────────────

export interface EnterpriseContextValue {
  /** null = community mode, object = enterprise UI loaded */
  ui: EnterpriseUI | null;
  /** License info from the backend */
  license: LicenseInfo | null;
  /** Whether the enterprise plugin is available (even if license is invalid) */
  isEnterprise: boolean;
  /** Whether a specific feature is enabled */
  hasFeature: (feature: string) => boolean;
  /** Loading state */
  isLoading: boolean;
}
