import { describe, it, expect } from 'vitest';
import {
  SETTINGS_NAV,
  SETTINGS_PANELS,
  canSeeItem,
  firstVisiblePath,
  settingsPanelFromPath,
  type AccessContext,
  type SettingsNavItem,
} from './settings-nav';
import {
  AI_MODELS_SETTINGS_LABEL,
  AI_MODELS_SETTINGS_PATH,
  CONFLUENCE_SETTINGS_PATH,
} from '../../shared/lib/routes';

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
    // shared/lib/routes.ts duplicates this path so shared/ components can
    // link to it without importing features/. Guard the constant against
    // drifting from the nav-derived path.
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

  it('exposes personal Editor preferences to every user', () => {
    const personal = SETTINGS_NAV.find((group) => group.id === 'personal');
    expect(personal?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'editor', label: 'Editor' }),
    ]));
  });

  it('has no duplicate `/settings/<group>/<item>` paths', () => {
    const paths = SETTINGS_NAV.flatMap((g) => g.items.map((i) => `/settings/${g.id}/${i.id}`));
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe('SETTINGS_PANELS', () => {
  // SettingsPanelId and SETTINGS_PANELS are both *derived* from SETTINGS_NAV
  // (const type parameter on navItem() + `as const satisfies`), so these two
  // assertions guard the derivation itself, not a hand-kept mirror.
  it('mirrors the nav item ids exactly', () => {
    const navIds = SETTINGS_NAV.flatMap((g) => g.items.map((i) => i.id)).sort();
    expect(Object.keys(SETTINGS_PANELS).sort()).toEqual(navIds);
  });

  it('derives each path and label from the nav config', () => {
    for (const group of SETTINGS_NAV) {
      for (const item of group.items) {
        const ref = SETTINGS_PANELS[item.id];
        expect(ref.path).toBe(`/settings/${group.id}/${item.id}`);
        expect(ref.label).toBe(item.label);
      }
    }
  });

  // NOTE: the "SettingsPanelId stays a literal union" tripwire lives in
  // settings-nav.ts itself (SettingsPanelIdIsLiteralUnion) — tsconfig.json
  // excludes *.test.ts from `npm run typecheck`, so a type-level probe here
  // would never run.

  // shared/lib/routes.ts mirrors this label so shared/ components can name
  // the panel without importing features/ — same arrangement as
  // CONFLUENCE_SETTINGS_PATH above.
  it('keeps the shared AI Models label constant in sync', () => {
    expect(SETTINGS_PANELS.models.label).toBe(AI_MODELS_SETTINGS_LABEL);
  });

  it('keeps the shared AI Models path constant in sync', () => {
    // ServiceStatus's health-alert CTA links via this constant from shared/.
    expect(SETTINGS_PANELS.models.path).toBe(AI_MODELS_SETTINGS_PATH);
  });
});

describe('settingsPanelFromPath', () => {
  it('resolves a live panel from its URL', () => {
    expect(settingsPanelFromPath('/settings/knowledge/spaces')?.label).toBe('Spaces & Sync');
  });

  it('ignores query strings and unknown segments', () => {
    expect(settingsPanelFromPath('/settings/personal/confluence?tab=x')?.label).toBe('Confluence');
    expect(settingsPanelFromPath('/settings')).toBeUndefined();
    expect(settingsPanelFromPath('/settings/knowledge/not-a-panel')).toBeUndefined();
  });
});
