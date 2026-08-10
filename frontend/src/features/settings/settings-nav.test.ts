import { describe, it, expect } from 'vitest';
import {
  SETTINGS_NAV,
  SETTINGS_PANELS,
  canSeeItem,
  firstVisiblePath,
  type AccessContext,
  type SettingsNavItem,
  type SettingsPanelId,
} from './settings-nav';
import { CONFLUENCE_SETTINGS_PATH } from '../../shared/lib/routes';

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

  it('stays in sync with the shared CONFLUENCE_SETTINGS_PATH constant', () => {
    // shared/lib/routes.ts duplicates this path so shared/ components
    // (ConfluencePatBanner) can link to it without importing features/.
    // Guard the constant against drifting from the nav-derived path.
    expect(firstVisiblePath(ctx())).toBe(CONFLUENCE_SETTINGS_PATH);
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

describe('SETTINGS_PANELS', () => {
  // SETTINGS_PANEL_IDS is a typed mirror of the nav item ids (TS cannot derive
  // the literal union through navItem()); this is the guard that keeps the
  // mirror honest in both directions.
  it('mirrors the nav item ids exactly', () => {
    const navIds = SETTINGS_NAV.flatMap((g) => g.items.map((i) => i.id)).sort();
    expect(Object.keys(SETTINGS_PANELS).sort()).toEqual(navIds);
  });

  it('derives each path and label from the nav config', () => {
    for (const group of SETTINGS_NAV) {
      for (const item of group.items) {
        const ref = SETTINGS_PANELS[item.id as SettingsPanelId];
        expect(ref.path).toBe(`/settings/${group.id}/${item.id}`);
        expect(ref.label).toBe(item.label);
      }
    }
  });
});
