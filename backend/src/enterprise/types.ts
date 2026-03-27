export type LicenseTier = 'community' | 'team' | 'business' | 'enterprise';

export interface LicenseInfo {
  tier: LicenseTier;
  seats: number;
  expiry: Date;
  isValid: boolean;
  isExpired: boolean;
  raw: string | null;
}

export interface LicenseStatusResponse {
  tier: LicenseTier;
  seats: number;
  expiry: string | null;
  features: string[];
  isValid: boolean;
}

/** Features gated by tier */
export const ENTERPRISE_FEATURES: Record<Exclude<LicenseTier, 'community'>, string[]> = {
  team: ['oidc'],
  business: ['oidc', 'audit-export', 'custom-branding'],
  enterprise: ['oidc', 'audit-export', 'custom-branding', 'multi-instance', 'priority-support'],
};
