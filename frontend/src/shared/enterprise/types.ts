import type { ReactNode, ComponentType } from 'react';
import type { LicenseInfoResponse } from '@compendiq/contracts';

// ─── License Types ────────────────────────────────────────────────
// The canonical API response shape is defined in @compendiq/contracts
// (LicenseInfoResponseSchema). This interface extends it with UI-only
// fields that the backend may also include.

export type LicenseTier = 'community' | 'team' | 'business' | 'enterprise';

export interface LicenseInfo extends LicenseInfoResponse {
  tier: LicenseTier;
  isValid?: boolean;
  displayKey?: string;
}

// ─── Enterprise UI Component Contract ──────────────────────────────

/**
 * Contract for the enterprise frontend package (@compendiq/enterprise/frontend).
 * These components are loaded dynamically. If the package is not installed,
 * the community edition renders without them.
 */
export interface EnterpriseUI {
  /** License status card for the admin panel (self-fetching, zero props). */
  LicenseStatusCard: ComponentType;

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
