import { describe, it, expect } from 'vitest';
import {
  SETTINGS_NAV,
  canSeeItem,
  firstVisiblePath,
  type AccessContext,
  type SettingsNavItem,
} from './settings-nav';

function ctx(partial: Partial<AccessContext> = {}): AccessContext {
  return {
    isAdmin: false,
    isEnterprise: false,
    hasFeature: () => false,
    ...partial,
  };
}

describe('canSeeItem', () => {
  const vanillaItem: SettingsNavItem = { id: 'confluence', label: 'Profile' };
  const adminItem: SettingsNavItem = { id: 'labels', label: 'Labels', adminOnly: true };
  const enterpriseItem: SettingsNavItem = {
    id: 'compliance',
    label: 'Data & Compliance',
    adminOnly: true,
    enterpriseOnly: true,
  };
  const featureGatedItem: SettingsNavItem = {
    id: 'compliance',
    label: 'Data & Compliance',
    adminOnly: true,
    enterpriseOnly: true,
    requiresFeature: 'data_retention_policies',
  };

  it('returns true for a vanilla item with a default-user context', () => {
    expect(canSeeItem(vanillaItem, ctx())).toBe(true);
  });

  it('returns false for adminOnly when isAdmin is false', () => {
    expect(canSeeItem(adminItem, ctx({ isAdmin: false }))).toBe(false);
  });

  it('returns true for adminOnly when isAdmin is true', () => {
    expect(canSeeItem(adminItem, ctx({ isAdmin: true }))).toBe(true);
  });

  it('returns false for an enterprise-gated item in CE mode', () => {
    expect(
      canSeeItem(enterpriseItem, ctx({ isAdmin: true, isEnterprise: false })),
    ).toBe(false);
  });

  it('returns true for an enterprise wrapper when EE is on (no extra feature flag needed)', () => {
    expect(
      canSeeItem(enterpriseItem, ctx({ isAdmin: true, isEnterprise: true })),
    ).toBe(true);
  });

  it('honours requiresFeature on top of enterpriseOnly', () => {
    expect(
      canSeeItem(featureGatedItem, ctx({ isAdmin: true, isEnterprise: true, hasFeature: () => false })),
    ).toBe(false);
    expect(
      canSeeItem(featureGatedItem, ctx({ isAdmin: true, isEnterprise: true, hasFeature: () => true })),
    ).toBe(true);
  });
});

describe('firstVisiblePath', () => {
  it('returns /settings/personal/confluence for a vanilla user (first item in first group)', () => {
    expect(firstVisiblePath(ctx())).toBe('/settings/personal/confluence');
  });
});

describe('SETTINGS_NAV shape', () => {
  it('exposes exactly five groups in the expected order', () => {
    expect(SETTINGS_NAV.map((g) => g.id)).toEqual([
      'personal',
      'knowledge',
      'ai',
      'governance',
      'system',
    ]);
  });

  it('has no duplicate `/settings/<group>/<item>` paths', () => {
    const paths = SETTINGS_NAV.flatMap((g) => g.items.map((i) => `/settings/${g.id}/${i.id}`));
    expect(new Set(paths).size).toBe(paths.length);
  });
});
